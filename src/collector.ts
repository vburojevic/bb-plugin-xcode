/**
 * The collector: turns the outside world into engine observations.
 *
 * Owns all I/O — `ps` snapshots, manifest reads, `xcresulttool` invocations,
 * root discovery — and hands plain data to the engine. The engine owns all
 * state; the collector owns none beyond caches.
 *
 * One collector watches one machine. The machine running bb has one for the
 * life of the plugin, reading its own disk through `LocalMachine`; another
 * Mac a thread works on gets one too while it is watched, reading through
 * that Mac's host worker (`src/remote-watch.ts`). Every run, root and
 * artifact a collector records carries its machine, so two Macs never read
 * as one.
 */

import { Engine } from "./engine";
import { parseSimctlList, type SimulatorRef } from "./destination";
import { findDeveloperTool, run as execTool } from "./exec";
import {
  LocalMachine,
  MAX_LOG_MANIFEST_BYTES as MAX_MANIFEST_BYTES,
  type MachineIO,
} from "./machine";
import { schemeFromTitle } from "./manifest";
import { ProcessObserver } from "./observe";
import { bundleScannedKey, type Store } from "./store";
import type { LiveActivity } from "./types";

export interface CollectorProject {
  id: string;
  name: string;
  path: string;
  /**
   * The Mac this source path is on; null for the machine running bb (or when
   * that cannot be told, which is how every source was read before).
   */
  hostId?: string | null;
}

export interface CollectorDeps {
  store: Store;
  engine: Engine;
  listProjects(signal?: AbortSignal): Promise<CollectorProject[]>;
  log: { debug(m: string): void; warn(m: string): void };
  dataDir: string;
  /**
   * Resolve a developer tool. Injectable so the sweep can be exercised on a
   * machine with no Xcode — which is also what keeps the suite runnable in CI.
   */
  findTool?(name: string): Promise<string | null>;
  /** The Mac this collector watches; null (the default) for this one. */
  hostId?: string | null;
  /** How that Mac is read. Defaults to this machine's own disk. */
  io?: MachineIO;
  /** Extra checkouts to scan for DerivedData on that Mac (thread scopes). */
  scanPaths?(): readonly string[];
  /**
   * Oldest log entry worth reading from another Mac's manifests, so the first
   * look at a Mac does not ship years of history across the network.
   */
  manifestHorizon?(now: number): number | null;
}

/**
 * How often the simulator list is re-read, while something is building and
 * while nothing is.
 *
 * `simctl list` is a real spawn (a few hundred ms), and the 20s cadence ran
 * forever regardless of whether the machine had built anything in a week —
 * three subprocesses a minute, in perpetuity, to keep a list nobody was
 * looking at fresh. The list still matters when idle (the panel shows booted
 * devices, and a finished run's `id=UDID` destination has to keep resolving
 * to a name), so this slows down rather than stopping.
 */
const SIM_REFRESH_BUSY_MS = 20_000;
const SIM_REFRESH_IDLE_MS = 10 * 60_000;
/**
 * The project list is a loopback HTTP fetch into the bb server; under heavy
 * host load or around sleep/wake it can fail or hang. The timeout keeps a
 * hung fetch from stalling the whole scan (undici's own limits are
 * minutes-class), and the breaker keeps a sustained outage from warning on
 * every 4–30s scan: first failure warns, the breaker-open warns once more,
 * everything else is debug, and while open the fetch is skipped entirely —
 * the last good list keeps serving project attribution.
 */
const PROJECT_LIST_TIMEOUT_MS = 10_000;
const PROJECT_LIST_BREAKER_AFTER = 3;
const PROJECT_LIST_COOLDOWN_MS = 5 * 60_000;
/** Xcode's plist is normally KB; this prevents a corrupt root from exhausting the server. */
export const MAX_LOG_MANIFEST_BYTES = MAX_MANIFEST_BYTES;

export interface CollectorSettings {
  scanProjects: boolean;
  extraRoots: string[];
}

