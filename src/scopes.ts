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
  /**
   * The enrolled Mac the checkout lives on, or null for the machine running
   * bb. Normalized by `ScopeSync`: an environment on this machine is null
   * here, exactly as its runs are, so the host comparison in
   * `runMatchesScope` is a plain equality. `path` names a directory on that
   * host — see `src/launcher.ts`.
   */
  hostId: string | null;
  branch: string | null;
  /** True while the thread is running a turn. */
  active: boolean;
  /**
   * When the thread last ran a turn, as far as this plugin saw: set when one
   * starts or ends, never by merely resolving the scope (opening an old
   * thread resolves it too). Null when no turn was seen.
   */
  activeAt?: number | null;
  updatedAt: number;
}

/** Keep an idle thread's scope this long — xcodebuild often outlives the turn. */
export const SCOPE_IDLE_TTL_MS = 30 * 60_000;

export class ThreadScopes {
  private readonly byThread = new Map<string, ThreadScope>();

  /** An active scope's turn is running now; an idle one keeps its `activeAt`. */
  upsert(scope: Omit<ThreadScope, "updatedAt">, now: number): void {
    if (!scope.path.startsWith("/")) return;
    this.byThread.set(scope.threadId, {
      ...scope,
      activeAt: scope.active ? now : (scope.activeAt ?? null),
      updatedAt: now,
    });
  }

  /** The thread's turn ended now. */
  deactivate(threadId: string, now: number): void {
    const scope = this.byThread.get(threadId);
    if (scope) {
      if (scope.active) scope.activeAt = now;
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

  /**
   * Other Macs with a thread checkout that is running a turn, or ran one
   * within the idle TTL. These are the Macs worth watching: a build there now
   * is most likely a thread's. Measured from the last turn (`activeAt`), not
   * from when the scope was last resolved: opening an old thread resolves
   * it, and must not start a process scan on its Mac.
   */
  watchedHosts(now: number): string[] {
    const hosts = new Set<string>();
    for (const scope of this.byThread.values()) {
      if (scope.hostId === null) continue;
      const lastTurn = scope.activeAt ?? null;
      if (scope.active || (lastTurn !== null && now - lastTurn <= SCOPE_IDLE_TTL_MS)) {
        hosts.add(scope.hostId);
      }
    }
    return [...hosts];
  }

  /** Checkouts of scopes on one Mac, for its root discovery. */
  pathsOn(hostId: string): string[] {
    return [...new Set(this.list().filter((scope) => scope.hostId === hostId).map((scope) => scope.path))];
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
   *
   * Only scopes on the machine the signals were read on are candidates
   * (`hostId` null: this one): another Mac can hold the very same path.
   */
  threadFor(
    signals: {
      root?: string | null;
      cwd?: string | null;
      container?: string | null;
    },
    hostId: string | null = null,
  ): string | null {
    let best: ThreadScope | null = null;
    for (const path of [signals.cwd, signals.container, signals.root]) {
      if (!path) continue;
      for (const scope of this.byThread.values()) {
        if (scope.hostId !== hostId) continue;
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
  scope: RunScopeLike | null,
): (run: T) => boolean {
  if (!scope) return () => false;
  return (run) => runMatchesScope(run, scope);
}

/** The parts of a scope the predicate reads. `hostId` null = this machine. */
export interface RunScopeLike {
  threadId: string;
  path: string;
  branch: string | null;
  hostId: string | null;
}

export function runMatchesScope(
  run: {
    threadId?: string | null;
    cwd: string | null;
    container: string | null;
    root: string | null;
    branch: string | null;
    worktree: string | null;
    hostId: string | null;
  },
  scope: RunScopeLike,
): boolean {
  // A run attributed to this thread is this thread's, wherever it ran.
  if (run.threadId && run.threadId === scope.threadId) return true;
  // Every other arm compares paths and names, and two Macs can hold the same
  // `/Users/me/App` on the same branch. A path only means something on its
  // own machine. Mirrored in `scopeClause` (store.ts).
  if ((run.hostId ?? null) !== (scope.hostId ?? null)) return false;
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
