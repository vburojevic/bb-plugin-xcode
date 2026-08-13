/**
 * Resolving which checkout a thread owns, and caching the answer.
 *
 * `ThreadScopes` is the pure registry; this is the part that talks to bb and
 * decides how long an answer is worth trusting.
 */

import type { Store } from "./store";
import { ThreadScopes, type ThreadScope } from "./scopes";

/**
 * How long a resolved scope is trusted before we ask the SDK again, and how
 * long a FAILED resolve is remembered.
 *
 * These have to differ. A brand-new thread is momentarily env-less — the
 * thread row exists before its environment is attached — and the miss was
 * being cached for the full 30s alongside genuine successes. Combined with the
 * old `!scope` filter widening to machine-wide, that gave a fresh thread a
 * half-minute window in which it confidently showed another worktree's build.
 * The filter fix makes that window merely empty instead of wrong; this makes
 * the window short.
 */
export const SCOPE_TTL_MS = 30_000;
export const SCOPE_MISS_TTL_MS = 4_000;

/** How far back a newly resolved scope claims runs it did not see start. */
const BACKFILL_WINDOW_MS = 6 * 3_600_000;

/** Threads whose resolve timestamp is retained before the map is dropped. */
const MAX_TRACKED_THREADS = 1000;

/**
 * Longest an agent tool waits for a cold scope.
 *
 * Unlike the polled `chatStatus` — which can answer scope-less and let the
 * publish-driven refetch fill it in — a tool call is a single question, so
 * waiting a beat for the right scope is worth it. Waiting on a slow SDK
 * round-trip under load is how this plugin ended up on the slow-handler list,
 * so the wait is bounded and the refresh continues detached.
 */
export const SCOPE_BOUNDED_WAIT_MS = 800;

export interface ScopeSyncDeps {
  store: Store;
  getThread(threadId: string): Promise<{ environmentId?: string | null }>;
  getEnvironment(environmentId: string): Promise<{
    path?: string | null;
    projectId?: string | null;
    branchName?: string | null;
  }>;
  log(message: string): void;
  isDisposed(): boolean;
  /** Called when a scope newly resolves, moves, or claims existing runs. */
  onChanged(): void;
  now?(): number;
}

export class ScopeSync {
  readonly scopes = new ThreadScopes();
  private readonly resolvedAt = new Map<string, number>();

  constructor(private readonly deps: ScopeSyncDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  get(threadId: string): ThreadScope | null {
    return this.scopes.get(threadId);
  }

  markActive(threadId: string): void {
    const existing = this.scopes.get(threadId);
    if (existing) this.scopes.upsert({ ...existing, active: true }, this.now());
    this.scopes.prune(this.now());
  }

  deactivate(threadId: string): void {
    this.scopes.deactivate(threadId, this.now());
  }

  remove(threadId: string): void {
    this.scopes.remove(threadId);
    this.resolvedAt.delete(threadId);
  }

  /** Resolve a thread's checkout through bb, honouring the TTLs above. */
  async refresh(threadId: string, active: boolean): Promise<ThreadScope | null> {
    const now = this.now();
    const last = this.resolvedAt.get(threadId) ?? 0;
    const known = this.scopes.get(threadId);
    // Within the throttle window, answer from the registry. A hit is trusted
    // for the full TTL; a miss is retried far sooner, because "no checkout
    // yet" and "no checkout ever" look identical here and only one of them
    // stays true. The long TTL exists so an env-less side chat does not cost
    // two SDK calls per event.
    if (now - last < (known ? SCOPE_TTL_MS : SCOPE_MISS_TTL_MS)) return known;
    if (this.resolvedAt.size > MAX_TRACKED_THREADS) this.resolvedAt.clear();
    this.resolvedAt.set(threadId, now);
    try {
      const thread = await this.deps.getThread(threadId);
      if (this.deps.isDisposed()) return null;
      const environmentId = thread.environmentId ?? null;
      if (!environmentId) return null;
      const env = await this.deps.getEnvironment(environmentId);
      // This runs detached from thread events and bounded-awaited from agent
      // tools; either way a reload can land mid-flight, and the store/publish
      // below belong to the fresh instance then.
      if (this.deps.isDisposed()) return null;
      if (!env.path) return null;

      const before = this.scopes.get(threadId);
      this.scopes.upsert(
        {
          threadId,
          projectId: env.projectId ?? null,
          environmentId,
          path: env.path,
          branch: env.branchName ?? null,
          active,
        },
        this.now(),
      );
      // A build the probe saw before this scope existed: claim it now.
      const backfilled = this.deps.store.attributeRunsToThread(
        threadId,
        env.path,
        this.now() - BACKFILL_WINDOW_MS,
      );
      // The banner reads the thread's runs on every publish, so a late claim
      // surfaces on its own — no prompt, no turn spent, nothing to retry.
      const resolved = this.scopes.get(threadId);
      if (
        backfilled > 0 ||
        !before ||
        before.path !== resolved?.path ||
        before.branch !== (resolved?.branch ?? null)
      ) {
        this.deps.onChanged();
      }
      return resolved;
    } catch (error: unknown) {
      this.deps.log(`thread scope resolve failed (${threadId}): ${String(error)}`);
      return null;
    }
  }

  /** Cached when known, otherwise one bounded refresh. See the constant. */
  async bounded(threadId: string): Promise<ThreadScope | null> {
    const cached = this.scopes.get(threadId);
    if (cached) return cached;
    const refresh = this.refresh(threadId, false);
    return await Promise.race([
      refresh,
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), SCOPE_BOUNDED_WAIT_MS),
      ),
    ]);
  }
}
