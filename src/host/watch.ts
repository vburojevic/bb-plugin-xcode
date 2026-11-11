/**
 * Watching the Xcode builds on this Mac that the plugin did not start.
 *
 * The worker's other half (`builds.ts`) runs tracked builds. This one only
 * looks: at the process table, for builds Xcode.app, a terminal or Xcode's
 * own agent tools started, and at the DerivedData log stores and result
 * bundles they leave. The server folds what it is told exactly as it folds
 * what it reads on its own Mac — `src/remote-watch.ts` is the other end.
 *
 * Nothing here writes, spawns a build or signals anything. What it reads is
 * fenced on this Mac's own disk, where symlinks resolve for real:
 *
 *  - manifests only inside a directory that is a DerivedData root (it has
 *    `Logs/Build`), and only at their fixed place in it;
 *  - result bundles only in a root's `Logs/Test`, in this plugin's own shim
 *    directory, or at a `-resultBundlePath` a build on this Mac was seen
 *    using — never an arbitrary path the server names;
 *  - checkouts to scan only as directories, walked without following links.
 */

import { readdir, readFile, realpath, stat, writeFile, mkdir, rename } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { readTextFileBounded } from "../bounded-file";
import {
  DEFAULT_DERIVED_DATA,
  discoverDefaultRoots,
  discoverProjectRoots,
  findTestResultBundles,
  looksLikeDerivedRoot,
} from "../discovery";
import { findDeveloperTool, xcresultJson } from "../exec";
import { isFinalized, MAX_LOG_MANIFEST_BYTES, parseBundleWith } from "../machine";
import { LOG_DOMAINS, parseManifest } from "../manifest";
import { ProcessObserver, readRootWorkspace, type ObserverDeps } from "../observe";
import { shimPaths } from "../shim";
import type { LiveActivity } from "../types";
import { DerivedDataActions } from "../xcode-actions";
import { boundSummary } from "./builds";
import type {
  DiscoverRootsReply,
  InspectBundlesReply,
  ManifestReadReply,
  SummarizeBundleResult,
  WireActivity,
} from "./contract";

/** Reply caps, well inside the contract's maxima and the 8 MiB host-RPC limit. */
const MAX_ACTIVITIES = 64;
const MAX_ROOTS_PER_ACTIVITY = 32;
const MAX_DISCOVERED_ROOTS = 500;
const MAX_ENTRIES_PER_DOMAIN = 1000;
const MANIFEST_BUDGET_BYTES = 6 * 1024 * 1024;
const MAX_BUNDLE_CANDIDATES = 4000;
/** Bundle paths builds on this Mac were seen to name, remembered across workers. */
const MAX_OBSERVED_BUNDLES = 500;
const OBSERVED_FILE = "observed-bundles.json";

export interface HostWatchDeps {
  dataDir: string;
  /** Process-table and per-process reads; tests replace `ps` and `lsof`. */
  observer?: ObserverDeps;
  /** Xcode's shared DerivedData directory on this Mac. */
  derivedDataDir?: string;
  findTool?: (name: string) => Promise<string | null>;
  xcresult?: (tool: string, args: readonly string[]) => Promise<unknown | null>;
}

export class HostWatch {
  private readonly observer: ProcessObserver;
  private observed: Set<string> | null = null;
  private tool: Promise<string | null> | null = null;

  constructor(private readonly deps: HostWatchDeps) {
    this.observer = new ProcessObserver({
      actions: new DerivedDataActions(deps.derivedDataDir ?? DEFAULT_DERIVED_DATA),
      // `info.plist` is read from inside the root only, like its manifests.
      workspaceOf: async (root) =>
        (await staysInside(join(root, "info.plist"), root)) ? readRootWorkspace(root) : null,
      ...deps.observer,
    });
  }

  /** Where the worker's own tracked builds write; those are not watched here. */
  private get buildsDir(): string {
    return join(this.deps.dataDir, "builds");
  }

