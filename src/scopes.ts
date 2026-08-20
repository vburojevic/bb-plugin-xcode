/**
 * Thread scopes: which bb thread "owns" which checkout right now.
 *
 * There is no plugin event for "an agent ran a command", so builds cannot be
 * attributed by observing tool calls. What IS knowable is stronger anyway:
 * when a thread turns active, its environment names the exact worktree path
 * (and branch) any build it starts will run from. The server registers that
 * path here; the probe then attributes a new xcodebuild to the thread the
 * moment its cwd (or container/DerivedData root) falls under a scoped path.
 *
 * Pure and import-free so it unit-tests without a bb server.
 */

export interface ThreadScope {
  threadId: string;
  projectId: string | null;
  environmentId: string | null;
  /** Absolute worktree/checkout path of the thread's environment. */
  path: string;
  branch: string | null;
  /** True while the thread is running a turn. */
  active: boolean;
  updatedAt: number;
}

/** Keep an idle thread's scope this long — xcodebuild often outlives the turn. */
export const SCOPE_IDLE_TTL_MS = 30 * 60_000;

export class ThreadScopes {
  private readonly byThread = new Map<string, ThreadScope>();

  upsert(scope: Omit<ThreadScope, "updatedAt">, now: number): void {
    if (!scope.path.startsWith("/")) return;
    this.byThread.set(scope.threadId, { ...scope, updatedAt: now });
  }

  deactivate(threadId: string, now: number): void {
    const scope = this.byThread.get(threadId);
    if (scope) {
      scope.active = false;
      scope.updatedAt = now;
    }
  }

  remove(threadId: string): void {
    this.byThread.delete(threadId);
  }

  get(threadId: string): ThreadScope | null {
    return this.byThread.get(threadId) ?? null;
  }

  list(): ThreadScope[] {
    return [...this.byThread.values()];
  }

  /** Drop scopes idle past the TTL. Active scopes never expire. */
  prune(now: number): void {
    for (const [threadId, scope] of this.byThread) {
      if (!scope.active && now - scope.updatedAt > SCOPE_IDLE_TTL_MS) {
        this.byThread.delete(threadId);
      }
    }
  }

  /**
   * The thread whose scope contains any of the given paths. Most specific
   * path wins; among equals, an active scope beats an idle one and the most
   * recently updated beats the rest — two threads can share a checkout (a
   * thread plus its side chat), and the one actually running is the answer.
   */
  threadFor(signals: {
    root?: string | null;
    cwd?: string | null;
    container?: string | null;
  }): string | null {
    let best: ThreadScope | null = null;
    for (const path of [signals.cwd, signals.container, signals.root]) {
      if (!path) continue;
      for (const scope of this.byThread.values()) {
        if (!pathIsUnder(path, scope.path)) continue;
        if (!best) {
          best = scope;
          continue;
        }
        if (scope.path.length !== best.path.length) {
          if (scope.path.length > best.path.length) best = scope;
          continue;
        }
        if (scope.active !== best.active) {
          if (scope.active) best = scope;
          continue;
        }
        if (scope.updatedAt > best.updatedAt) best = scope;
      }
      if (best) return best.threadId;
    }
    return null;
  }
}

export function pathIsUnder(path: string, base: string): boolean {
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  if (!root) return false;
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Does a finished/attributed run belong to this scope? Used at query time so
 * runs recorded before the scope existed (or by other tools entirely) still
 * show up on the thread's card.
 */
/**
 * The predicate a thread-scoped surface must filter runs through.
 *
 * This exists as its own function because the obvious inline form was wrong in
 * a way that only showed up on a brand-new thread:
 *
 *     const inScope = (run) => !scope || runMatchesScope(run, scope);
 *
 * A null scope meant "no filter", so a thread whose checkout had not resolved
 * yet silently widened to the whole machine and the banner showed somebody
 * else's build — in the observed case a finished run from a DIFFERENT, since
 * archived worktree, presented as this thread's last activity.
 *
 * An unresolved scope is an absence of knowledge, not permission to answer
 * with everything. Machine-wide host-owned surfaces query the store directly;
 * this boundary has no widening switch.
 */
export function scopeFilter<
  T extends Parameters<typeof runMatchesScope>[0],
>(
  scope: { threadId: string; path: string; branch: string | null } | null,
): (run: T) => boolean {
  if (!scope) return () => false;
  return (run) => runMatchesScope(run, scope);
}

export function runMatchesScope(
  run: {
    threadId?: string | null;
    cwd: string | null;
    container: string | null;
    root: string | null;
    branch: string | null;
    worktree: string | null;
  },
  scope: { threadId: string; path: string; branch: string | null },
): boolean {
  if (run.threadId && run.threadId === scope.threadId) return true;
  for (const path of [run.cwd, run.container, run.root]) {
    if (path && pathIsUnder(path, scope.path)) return true;
  }
  // Weakest signal: same checkout directory name + same branch. Catches runs
  // whose cwd was unresolvable (lsof raced the process) without letting every
  // `main` build on the machine claim the thread.
  if (run.worktree && run.branch && scope.branch) {
    const base = scope.path.endsWith("/") ? scope.path.slice(0, -1) : scope.path;
    const name = base.slice(base.lastIndexOf("/") + 1);
    return run.worktree === name && run.branch === scope.branch;
  }
  return false;
}
