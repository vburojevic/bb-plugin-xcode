/**
 * Folding BB's background-command exits into the builds they launched.
 *
 * This is the only verdict source for agent-launched shell and XcodeBuildMCP
 * builds, which never write an `.xcresult` of their own. The parsing lives in
 * `thread-outcome.ts`; this owns the paging, the cursor and the idempotence
 * ledger around it.
 */

import type { Engine } from "./engine";
import {
  backgroundCommandOutcomes,
  unresolvedCommandStarts,
  type ThreadEventLike,
} from "./thread-outcome";

/** Events fetched per request. The API pages forward only. */
const PAGE_SIZE = 1000;

/**
 * Pages per reconciliation.
 *
 * With a cursor this bounds catching up, not steady state: a caught-up thread
 * reads one short page. Twenty keeps a malformed or unbounded history from
 * becoming plugin work forever.
 */
const MAX_PAGES = 20;

/**
 * How far back the cursor may be held by a launcher that never reported.
 *
 * A `commandExecution` start is only useful until its background task
 * completes — but most commands are not background tasks and never complete
 * as one, so "resume from the oldest unresolved start" alone would pin the
 * cursor at the thread's first shell command forever. Six hours is far longer
 * than any build and short enough that the replay window stays a window.
 */
export const REPLAY_WINDOW_MS = 6 * 3_600_000;

/** Task ids remembered, so a fold is never applied twice. */
const MAX_REMEMBERED_TASKS = 2000;

/** Threads whose cursor is retained. */
const MAX_REMEMBERED_CURSORS = 500;

export interface ThreadSyncDeps {
  engine: Engine;
  listEvents(args: {
    threadId: string;
    afterSeq?: string;
    limit: string;
  }): Promise<unknown[]>;
  kvGet<T>(key: string): Promise<T | undefined>;
  kvSet(key: string, value: unknown): Promise<void>;
  log(message: string): void;
  isDisposed(): boolean;
  onChanged(): void;
  now?(): number;
}

/**
 * Per-thread cursors and the processed-task ledger.
 *
 * The cursor is the point of this class. `thread:changed` fires on every
 * background-activity transition in every thread, and each fire used to re-read
 * that thread's ENTIRE history from sequence zero — up to twenty SDK
 * round-trips of a thousand events each, to find the handful of task
 * completions that had not been folded yet. A long agent thread paid that over
 * and over for the life of the session.
 *
 * What makes advancing safe is knowing where a resumed read stops being able
 * to interpret itself. A background task's exit is meaningless without the
 * `commandExecution` that launched it, so the cursor parks just before the
 * oldest launcher still awaiting its exit — and no further back than
 * `REPLAY_WINDOW_MS`, because most launchers are ordinary foreground commands
 * that never report at all.
 */
export class ThreadSync {
  private readonly inFlight = new Set<string>();
  private readonly cursors = new Map<string, string>();
  private processedTasks = new Set<string>();
  private loaded = false;

  constructor(private readonly deps: ThreadSyncDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    this.processedTasks = new Set(
      (await this.deps.kvGet<string[]>("processed-thread-tasks")) ?? [],
    );
    for (const [threadId, seq] of Object.entries(
      (await this.deps.kvGet<Record<string, string>>("thread-cursors")) ?? {},
    )) {
      this.cursors.set(threadId, seq);
    }
  }

  private async persistTasks(): Promise<void> {
    const retained = [...this.processedTasks].slice(-MAX_REMEMBERED_TASKS);
    if (retained.length !== this.processedTasks.size) {
      this.processedTasks = new Set(retained);
    }
    await this.deps.kvSet("processed-thread-tasks", retained);
  }

  private async persistCursors(): Promise<void> {
    // Bounded the same way the task ledger is: a machine accumulates threads
    // forever, and this is one KV value.
    const entries = [...this.cursors.entries()].slice(-MAX_REMEMBERED_CURSORS);
    this.cursors.clear();
    for (const [threadId, seq] of entries) this.cursors.set(threadId, seq);
    await this.deps.kvSet("thread-cursors", Object.fromEntries(entries));
  }

  /**
   * Fold every unprocessed background-command exit in one thread.
   *
   * Re-entrant per thread: a burst of events collapses to one pass, and the
   * pass always resumes from the persisted cursor.
   */
  async reconcile(threadId: string): Promise<void> {
    if (this.deps.isDisposed() || this.inFlight.has(threadId)) return;
    this.inFlight.add(threadId);
    try {
      await this.load();
      if (this.deps.isDisposed()) return;

      const rows: ThreadEventLike[] = [];
      let afterSeq = this.cursors.get(threadId);
      let lastSeq: number | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const batch = (await this.deps.listEvents({
          threadId,
          ...(afterSeq ? { afterSeq } : {}),
          limit: String(PAGE_SIZE),
        })) as ThreadEventLike[];
        // A reload can land between pages; the next SDK call and the engine/kv
        // writes below would then touch a stale handle.
        if (this.deps.isDisposed()) return;
        rows.push(...batch);
        if (batch.length > 0) {
          lastSeq = batch[batch.length - 1]!.seq;
          afterSeq = String(lastSeq);
        }
        if (batch.length < PAGE_SIZE) break;
      }

      let changed = false;
      let processed = false;
      for (const outcome of backgroundCommandOutcomes(rows)) {
        if (this.processedTasks.has(outcome.taskId)) continue;
        if (
          this.deps.engine.foldThreadCommandExit(
            { ...outcome, threadId },
            this.now(),
          )
        ) {
          this.processedTasks.add(outcome.taskId);
          changed = true;
          processed = true;
          this.deps.log(`thread task verdict consumed: ${outcome.taskId}`);
        }
      }

      if (this.deps.isDisposed()) return;
      if (lastSeq !== null) {
        this.cursors.set(threadId, String(this.nextCursor(rows, lastSeq)));
        await this.persistCursors();
      }
      if (processed) await this.persistTasks();
      if (changed) this.deps.onChanged();
    } catch (error: unknown) {
      this.deps.log(
        `thread task reconciliation failed (${threadId}): ${String(error)}`,
      );
    } finally {
      this.inFlight.delete(threadId);
    }
  }

  /**
   * Where the next read may safely resume: just before the oldest launcher
   * still awaiting its exit, within the replay window.
   */
  private nextCursor(rows: readonly ThreadEventLike[], lastSeq: number): number {
    const horizon = this.now() - REPLAY_WINDOW_MS;
    const oldest = unresolvedCommandStarts(rows).find(
      (start) => start.startedAt >= horizon,
    );
    if (!oldest) return lastSeq;
    // `afterSeq` is exclusive, so stepping one back re-reads the launcher
    // itself on the next pass.
    return Math.max(0, Math.min(lastSeq, oldest.seq - 1));
  }

  /** Drop a thread's cursor so the next reconcile re-reads it in full. */
  forget(threadId: string): void {
    this.cursors.delete(threadId);
  }
}