/**
 * Network failures reach us as undici's bare "TypeError: fetch failed" with
 * the actual ECONNREFUSED/ETIMEDOUT buried in `cause`; walk the chain so the
 * log says what actually broke.
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth += 1) {
    parts.push(
      current instanceof Error
        ? `${current.name}: ${current.message}`
        : String(current),
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(" ← ");
}

export class Collector {
  private projects: CollectorProject[] = [];
  /** The Mac this collector watches; null for this one. */
  readonly hostId: string | null;
  private readonly io: MachineIO;
  /**
   * Per root, the manifest modification time last read in full — every entry
   * either folded or never foldable. A Mac whose host worker can tell is then
   * not asked to resend a manifest that has not changed.
   */
  private readonly manifestsReadAt = new Map<string, number>();
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
  /** Consecutive listProjects failures; arms the breaker below. */
  private projectFailureStreak = 0;
  /** Epoch ms before which refreshProjects skips its fetch (breaker open). */
  private projectRetryAt = 0;

  constructor(
    private readonly deps: CollectorDeps,
    private settings: CollectorSettings,
  ) {
    this.hostId = deps.hostId ?? null;
    this.io =
      deps.io ??
      new LocalMachine({
        dataDir: deps.dataDir,
        resolveTool: () => this.resolveTool(),
        observer: new ProcessObserver(),
      });
  }

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

  private async refreshSimulators(now: number, busy: boolean): Promise<void> {
    const interval = busy ? SIM_REFRESH_BUSY_MS : SIM_REFRESH_IDLE_MS;
    if (now - this.lastSimRefreshAt < interval) return;
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

  /**
   * Most-specific project whose worktree contains any of the given paths, on
   * the machine the paths are on (null: this one).
   */
  projectFor(
    signals: {
      root?: string | null;
      cwd?: string | null;
      container?: string | null;
    },
    hostId: string | null = this.hostId,
  ): string | null {
    for (const path of [signals.root, signals.container, signals.cwd]) {
      const match = this.matchProject(path ?? null, hostId);
      if (match) return match;
    }
    return null;
  }

  /** This collector's Mac's project sources. */
  private projectsHere(hostId: string | null = this.hostId): CollectorProject[] {
    return this.projects.filter((project) => (project.hostId ?? null) === hostId);
  }

  private matchProject(path: string | null, hostId: string | null = this.hostId): string | null {
    if (!path) return null;
    let best: { id: string; length: number } | null = null;
    for (const project of this.projectsHere(hostId)) {
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

  /**
   * The already-known answer, without spawning anything. `null` means the
   * first `xcrun --find` has not completed yet. Handlers must use this: the
   * async form can cost a cold ~300-1700ms xcrun spawn, which is exactly the
   * inline work an RPC handler on the shared event loop must never do.
   */
  xcodeAvailableSync(): boolean | null {
    return this.xcresultTool === undefined ? null : this.xcresultTool !== null;
  }

  private toolPromise: Promise<string | null> | undefined;

  private resolveTool(): Promise<string | null> {
    // Memoize the PROMISE, not the result: the old memo only stuck after the
    // first `xcrun --find` completed, so every overview call arriving before
    // that spawned its own cold xcrun (~300-800ms each — the measured
    // 513ms/call average).
    const find = this.deps.findTool ?? findDeveloperTool;
    return (this.toolPromise ??= find("xcresulttool").then((tool) => {
      this.xcresultTool = tool;
      return tool;
    }));
  }

  // ------------------------------------------------------------------ probe

  /**
   * One tick: snapshot processes, harvest roots, fold into the engine.
   *
   * `signal` is checked between units of I/O. A reload aborts background
   * services and waits a bounded time for them; a tick that ignores the
   * signal can sit inside `ps` + `lsof` + a full sweep for far longer than
   * that window, which puts the whole plugin in `degraded` — and a degraded
   * plugin's frontend generation is deactivated, so the live build row above
   * the composer silently stops rendering.
   */
  async probeTick(now = Date.now(), signal?: AbortSignal): Promise<boolean> {
    const activities = await this.io.snapshot(now, signal);
    if (activities === null || signal?.aborted) return false;

    // Harvest DerivedData roots.
    for (const activity of activities) {
      for (const root of activity.roots) {
        // Once a minute per root, not every 2s tick — the unconditional
        // upsert was a write transaction per tick and the main WAL churner.
        const lastUpsert = this.rootUpsertAt.get(root) ?? 0;
        if (now - lastUpsert < 60_000) continue;
        this.rootUpsertAt.set(root, now);
        this.deps.store.upsertRoot(root, this.matchProject(root), "process", now, this.hostId);
      }
    }

    this.lastActivities = activities;
    this.lastScanAt = now;
    if (signal?.aborted) return false;
    // The simulator list is this machine's; another Mac's builds are named by
    // their destination string alone.
    if (this.hostId === null) {
      await this.refreshSimulators(now, activities.length > 0).catch(
        () => undefined,
      );
    }

    let changed = this.deps.engine.foldSnapshot(activities, now, this.hostId);
    if (this.deps.engine.expireFinishing(now)) changed = true;
    return changed;
  }

  // -------------------------------------------------------------- discovery

  async refreshProjects(now = Date.now(), signal?: AbortSignal): Promise<void> {
    if (now < this.projectRetryAt) return;
    const bounded = AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(PROJECT_LIST_TIMEOUT_MS),
    ]);
    try {
      this.projects = await this.deps.listProjects(bounded);
      if (this.projectFailureStreak >= PROJECT_LIST_BREAKER_AFTER) {
        this.deps.log.debug("project list recovered");
      }
      this.projectFailureStreak = 0;
      this.projectRetryAt = 0;
    } catch (error: unknown) {
      // A reload abort is not a failure; keep the last list and stay quiet.
      if (signal?.aborted) return;
      this.projectFailureStreak += 1;
      const detail = describeError(error);
      if (this.projectFailureStreak === 1) {
        this.deps.log.warn(`project list failed: ${detail}`);
      } else if (this.projectFailureStreak === PROJECT_LIST_BREAKER_AFTER) {
        this.projectRetryAt = now + PROJECT_LIST_COOLDOWN_MS;
        this.deps.log.warn(
          `project list failed ${this.projectFailureStreak}x in a row (${detail}); pausing refresh for ${PROJECT_LIST_COOLDOWN_MS / 60_000}m`,
        );
      } else {
        // Past the breaker and still failing: sit out another cooldown
        // without re-warning — one warn per outage, not per attempt.
        if (this.projectFailureStreak > PROJECT_LIST_BREAKER_AFTER) {
          this.projectRetryAt = now + PROJECT_LIST_COOLDOWN_MS;
        }
        this.deps.log.debug(`project list failed: ${detail}`);
      }
    }
  }

  async discoverRoots(now = Date.now()): Promise<number> {
    const projects = this.settings.scanProjects ? this.projectsHere() : [];
    const projectPaths = [
      ...new Set([
        ...projects.map((project) => project.path),
        ...(this.settings.scanProjects ? (this.deps.scanPaths?.() ?? []) : []),
      ]),
    ];
    const found = await this.io.discoverRoots({
      projectPaths,
      // Typed paths name this machine's disk; another Mac is not asked to
      // look for them.
      extraRoots: this.hostId === null ? this.settings.extraRoots : [],
    });
    let discovered = 0;
    for (const root of found) {
      const projectId =
        root.via === "project-scan"
          ? (projects.find((project) => project.path === root.projectPath)?.id ??
            this.matchProject(root.path))
          : this.matchProject(root.path);
      if (this.deps.store.upsertRoot(root.path, projectId, root.via, now, this.hostId)) {
        discovered += 1;
      }
    }
    return discovered;
  }

  // ------------------------------------------------------------------ sweep

  /** Read every known root's Build/Test manifests and fold unseen entries. */
  async sweepManifests(
    now = Date.now(),
    signal?: AbortSignal,
  ): Promise<boolean> {
    let changed = false;
    const roots = this.deps.store.listRoots(this.hostId).map(({ path }) => ({
      path,
      ifModifiedSince: this.manifestsReadAt.get(path) ?? null,
    }));
    if (roots.length === 0) return false;
    const horizon = this.deps.manifestHorizon?.(now) ?? null;
    for (const read of await this.io.readManifests(roots, signal)) {
      if (signal?.aborted) return changed;
      let consumed = true;
      let readAt: number | null = null;
      for (const domain of read.domains) {
        readAt = Math.max(readAt ?? 0, domain.mtimeMs ?? 0) || null;
        for (const entry of domain.entries) {
          if (horizon !== null && entry.startedAt !== null && entry.startedAt < horizon) continue;
          const folded = this.deps.engine.foldManifestEntry(
            read.root,
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
            { hostId: this.hostId, container: read.workspace },
          );
          if (folded) changed = true;
          // An entry the engine declined (its run is still running) has to be
          // read again, so this manifest is not done with yet.
          if (
            entry.startedAt !== null &&
            !this.deps.store.hasSeen(`manifest:${entry.uniqueIdentifier}`)
          ) {
            consumed = false;
          }
        }
      }
      // An unchanged manifest comes back with no domains: still done with.
      if (read.domains.length === 0) continue;
      if (consumed && readAt !== null) this.manifestsReadAt.set(read.root, readAt);
      else this.manifestsReadAt.delete(read.root);
    }
    return changed;
  }

  // ---------------------------------------------------------------- bundles

  /**
   * Fold every unseen result bundle: shim-produced ones, ones runs already
   * claim via `-resultBundlePath`, and ones Xcode wrote into a root's Test
   * logs.
   */
  async sweepBundles(now = Date.now(), signal?: AbortSignal): Promise<boolean> {
    const store = this.deps.store;
    const host = this.hostId;
    // Answered in SQL rather than by scanning the newest 100 runs: `detailed`
    // means "we already extracted its contents", which is not the same
    // question as "has this bundle been scanned". The seen key is the
    // authority on the latter, and keeping them separate is what lets a
    // deliberate re-queue actually re-read.
    const { candidates, finalized: finalizedSet } = await this.io.listBundles(
      store.listRoots(host).map(({ path }) => path),
      store.listUnscannedBundlePaths(500, host),
    );

    /**
     * Whether `xcresulttool` can be had here, learned from the first bundle
     * that actually needs parsing.
     *
     * The tool used to gate this whole method, which meant a machine without
     * Xcode selected also lost the abandoned-bundle rescue below — a check
     * that reads one `Info.plist` off disk and needs no toolchain at all. A
     * killed build stayed at the verdict-less `ended` for want of a parser it
     * was never going to call.
     */
    let parserUnavailable = false;

    let changed = false;
    for (const bundle of candidates) {
      // Between bundles is the only safe place to bail: one xcresulttool
      // call can take up to its 60s timeout, far past the reload window.
      if (signal?.aborted) return changed;
      // A bundle whose producing process is still alive cannot be complete;
      // parsing it wastes a 60s-class xcresulttool spawn AND — the measured
      // failure — burns through the corrupt-bundle retry budget while the
      // build is still writing, blacklisting the real bundle before it lands.
      // Looked up by indexed path, so a long build cannot age out of the
      // window and lose this protection precisely when it matters most.
      const claimer = store.getRunByBundlePath(bundle, host);
      if (claimer && claimer.status === "running") continue;

      // Root Info.plist only exists once xcodebuild finalizes the bundle
      // (verified on disk: an in-progress or killed bundle has only Data/).
      const finalized = finalizedSet.has(bundle);

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

      const scannedKey = bundleScannedKey(host, bundle);
      // Cheap idempotence pre-check; the engine re-checks per matched run.
      if (store.hasSeen(scannedKey)) {
        // Poisoned marker: the claimer never got a verified verdict, yet the
        // bundle is marked scanned (pre-fix data, or a race). One retry per
        // load — the attempts bound below re-fences genuinely corrupt ones.
        const poisoned =
          claimer !== null &&
          !claimer.detailed &&
          claimer.statusRank < 2 &&
          !this.reparsedBundles.has(bundle);
        if (!poisoned) continue;
        this.reparsedBundles.add(bundle);
        store.clearSeen(scannedKey);
      }

      // Never parse a bundle that is not finalized; with no claimer there is
      // nothing to rescue either, so a later sweep looks again.
      if (!finalized) continue;
      if (parserUnavailable) continue;

      const parsed = await this.io.parseBundle(bundle);
      if (parsed.status === "unavailable") {
        parserUnavailable = true;
        continue;
      }
      if (parsed.status === "refused") {
        this.deps.log.debug(`not reading ${bundle}: ${parsed.reason}`);
        store.markSeen(scannedKey, now);
        continue;
      }
      // A bundle still being written parses as nothing — leave it unseen so a
      // later sweep retries. Bounded: a CORRUPT bundle also parses as
      // nothing, and unbounded retries meant two 60s-class xcresulttool
      // spawns every 4s forever — chronic event-loop starvation.
      if (parsed.status === "empty") {
        const attempts = (this.bundleAttempts.get(bundle) ?? 0) + 1;
        this.bundleAttempts.set(bundle, attempts);
        if (attempts >= 5) {
          store.markSeen(scannedKey, now);
          this.bundleAttempts.delete(bundle);
        }
        continue;
      }
      this.bundleAttempts.delete(bundle);

      const folded = this.deps.engine.foldBundle(
        bundle,
        parsed.build,
        parsed.summary ? { ...parsed.summary, tests: [] } : null,
        parsed.tests,
        now,
        host,
      );
      store.markSeen(scannedKey, now);
      if (folded) changed = true;
    }
    return changed;
  }

  /** Full pass: projects, roots, manifests, bundles, timeouts. */
  async fullScan(now = Date.now(), signal?: AbortSignal): Promise<boolean> {
    await this.refreshProjects(now, signal);
    if (signal?.aborted) return false;
    await this.discoverRoots(now);
    if (signal?.aborted) return false;
    const swept = await this.sweepManifests(now, signal);
    const bundles = await this.sweepBundles(now, signal);
    const expired = this.deps.engine.expireFinishing(now);
    this.lastScanAt = now;
    return swept || bundles || expired;
  }
}
