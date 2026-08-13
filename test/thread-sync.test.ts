/**
 * Paging forward through a thread's history without losing a verdict.
 *
 * The cursor is the whole point of `ThreadSync`, and the failure it must not
 * have is silent: resume too far forward and a background task's exit arrives
 * with its launching command already behind the cursor, so the outcome parser
 * cannot interpret it and the build never gets its verdict. Nothing errors;
 * the run just sits at `ended` forever.
 */

import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { Engine } from "../src/engine";
import { RANK, type Run } from "../src/model";
import { MIGRATIONS, Store, type Db } from "../src/store";
import { REPLAY_WINDOW_MS, ThreadSync } from "../src/thread-sync";
import type { ThreadEventLike } from "../src/thread-outcome";

const NOW = 1_700_000_000_000;
const THREAD = "thr_build";

function makeStore(): Store {
  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  return new Store(db);
}

function buildRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "r:1:1",
    status: "ended",
    statusRank: RANK.observed,
    kind: "build",
    scheme: "App",
    container: null,
    configuration: null,
    destination: null,
    projectId: null,
    root: null,
    cwd: "/w/App",
    pid: 1,
    cmdline: null,
    startedAt: NOW,
    endedAt: NOW + 30_000,
    errorCount: 0,
    warningCount: 0,
    analyzerCount: 0,
    testTotal: null,
    testFailed: null,
    testSkipped: null,
    bundlePath: null,
    detailed: false,
    branch: null,
    worktree: null,
    threadId: THREAD,
    ...overrides,
  };
}

function startEvent(seq: number, id: string, at: number): ThreadEventLike {
  return {
    id: `e${seq}`,
    seq,
    createdAt: at,
    type: "item/started",
    data: {
      item: {
        type: "commandExecution",
        id,
        command: "./scripts/build_app.sh build",
        cwd: "",
      },
    },
  };
}

function completedEvent(
  seq: number,
  taskId: string,
  parent: string,
  at: number,
): ThreadEventLike {
  return {
    id: `e${seq}`,
    seq,
    createdAt: at,
    type: "item/backgroundTask/completed",
    data: {
      item: {
        type: "backgroundTask",
        id: taskId,
        parentToolCallId: parent,
        status: "completed",
        summary: "Command finished with exit code 0",
      },
    },
  };
}

/** An unrelated event, so histories have bulk the cursor can skip. */
function noise(seq: number, at: number): ThreadEventLike {
  return {
    id: `e${seq}`,
    seq,
    createdAt: at,
    type: "item/completed",
    data: {},
  };
}

interface Harness {
  store: Store;
  sync: ThreadSync;
  /** Sequence numbers each `listEvents` call started after. */
  reads: Array<string | undefined>;
  kv: Map<string, unknown>;
  setHistory(events: ThreadEventLike[]): void;
}

function harness(now = NOW + 60_000): Harness {
  const store = makeStore();
  const engine = new Engine(store, {
    projectFor: () => null,
    threadFor: () => THREAD,
    log: () => undefined,
  });
  let history: ThreadEventLike[] = [];
  const reads: Array<string | undefined> = [];
  const kv = new Map<string, unknown>();

  const sync = new ThreadSync({
    engine,
    async listEvents({ afterSeq }) {
      reads.push(afterSeq);
      const from = afterSeq === undefined ? -1 : Number(afterSeq);
      return history.filter((event) => event.seq > from);
    },
    async kvGet<T>(key: string): Promise<T | undefined> {
      return kv.get(key) as T | undefined;
    },
    async kvSet(key: string, value: unknown): Promise<void> {
      kv.set(key, value);
    },
    log: () => undefined,
    isDisposed: () => false,
    onChanged: () => undefined,
    now: () => now,
  });

  return {
    store,
    sync,
    reads,
    kv,
    setHistory: (events) => {
      history = events;
    },
  };
}

describe("ThreadSync", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("folds a completed background command into its build", async () => {
    h.store.insertRun(buildRun());
    h.setHistory([
      startEvent(1, "call_1", NOW - 1_000),
      completedEvent(2, "task_1", "call_1", NOW + 40_000),
    ]);

    await h.sync.reconcile(THREAD);
    expect(h.store.getRun("r:1:1")!.status).toBe("passed");
  });

  it("resumes after the last read event once nothing is pending", async () => {
    h.setHistory([noise(1, NOW), noise(2, NOW), noise(3, NOW)]);

    await h.sync.reconcile(THREAD);
    await h.sync.reconcile(THREAD);

    // First pass reads from the beginning; the second resumes rather than
    // re-reading the whole history, which is the entire point.
    expect(h.reads).toEqual([undefined, "3"]);
  });

  /**
   * The regression this class exists to avoid. A launcher whose exit has not
   * arrived yet must still be readable on the next pass, or its verdict is
   * lost the moment the two events fall on opposite sides of a cursor.
   */
  it("does not advance past a launcher still awaiting its exit", async () => {
    h.store.insertRun(buildRun());
    h.setHistory([
      noise(1, NOW - 5_000),
      startEvent(2, "call_1", NOW - 1_000),
      noise(3, NOW),
    ]);

    await h.sync.reconcile(THREAD);
    expect(h.store.getRun("r:1:1")!.status).toBe("ended");

    // The build finishes and reports, on the far side of where a naive cursor
    // would have resumed.
    h.setHistory([
      noise(1, NOW - 5_000),
      startEvent(2, "call_1", NOW - 1_000),
      noise(3, NOW),
      completedEvent(4, "task_1", "call_1", NOW + 40_000),
    ]);
    await h.sync.reconcile(THREAD);

    // Resumed from just before the launcher, so both halves were in hand.
    expect(h.reads).toEqual([undefined, "1"]);
    expect(h.store.getRun("r:1:1")!.status).toBe("passed");
  });

  it("does not let an ancient unfinished command pin the cursor forever", async () => {
    // Most `commandExecution` items are ordinary foreground commands that
    // never report as background tasks. Without a horizon, the first one would
    // hold the cursor at the start of the thread for the rest of the session.
    h.setHistory([
      startEvent(1, "call_ancient", NOW - REPLAY_WINDOW_MS - 60_000),
      noise(2, NOW),
    ]);

    await h.sync.reconcile(THREAD);
    await h.sync.reconcile(THREAD);

    expect(h.reads).toEqual([undefined, "2"]);
  });

  it("never folds the same task twice", async () => {
    h.store.insertRun(buildRun());
    h.setHistory([
      startEvent(1, "call_1", NOW - 1_000),
      completedEvent(2, "task_1", "call_1", NOW + 40_000),
    ]);

    await h.sync.reconcile(THREAD);
    // A verified verdict lands afterwards; a replay of the same task must not
    // be able to talk over it.
    const run = h.store.getRun("r:1:1")!;
    run.status = "failed";
    run.statusRank = RANK.verified;
    h.store.updateRun(run);

    h.sync.forget(THREAD);
    await h.sync.reconcile(THREAD);
    expect(h.store.getRun("r:1:1")!.status).toBe("failed");
  });

  it("persists the cursor and the processed tasks", async () => {
    h.store.insertRun(buildRun());
    h.setHistory([
      startEvent(1, "call_1", NOW - 1_000),
      completedEvent(2, "task_1", "call_1", NOW + 40_000),
    ]);

    await h.sync.reconcile(THREAD);

    expect(h.kv.get("thread-cursors")).toEqual({ [THREAD]: "2" });
    expect(h.kv.get("processed-thread-tasks")).toEqual(["task_1"]);
  });
});
