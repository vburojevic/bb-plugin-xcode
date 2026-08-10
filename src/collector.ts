/**
 * The collector: turns the outside world into engine observations.
 *
 * Owns all I/O — `ps` snapshots, manifest reads, `xcresulttool` invocations,
 * root discovery — and hands plain data to the engine. The engine owns all
 * state; the collector owns none beyond caches.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { Engine } from "./engine";
import {
  discoverDefaultRoots,
  discoverProjectRoots,
  findTestResultBundles,
  looksLikeDerivedRoot,
} from "./discovery";
import { findDeveloperTool, processCwd, psSnapshot, run as execTool, xcresultJson } from "./exec";
import { gitInfoFor } from "./git";
import { parseSimctlList, type SimulatorRef } from "./destination";
import { LOG_DOMAINS, parseManifest, schemeFromTitle } from "./manifest";
import { findRootActivities, parsePsOutput } from "./proc";
import { listShimBundles } from "./shim";
import type { Store } from "./store";
import type { LiveActivity } from "./types";
import {
  parseBuildResults,
  parseTestNodes,
  parseTestSummary,
} from "./xcresult";

export interface CollectorProject {
  id: string;
  name: string;
  path: string;
}

export interface CollectorDeps {
  store: Store;
  engine: Engine;
  listProjects(): Promise<CollectorProject[]>;
  log: { debug(m: string): void; warn(m: string): void };
  dataDir: string;
}

export interface CollectorSettings {
  scanProjects: boolean;
  extraRoots: string[];
}

export class Collector {
  private projects: CollectorProject[] = [];
  private readonly cwdCache = new Map<number, string | null>();
  /** Git context per source directory; a checkout's branch rarely changes mid-build. */
  private readonly gitCache = new Map<string, { branch: string | null; worktree: string | null }>();
  private simulators: SimulatorRef[] = [];
  private lastSimRefreshAt = 0;
  private xcresultTool: string | null | undefined;
  private lastActivities: LiveActivity[] = [];
  private lastScanAt: number | null = null;
  /** Parse attempts per unparseable bundle; ≥5 marks it permanently seen. */
  private readonly bundleAttempts = new Map<string, number>();
  /** Bundles whose poisoned seen-marker was already cleared this load. */
  private readonly reparsedBundles = new Set<string>();
  /** Last upsertRoot per root — throttles per-tick WAL churn. */
  private readonly rootUpsertAt = new Map<string, number>();

  constructor(
    private readonly deps: CollectorDeps,
    private settings: CollectorSettings,
  ) {}

  updateSettings(settings: CollectorSettings): void {
    this.settings = settings;
  }

  getProjects(): CollectorProject[] {
    return this.projects;
  }

  getLastScanAt(): number | null {
    return this.lastScanAt;
  }

  getLastActivities(): LiveActivity[] {
    return this.lastActivities;
  }

  /** Every known simulator — used to resolve `id=UDID` destinations. */
  getSimulators(): SimulatorRef[] {
    return this.simulators;
  }

  /** The booted subset, for the panel's live indicator. */
  getBootedSimulators(): SimulatorRef[] {
    return this.simulators.filter((sim) => sim.state === "Booted");
  }

  private async refreshSimulators(now: number): Promise<void> {
    if (now - this.lastSimRefreshAt < 20_000) return;
    this.lastSimRefreshAt = now;
    // The FULL list, not just booted: a run's `id=UDID` destination must still
    // resolve to a name after that simulator shuts down.
    const result = await execTool(
      "/usr/bin/xcrun",
      ["simctl", "list", "devices", "--json"],
      { timeoutMs: 8_000 },
    );
    if (result.code !== 0 || !result.stdout.trim()) return; // keep last good list
    try {
      this.simulators = parseSimctlList(JSON.parse(result.stdout));
    } catch {
      /* keep last good list */
    }
  }

  /** Branch/worktree for a build, from its cwd or container directory. */
  private async gitContextFor(
    activity: LiveActivity,
  ): Promise<{ branch: string | null; worktree: string | null }> {
    const containerDir = activity.container
      ? activity.container.replace(/\/[^/]+$/, "")
      : null;
    const dir = activity.cwd ?? containerDir;
    if (!dir || !dir.startsWith("/")) return { branch: null, worktree: null };

    const cached = this.gitCache.get(dir);
    if (cached) return cached;

    const info = await gitInfoFor(dir);
    const context = info
      ? { branch: info.branch, worktree: info.worktree }
      : { branch: null, worktree: null };
    this.gitCache.set(dir, context);
    // The cache is per-directory and directories recur; cap its growth.
    if (this.gitCache.size > 500) this.gitCache.clear();
    return context;
  }

  /** Most-specific project whose worktree contains any of the given paths. */
  projectFor(signals: {
    root?: string | null;
    cwd?: string | null;
    container?: string | null;
  }): string | null {
    for (const path of [signals.root, signals.container, signals.cwd]) {
      const match = this.matchProject(path ?? null);
      if (match) return match;
    }
    return null;
  }

  private matchProject(path: string | null): string | null {
    if (!path) return null;
    let best: { id: string; length: number } | null = null;
    for (const project of this.projects) {
      const base = project.path.endsWith("/")
        ? project.path.slice(0, -1)
        : project.path;
      if (!base) continue;
      if (path === base || path.startsWith(`${base}/`)) {
        if (!best || base.length > best.length) {
          best = { id: project.id, length: base.length };
        }
      }
    }
    return best?.id ?? null;
  }

  async isXcodeAvailable(): Promise<boolean> {
    return (await this.resolveTool()) !== null;
  }

  private toolPromise: Promise<string | null> | undefined;

  private resolveTool(): Promise<string | null> {
    // Memoize the PROMISE, not the result: the old memo only stuck after the
    // first `xcrun --find` completed, so every overview call arriving before
    // that spawned its own cold xcrun (~300-800ms each — the measured
    // 513ms/call average).
    return (this.toolPromise ??= findDeveloperTool("xcresulttool").then((tool) => {
      this.xcresultTool = tool;
      return tool;
    }));
  }

  // ------------------------------------------------------------------ probe

  /** One tick: snapshot processes, harvest roots, fold into the engine. */
  async probeTick(now = Date.now()): Promise<boolean> {
    const stdout = await psSnapshot();
    if (!stdout.trim()) return false;

    const activities = findRootActivities(parsePsOutput(stdout, now));

    // Attach cwd (cached per pid) and harvest DerivedData roots.
    for (const activity of activities) {
      let cwd = this.cwdCache.get(activity.pid);
      if (cwd === undefined) {
        cwd = await processCwd(activity.pid);
        this.cwdCache.set(activity.pid, cwd);
      }
      activity.cwd = cwd;
      const git = await this.gitContextFor(activity);
      activity.branch = git.branch;
      activity.worktree = git.worktree;
      for (const root of activity.roots) {
        // Once a minute per root, not every 2s tick — the unconditional
        // upsert was a write transaction per tick and the main WAL churner.
        const lastUpsert = this.rootUpsertAt.get(root) ?? 0;
        if (now - lastUpsert < 60_000) continue;
        this.rootUpsertAt.set(root, now);
        this.deps.store.upsertRoot(root, this.matchProject(root), "process", now);
      }
    }
    for (const pid of [...this.cwdCache.keys()]) {
      if (!activities.some((activity) => activity.pid === pid)) {
        this.cwdCache.delete(pid);
      }
    }

    this.lastActivities = activities;
    this.lastScanAt = now;
    await this.refreshSimulators(now).catch(() => undefined);

    let changed = this.deps.engine.foldSnapshot(activities, now);
    if (this.deps.engine.expireFinishing(now)) changed = true;
    return changed;
  }

  // -------------------------------------------------------------- discovery

  async refreshProjects(): Promise<void> {
    try {
      this.projects = await this.deps.listProjects();
    } catch (error: unknown) {
      this.deps.log.warn(`project list failed: ${String(error)}`);
    }
  }

  async discoverRoots(now = Date.now()): Promise<number> {
    let discovered = 0;
    for (const root of await discoverDefaultRoots()) {
      if (this.deps.store.upsertRoot(root, this.matchProject(root), "default", now)) {
        discovered += 1;
      }
    }
    for (const root of this.settings.extraRoots) {
      if (!root.startsWith("/")) continue;
      if (!(await looksLikeDerivedRoot(root))) continue;
      if (this.deps.store.upsertRoot(root, this.matchProject(root), "manual", now)) {
        discovered += 1;
      }
    }
    if (this.settings.scanProjects) {
      for (const project of this.projects) {
        for (const root of await discoverProjectRoots(project.path)) {
          if (this.deps.store.upsertRoot(root, project.id, "project-scan", now)) {
            discovered += 1;
          }
        }
      }
    }
    return discovered;
  }

  // ------------------------------------------------------------------ sweep

  /** Read every known root's Build/Test manifests and fold unseen entries. */
  async sweepManifests(now = Date.now()): Promise<boolean> {
    let changed = false;
    for (const { path: root } of this.deps.store.listRoots()) {
      for (const domain of LOG_DOMAINS) {
        const manifestPath = join(
          root,
          "Logs",
          domain.dir,
          "LogStoreManifest.plist",
        );
        let xml: string;
        try {
          xml = await readFile(manifestPath, "utf8");
        } catch {
          continue;
        }
        for (const entry of parseManifest(xml)) {
          const folded = this.deps.engine.foldManifestEntry(
            root,
            domain.kind,
            {
              uniqueIdentifier: entry.uniqueIdentifier,
              title: entry.title,
              scheme: schemeFromTitle(entry.title),
              startedAt: entry.startedAt,
              endedAt: entry.endedAt,
              status: entry.status,
              errorCount: entry.errorCount,
              warningCount: entry.warningCount,
              analyzerCount: entry.analyzerCount,
              testFailureCount: entry.testFailureCount,
            },
            now,
          );
          if (folded) changed = true;
        }
      }
    }
    return changed;
  }

  // ---------------------------------------------------------------- bundles

  /**
   * Fold every unseen result bundle: shim-produced ones, ones runs already
   * claim via `-resultBundlePath`, and ones Xcode wrote into a root's Test
   * logs.
   */
  async sweepBundles(now = Date.now()): Promise<boolean> {
    const tool = await this.resolveTool();
    if (!tool) return false;

    const candidates = new Set<string>(await listShimBundles(this.deps.dataDir));
    const runs = this.deps.store.listRuns({ limit: 100 });
    const claimers = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      if (!run.bundlePath) continue;
      claimers.set(run.bundlePath, run);
      if (!run.detailed) candidates.add(run.bundlePath);
    }
    for (const { path: root } of this.deps.store.listRoots()) {
      for (const bundle of await findTestResultBundles(root)) {
        candidates.add(bundle);
      }
    }

    let changed = false;
    for (const bundle of candidates) {
      // A bundle whose producing process is still alive cannot be complete;
      // parsing it wastes a 60s-class xcresulttool spawn AND — the measured
      // failure — burns through the corrupt-bundle retry budget while the
      // build is still writing, blacklisting the real bundle before it lands.
      const claimer = claimers.get(bundle);
      if (claimer && claimer.status === "running") continue;

      // Root Info.plist only exists once xcodebuild finalizes the bundle
      // (verified on disk: an in-progress or killed bundle has only Data/).
      const finalized = await stat(join(bundle, "Info.plist"))
        .then((info) => info.isFile())
        .catch(() => false);

      // Process gone, bundle never finalized: xcodebuild finalizes on every
      // normal exit including failures, so after a grace period this build
      // was killed or crashed — resolve it to "cancelled" instead of letting
      // it expire into the verdict-less "ended".
      if (!finalized && claimer) {
        if (claimer.status === "finishing" || claimer.status === "ended") {
          const since = claimer.endedAt ?? claimer.startedAt;
          if (now - since > 20_000) {
            if (this.deps.engine.foldAbandonedBundle(claimer.id, now)) {
              changed = true;
            }
          }
        }
        continue; // never parse an unfinalized bundle
      }

      // Cheap idempotence pre-check; the engine re-checks per matched run.
      if (this.deps.store.hasSeen(`bundle-scanned:${bundle}`)) {
        // Poisoned marker: the claimer never got a verified verdict, yet the
        // bundle is marked scanned (pre-fix data, or a race). One retry per
        // load — the attempts bound below re-fences genuinely corrupt ones.
        const poisoned =
          claimer !== undefined &&
          !claimer.detailed &&
          claimer.statusRank < 2 &&
          !this.reparsedBundles.has(bundle);
        if (!poisoned) continue;
        this.reparsedBundles.add(bundle);
        this.deps.store.clearSeen(`bundle-scanned:${bundle}`);
      }


      const build = parseBuildResults(
        await xcresultJson(tool, ["get", "build-results", "--path", bundle]),
      );
      const summary = parseTestSummary(
        await xcresultJson(tool, [
          "get",
          "test-results",
          "summary",
          "--path",
          bundle,
        ]),
      );
      // A bundle still being written parses as nothing — leave it unseen so a
      // later sweep retries. Bounded: a CORRUPT bundle also parses as
      // nothing, and unbounded retries meant two 60s-class xcresulttool
      // spawns every 4s forever — chronic event-loop starvation.
      if (!build && !summary) {
        const attempts = (this.bundleAttempts.get(bundle) ?? 0) + 1;
        this.bundleAttempts.set(bundle, attempts);
        if (attempts >= 5) {
          this.deps.store.markSeen(`bundle-scanned:${bundle}`, now);
          this.bundleAttempts.delete(bundle);
        }
        continue;
      }
      this.bundleAttempts.delete(bundle);

      const testCases =
        summary && summary.total > 0
          ? parseTestNodes(
              await xcresultJson(tool, [
                "get",
                "test-results",
                "tests",
                "--path",
                bundle,
              ]),
            )
          : [];

      const folded = this.deps.engine.foldBundle(
        bundle,
        build,
        summary ? { ...summary, tests: [] } : null,
        testCases,
        now,
      );
      this.deps.store.markSeen(`bundle-scanned:${bundle}`, now);
      if (folded) changed = true;
    }
    return changed;
  }

  /** Full pass: projects, roots, manifests, bundles, timeouts. */
  async fullScan(now = Date.now()): Promise<boolean> {
    await this.refreshProjects();
    await this.discoverRoots(now);
    const swept = await this.sweepManifests(now);
    const bundles = await this.sweepBundles(now);
    const expired = this.deps.engine.expireFinishing(now);
    this.lastScanAt = now;
    return swept || bundles || expired;
  }
}
