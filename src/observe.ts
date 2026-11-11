/**
 * Watching one Mac's process table for Xcode builds.
 *
 * The same code runs in two places: in the server, for the machine running bb,
 * and in the `bb.host` worker on every other Mac the plugin watches. That is
 * the point of it living here rather than in the collector — a build on a
 * MacBook is read on the MacBook, with that Mac's `ps`, `lsof` and disk, and
 * reported the way a build on the server always was.
 *
 * Import-light on purpose: `host.ts` bundles it.
 */

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { readTextFileBounded } from "./bounded-file";
import { processCwd, psSnapshot } from "./exec";
import { gitInfoFor, type GitInfo } from "./git";
import { isRecord, parsePlist } from "./plist";
import { buildServices, findRootActivities, parsePsOutput, quietServiceActivity, xcodeAppOf } from "./proc";
import type { LiveActivity } from "./types";
import { DerivedDataActions, type XcodeAction, type XcodeActionSource } from "./xcode-actions";

/** `info.plist` in a DerivedData root is a few hundred bytes. */
const MAX_ROOT_INFO_BYTES = 64 * 1024;
/** Directories recur; the caches only have to cover a working set. */
const MAX_CACHE_ENTRIES = 500;
/**
 * How long before its build service's own start an action may have begun and
 * still be that service's. Xcode names a test action's bundle first and may
 * only then launch a service to build it; anything older was left by an
 * earlier service — a crash's unfinished bundle, a hot journal.
 */
const SERVICE_START_SLACK_MS = 60_000;
/**
 * An action never begins before the Xcode.app that runs it: one that did was
 * left by an Xcode that has since quit or crashed, however quickly it was
 * reopened. The slack covers `ps etime`'s whole seconds only.
 */
const SESSION_START_SLACK_MS = 2_000;

/**
 * The workspace or project a DerivedData root belongs to.
 *
 * Xcode writes `<root>/info.plist` with a `WorkspacePath` key for every root
 * it creates (verified on Xcode 26: `SurfTracker-…/info.plist` names
 * `…/SurfTracker/SurfTracker.xcworkspace`). It is the only place an Xcode.app
 * build names its checkout: the build service runs from `/`, its compilers'
 * arguments name DerivedData under `~/Library`, and its log entries carry a
 * scheme but no path. Null for a root without one (a `-derivedDataPath` root
 * xcodebuild made, or one Xcode has not written yet).
 */
export async function readRootWorkspace(root: string): Promise<string | null> {
  try {
    const xml = await readTextFileBounded(join(root, "info.plist"), MAX_ROOT_INFO_BYTES);
    const plist = parsePlist(xml);
    const path = isRecord(plist) ? plist.WorkspacePath : undefined;
    return typeof path === "string" && path.startsWith("/") ? path : null;
  } catch {
    return null;
  }
}

export interface ObserverDeps {
  /** `ps` output in the shape `parsePsOutput` expects. */
  ps?: () => Promise<string>;
  cwdOf?: (pid: number) => Promise<string | null>;
  gitOf?: (dir: string) => Promise<GitInfo | null>;
  workspaceOf?: (root: string) => Promise<string | null>;
  /** Xcode.app's actions in progress, from DerivedData. */
  actions?: XcodeActionSource;
}

/**
 * Snapshots of one machine's Xcode builds, with the context that machine
 * alone can supply: each build's working directory, its git branch and
 * worktree, and — when nothing else names it — the workspace its DerivedData
 * root belongs to. Caches live as long as the observer.
 */
export class ProcessObserver {
  private readonly ps: () => Promise<string>;
  private readonly cwdOf: (pid: number) => Promise<string | null>;
  private readonly gitOf: (dir: string) => Promise<GitInfo | null>;
  private readonly workspaceOf: (root: string) => Promise<string | null>;
  private readonly actions: XcodeActionSource;
  private readonly cwdCache = new Map<number, string | null>();
  /** Git context per source directory; a checkout's branch rarely changes mid-build. */
  private readonly gitCache = new Map<string, { branch: string | null; worktree: string | null }>();
  /** A root's workspace never changes: its directory name is a hash of it. */
  private readonly workspaceCache = new Map<string, string | null>();

  constructor(deps: ObserverDeps = {}) {
    this.ps = deps.ps ?? psSnapshot;
    this.cwdOf = deps.cwdOf ?? processCwd;
    this.gitOf = deps.gitOf ?? gitInfoFor;
    this.workspaceOf = deps.workspaceOf ?? readRootWorkspace;
    this.actions = deps.actions ?? new DerivedDataActions();
  }

