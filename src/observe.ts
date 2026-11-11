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

import { join } from "node:path";

import { readTextFileBounded } from "./bounded-file";
import { processCwd, psSnapshot } from "./exec";
import { gitInfoFor, type GitInfo } from "./git";
import { isRecord, parsePlist } from "./plist";
import { buildServices, findRootActivities, parsePsOutput, quietServiceActivity } from "./proc";
import type { LiveActivity } from "./types";
import { DerivedDataActions, type XcodeAction, type XcodeActionSource } from "./xcode-actions";

/** `info.plist` in a DerivedData root is a few hundred bytes. */
const MAX_ROOT_INFO_BYTES = 64 * 1024;
/** Directories recur; the caches only have to cover a working set. */
const MAX_CACHE_ENTRIES = 500;

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
    await this.addXcodeActions(procs, activities, now);
    for (const activity of activities) {
      if (signal?.aborted) return null;
      let cwd = this.cwdCache.get(activity.pid);
      if (cwd === undefined) {
        cwd = await this.cwdOf(activity.pid);
        this.cwdCache.set(activity.pid, cwd);
      }
      activity.cwd = cwd;
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

  /**
   * Give Xcode.app's build service the action it is serving.
   *
   * Its children come and go — none while it plans a build, none for the
   * whole of a test run — and with them it drops out of `findRootActivities`,
   * which reads only the process tree. An action in progress in DerivedData
   * keeps it in the snapshot, says which root (so workspace, so thread) from
   * its first second, when it began, and for a test, the bundle its verdict
   * will be read from. Only while a service process exists.
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
      activity.scheme ??= chosen.scheme;
    }
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