  // ------------------------------------------------------------------ probe

  /**
   * Throws rather than answer with less than the whole truth: the server
   * ends every run on this Mac that a snapshot leaves out, so a `ps` that
   * printed nothing (it timed out under load) or a list over the reply cap
   * must be no answer, never "no builds".
   */
  async probe(now: number): Promise<{ activities: WireActivity[] }> {
    const snapshot = await this.observer.snapshot(now);
    if (snapshot === null) throw new Error("ps gave no process list on this Mac");
    const activities: WireActivity[] = [];
    for (const activity of snapshot) {
      // A `-resultBundlePath` is relative to the build's own directory, which
      // only this Mac knows; the server stores what it is told as the path.
      const bundle = absoluteFrom(activity.resultBundlePath, activity.cwd);
      if (bundle !== null && isUnder(bundle, this.buildsDir)) continue;
      if (bundle !== null) await this.remember(bundle);
      activities.push(toWire({ ...activity, resultBundlePath: bundle }));
    }
    if (activities.length > MAX_ACTIVITIES) {
      throw new Error(`${activities.length} Xcode builds on this Mac, more than one reply can list`);
    }
    return { activities };
  }

  // -------------------------------------------------------------- discovery

  async discoverRoots(request: { projectPaths: readonly string[] }): Promise<DiscoverRootsReply> {
    const roots: DiscoverRootsReply["roots"] = [];
    for (const path of await discoverDefaultRoots(this.deps.derivedDataDir ?? DEFAULT_DERIVED_DATA)) {
      roots.push({ path, via: "default", projectPath: null });
    }
    for (const projectPath of request.projectPaths) {
      if (!isCleanAbsolute(projectPath) || !(await isDirectory(projectPath))) continue;
      for (const path of await discoverProjectRoots(projectPath)) {
        roots.push({ path, via: "project-scan", projectPath });
      }
    }
    return { roots: roots.slice(0, MAX_DISCOVERED_ROOTS) };
  }

  // -------------------------------------------------------------- manifests

  async readManifests(request: {
    roots: ReadonlyArray<{ path: string; ifModifiedSince: number | null }>;
    notBefore: number | null;
  }): Promise<ManifestReadReply> {
    const out: ManifestReadReply["roots"] = [];
    let used = 0;
    for (const { path: root, ifModifiedSince } of request.roots) {
      if (!(await isDerivedRoot(root))) continue;
      const files = [];
      for (const domain of LOG_DOMAINS) {
        const path = join(root, "Logs", domain.dir, "LogStoreManifest.plist");
        if (!(await staysInside(path, root))) continue;
        const info = await stat(path).catch(() => null);
        if (info?.isFile()) files.push({ kind: domain.kind, path, mtimeMs: info.mtimeMs });
      }
      const workspace = await this.observer.rootWorkspace(root);
      const newest = Math.max(0, ...files.map((file) => file.mtimeMs));
      if (ifModifiedSince !== null && files.length > 0 && newest <= ifModifiedSince) {
        out.push({ root, workspace, domains: [] });
        continue;
      }
      const domains: ManifestReadReply["roots"][number]["domains"] = [];
      let unread = false;
      for (const file of files) {
        let xml: string;
        try {
          xml = await readTextFileBounded(file.path, MAX_LOG_MANIFEST_BYTES);
        } catch {
          unread = true;
          continue;
        }
        const entries = parseManifest(xml)
          .filter(
            (entry) =>
              request.notBefore === null ||
              entry.startedAt === null ||
              entry.startedAt >= request.notBefore,
          )
          .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
          .slice(0, MAX_ENTRIES_PER_DOMAIN)
          .map((entry) => ({
            uniqueIdentifier: entry.uniqueIdentifier.slice(0, 200),
            title: clip(entry.title, 2000),
            startedAt: entry.startedAt,
            endedAt: entry.endedAt,
            status: entry.status,
            errorCount: entry.errorCount,
            warningCount: entry.warningCount,
            analyzerCount: entry.analyzerCount,
            testFailureCount: entry.testFailureCount,
          }));
        domains.push({ kind: file.kind, mtimeMs: file.mtimeMs, entries });
      }
      // A manifest that could not be read must be asked for again, so no
      // modification time is reported that would let the next call skip it.
      if (unread) for (const domain of domains) domain.mtimeMs = null;
      const reply = { root, workspace, domains };
      // Over the budget, the rest are left out unread; the server asks again.
      const cost = Buffer.byteLength(JSON.stringify(reply), "utf8");
      if (used + cost > MANIFEST_BUDGET_BYTES) break;
      used += cost;
      out.push(reply);
    }
    return { roots: out };
  }