  /**
   * One snapshot, or null when there is none to give: `ps` printed nothing
   * (it failed or timed out) or `signal` was aborted part-way. Null is "no
   * data", never "no builds": a caller must not end runs on it.
   */
  async snapshot(now: number, signal?: AbortSignal): Promise<LiveActivity[] | null> {
    const stdout = await this.ps();
    if (!stdout.trim()) return null;

    const procs = parsePsOutput(stdout, now);
    const activities = findRootActivities(procs);
    // Each build's directory first: it is what says which workspace a
    // terminal build owns, before Xcode.app's service is given an action.
    for (const activity of activities) {
      if (signal?.aborted) return null;
      activity.cwd = await this.cwdFor(activity.pid);
    }
    await this.addXcodeActions(procs, activities, now);
    for (const activity of activities) {
      if (signal?.aborted) return null;
      activity.cwd = await this.cwdFor(activity.pid);
      if (activity.container === null) {
        activity.container = await this.workspaceFor(activity);
      }
      const git = await this.gitContextFor(activity);
      activity.branch = git.branch;
      activity.worktree = git.worktree;
    }
    for (const pid of [...this.cwdCache.keys()]) {
      if (!activities.some((activity) => activity.pid === pid)) this.cwdCache.delete(pid);
    }
    return activities;
  }

  private async cwdFor(pid: number): Promise<string | null> {
    let cwd = this.cwdCache.get(pid);
    if (cwd === undefined) {
      cwd = await this.cwdOf(pid);
      this.cwdCache.set(pid, cwd);
    }
    return cwd;
  }

  /**
   * Give Xcode.app's build service the action it is serving.
   *
   * Its children come and go — none while it plans a build, none for the
   * whole of a test run — and with them it drops out of `findRootActivities`,
   * which reads only the process tree. An action in progress in DerivedData
   * keeps it in the snapshot, says which root (so workspace, so thread) from
   * its first second, when it began, and for a test, the bundle its verdict
   * will be read from. Only while a service process exists, only actions
   * that began under this service and this Xcode.app, and never one a
   * terminal `xcodebuild` is running: that build is already its own activity,
   * and its journal is not Xcode.app's.
   */
  private async addXcodeActions(
    procs: ReturnType<typeof parsePsOutput>,
    activities: LiveActivity[],
    now: number,
  ): Promise<void> {
    const service = buildServices(procs)[0];
    if (!service) return;
    let activity = activities.find((entry) => entry.pid === service.pid);
    const seenRoots = activity ? [...activity.roots] : [];
    let actions: XcodeAction[];
    try {
      actions = await this.actions.inProgress(now, seenRoots);
    } catch {
      return;
    }
    const notBefore = actionsNotBefore(service.startedAt, xcodeAppOf(procs, service)?.startedAt ?? null);
    if (notBefore === null) return;
    const terminal = activities.filter((entry) => !entry.isDaemon);
    const kept: XcodeAction[] = [];
    for (const action of actions) {
      if (action.startedAt < notBefore) continue;
      if (await this.runByTerminal(action.root, terminal)) continue;
      kept.push(action);
    }
    actions = kept;
    // The action of a root the service is visibly working in, else the one
    // action there is. Two at once with no other clue: liveness, no claim.
    const own = actions.filter((action) => seenRoots.includes(action.root));
    const roots = new Set(actions.map((action) => action.root));
    const tests = actions.filter((action) => action.kind === "test");
    const chosen =
      own.find((action) => action.kind === "test") ??
      own[0] ??
      (tests.length === 1 ? tests[0] : null) ??
      (roots.size === 1 ? actions[0] : null);
    if (actions.length === 0) return;
    if (!activity) {
      activity = quietServiceActivity(service, now);
      activities.push(activity);
    }
    if (!chosen) return;
    if (!activity.roots.includes(chosen.root)) activity.roots.unshift(chosen.root);
    activity.actionStartedAt = Math.min(
      ...actions.filter((action) => action.root === chosen.root).map((action) => action.startedAt),
    );
    if (chosen.kind === "test") {
      activity.kind = "test";
      activity.resultBundlePath = chosen.bundlePath;
      activity.resultBundleFound = true;
      activity.scheme ??= chosen.scheme;
    }
  }