  // ---------------------------------------------------------------- bundles

  async inspectBundles(request: {
    roots: readonly string[];
    paths: readonly string[];
  }): Promise<InspectBundlesReply> {
    const candidates = new Set<string>(await this.shimBundles());
    const observed = await this.observedBundles();
    for (const path of request.paths) {
      // A bundle a build here named but never wrote is still listed (as not
      // finalized): that is how a killed build is told from a slow one.
      if (observed.has(path) || (await this.mayRead(path))) candidates.add(path);
    }
    for (const root of request.roots) {
      if (!(await isDerivedRoot(root))) continue;
      for (const bundle of await findTestResultBundles(root)) candidates.add(bundle);
    }
    const listed = [...candidates].slice(0, MAX_BUNDLE_CANDIDATES);
    const finalized: string[] = [];
    for (const bundle of listed) {
      if (await isFinalized(bundle)) finalized.push(bundle);
    }
    return { candidates: listed, finalized };
  }

  async summarizeBundle(path: string): Promise<SummarizeBundleResult> {
    if (!(await this.mayRead(path))) {
      return { status: "refused", reason: "Not a result bundle a build on this Mac produced." };
    }
    if (!(await isFinalized(path))) return { status: "pending" };
    const tool = await (this.tool ??= (this.deps.findTool ?? findDeveloperTool)("xcresulttool"));
    if (!tool) {
      this.tool = null; // Xcode may be selected later; ask again next time.
      return { status: "unavailable", reason: "xcresulttool was not found on this Mac." };
    }
    const parsed = await parseBundleWith(tool, path, this.deps.xcresult ?? xcresultJson);
    if (parsed.status !== "ok") return { status: "unparseable" };
    return boundSummary(path, parsed.build, parsed.summary, parsed.tests);
  }

  /**
   * May the worker read this bundle? Only a `.xcresult` directory that a
   * DerivedData root's Test logs hold, that this plugin's shim wrote, or that
   * a build on this Mac named — judged by where it really is, symlinks
   * resolved, so a link in a root cannot lead the worker elsewhere.
   */
  private async mayRead(path: string): Promise<boolean> {
    if (!isCleanAbsolute(path) || !path.endsWith(".xcresult")) return false;
    const real = await realpath(path).catch(() => null);
    if (real === null || !real.endsWith(".xcresult") || !(await isDirectory(real))) return false;

    const testLogs = dirname(path);
    if (basename(testLogs) === "Test" && basename(dirname(testLogs)) === "Logs") {
      const root = dirname(dirname(testLogs));
      if ((await isDerivedRoot(root)) && (await staysInside(path, root))) return true;
    }
    const shim = shimPaths(this.deps.dataDir).bundleDir;
    if (dirname(path) === shim && (await staysInside(path, shim))) return true;
    return (await this.observedBundles()).has(path);
  }

  private async shimBundles(): Promise<string[]> {
    const dir = shimPaths(this.deps.dataDir).bundleDir;
    const entries = await readdir(dir).catch(() => [] as string[]);
    return entries.filter((entry) => entry.endsWith(".xcresult")).map((entry) => join(dir, entry));
  }