  /**
   * Is a terminal build working in this root? A build that names its
   * DerivedData (`-derivedDataPath`, or its compilers' arguments) works there
   * and nowhere else — the same workspace built by Xcode.app into another
   * root is not its. A name is compared as the directory it is: a relative
   * `-derivedDataPath` from the build's own directory, any spelling
   * normalized, links resolved. Only a build that names none yet (or only a
   * relative one from a directory not known) is judged by the workspace it
   * builds (by path, or as the one in its directory), the way it will use
   * the workspace's shared root.
   */
  private async runByTerminal(root: string, terminal: readonly LiveActivity[]): Promise<boolean> {
    const unplaced: LiveActivity[] = [];
    for (const build of terminal) {
      const named = namedRoots(build);
      if (named.length === 0) {
        unplaced.push(build);
        continue;
      }
      for (const path of named) {
        if (await sameDirectory(path, root)) return true;
      }
    }
    if (unplaced.length === 0) return false;
    const workspace = await this.rootWorkspace(root);
    if (workspace === null) return false;
    return unplaced.some((build) => {
      const cwd = build.cwd !== null && isAbsolute(build.cwd) ? build.cwd : null;
      if (build.container !== null) {
        const container = isAbsolute(build.container)
          ? build.container
          : cwd !== null
            ? resolve(cwd, build.container)
            : null;
        return container === workspace;
      }
      return cwd !== null && resolve(cwd) === dirname(workspace);
    });
  }

  /** The cached workspace of a root, read once. */
  async rootWorkspace(root: string): Promise<string | null> {
    const cached = this.workspaceCache.get(root);
    if (cached !== undefined) return cached;
    const workspace = await this.workspaceOf(root);
    // Only a found answer is final; Xcode writes the file a moment after it
    // creates the root, so a miss is asked again next time.
    if (workspace !== null) {
      if (this.workspaceCache.size > MAX_CACHE_ENTRIES) this.workspaceCache.clear();
      this.workspaceCache.set(root, workspace);
    }
    return workspace;
  }

  private async workspaceFor(activity: LiveActivity): Promise<string | null> {
    const roots = [activity.derivedDataPath, ...activity.roots].filter(
      (root): root is string => typeof root === "string" && root.startsWith("/"),
    );
    for (const root of roots) {
      const workspace = await this.rootWorkspace(root);
      if (workspace) return workspace;
    }
    return null;
  }

  /** Branch/worktree for a build, from its cwd or container directory. */
  private async gitContextFor(
    activity: LiveActivity,
  ): Promise<{ branch: string | null; worktree: string | null }> {
    const containerDir = activity.container
      ? activity.container.replace(/\/[^/]+$/, "")
      : null;
    // Xcode.app's build service runs from `/`, which is in no checkout; the
    // workspace it is building is the better guide.
    const dir = activity.isDaemon ? (containerDir ?? activity.cwd) : (activity.cwd ?? containerDir);
    if (!dir || !dir.startsWith("/")) return { branch: null, worktree: null };

    const cached = this.gitCache.get(dir);
    if (cached) return cached;

    const info = await this.gitOf(dir);
    const context = info
      ? { branch: info.branch, worktree: info.worktree }
      : { branch: null, worktree: null };
    this.gitCache.set(dir, context);
    if (this.gitCache.size > MAX_CACHE_ENTRIES) this.gitCache.clear();
    return context;
  }
}

/**
 * The earliest an action may have begun and still be one the running Xcode
 * is serving; null when nothing on disk can be credited to it.
 *
 * With its Xcode.app known, the app's own start fences off what an earlier
 * session left, however soon it was reopened, while a bundle Xcode named a
 * little before launching the service for it still counts. Without it — two
 * Xcodes open and the service under launchd — that allowance cannot be told
 * from a crash's leftovers, so only what began under this service counts: a
 * test whose service started after its bundle is then seen only through the
 * service's children, a gap rather than a build that is not there.
 */
export function actionsNotBefore(serviceStart: number | null, sessionStart: number | null): number | null {
  if (sessionStart !== null) {
    return Math.max(
      sessionStart - SESSION_START_SLACK_MS,
      serviceStart !== null ? serviceStart - SERVICE_START_SLACK_MS : -Infinity,
    );
  }
  return serviceStart !== null ? serviceStart - SESSION_START_SLACK_MS : null;
}

/** The DerivedData roots a terminal build names, as absolute paths. */
function namedRoots(build: LiveActivity): string[] {
  const cwd = build.cwd !== null && isAbsolute(build.cwd) ? build.cwd : null;
  const named: string[] = [];
  for (const path of [build.derivedDataPath, ...build.roots]) {
    if (path === null) continue;
    if (isAbsolute(path)) named.push(normalize(path));
    else if (cwd !== null) named.push(resolve(cwd, path));
  }
  return named;
}

/** Are two absolute paths the same directory, by spelling or once resolved? */
async function sameDirectory(a: string, b: string): Promise<boolean> {
  if (normalize(a) === normalize(b)) return true;
  const [realA, realB] = await Promise.all([realpath(a).catch(() => null), realpath(b).catch(() => null)]);
  return realA !== null && realA === realB;
}