  // ------------------------------------------------- bundles builds named

  private async observedBundles(): Promise<Set<string>> {
    if (this.observed) return this.observed;
    const path = join(this.deps.dataDir, OBSERVED_FILE);
    let paths: string[] = [];
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (Array.isArray(raw)) paths = raw.filter((entry): entry is string => typeof entry === "string");
    } catch {
      // None yet, or unreadable: start over.
    }
    this.observed = new Set(paths.slice(-MAX_OBSERVED_BUNDLES));
    return this.observed;
  }

  /**
   * Remember a bundle a build here was seen writing, so it can be read once
   * the build is done — also by a later worker, after a reload or idle stop.
   */
  private async remember(bundle: string): Promise<void> {
    if (!isCleanAbsolute(bundle) || !bundle.endsWith(".xcresult")) return;
    const observed = await this.observedBundles();
    if (observed.has(bundle)) return;
    observed.add(bundle);
    while (observed.size > MAX_OBSERVED_BUNDLES) {
      observed.delete(observed.values().next().value!);
    }
    const path = join(this.deps.dataDir, OBSERVED_FILE);
    const temp = `${path}.${process.pid}.tmp`;
    try {
      await mkdir(this.deps.dataDir, { recursive: true });
      await writeFile(temp, JSON.stringify([...observed]));
      await rename(temp, path);
    } catch {
      // Remembered for this worker's life at least.
    }
  }
}

function toWire(activity: LiveActivity): WireActivity {
  return {
    pid: activity.pid,
    comm: clip(activity.comm, 256),
    args: clip(activity.args, 4000),
    startedAt: activity.startedAt,
    roots: activity.roots.filter((root) => root.length <= 4096).slice(0, MAX_ROOTS_PER_ACTIVITY),
    workerCount: activity.workerCount,
    phase: activity.phase,
    currentFile: clip(activity.currentFile, 1000),
    isDaemon: activity.isDaemon,
    actionStartedAt: activity.actionStartedAt ?? null,
    kind: activity.kind,
    scheme: clip(activity.scheme, 1000),
    container: within(activity.container, 4096),
    configuration: clip(activity.configuration, 1000),
    destination: clip(activity.destination, 2000),
    derivedDataPath: within(activity.derivedDataPath, 4096),
    resultBundlePath: within(activity.resultBundlePath, 4096),
    cwd: within(activity.cwd, 4096),
    branch: clip(activity.branch ?? null, 1000),
    worktree: clip(activity.worktree ?? null, 1000),
  };
}

function clip(value: string, max: number): string;
function clip(value: string | null, max: number): string | null;
function clip(value: string | null, max: number): string | null {
  return value === null || value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** A path is either whole or absent: a clipped path names somewhere else. */
function within(value: string | null, max: number): string | null {
  return value !== null && value.length <= max ? value : null;
}

function absoluteFrom(path: string | null, cwd: string | null): string | null {
  if (path === null) return null;
  if (isAbsolute(path)) return normalize(path);
  return cwd !== null && isAbsolute(cwd) ? resolve(cwd, path) : null;
}

/** Absolute, already normalized, no NUL: the only spelling worth judging. */
function isCleanAbsolute(path: string): boolean {
  return isAbsolute(path) && !path.includes("\0") && normalize(path) === path && path.length > 1;
}

function isUnder(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

async function isDerivedRoot(root: string): Promise<boolean> {
  return isCleanAbsolute(root) && (await looksLikeDerivedRoot(root));
}

/** Does `path`, links resolved, still sit inside `base`, links resolved? */
async function staysInside(path: string, base: string): Promise<boolean> {
  const [realPath, realBase] = await Promise.all([
    realpath(path).catch(() => null),
    realpath(base).catch(() => null),
  ]);
  return realPath !== null && realBase !== null && realPath.startsWith(`${realBase}/`);
}
