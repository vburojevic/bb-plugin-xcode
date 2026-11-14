/**
 * Watching the builds on other Macs that the plugin did not start.
 *
 * A thread whose checkout is on a MacBook builds there in ways no tool call
 * routes through this plugin: Xcode.app's Build and Test, a terminal, Xcode's
 * own agent tools (`BuildProject`, `RunSomeTests`, which build inside
 * Xcode.app). On the machine running bb those are seen by the probe and the
 * DerivedData sweep. This is the same probe and sweep for another Mac: a
 * `Collector` per watched Mac, reading through that Mac's `bb.host` worker
 * (`src/host/watch.ts`) instead of this machine's disk, folding into the same
 * store and engine under that Mac's host id. So its builds land in the
 * thread's live row and on the plugin page exactly as local ones do.
 *
 * Which Macs. `ps` every couple of seconds is not free, so a Mac is watched
 * only while there is reason to: a thread whose checkout is there is active,
 * or was within the idle TTL a scope is kept for; the person listed it in the
 * "Always watch these Macs" setting; or a build there is still open, so it is
 * watched until it resolves. Each Mac has its own loop, held to the same duty
 * cycle as the local probe, so a slow or asleep Mac never holds up another.
 */

import { Collector, type CollectorProject } from "./collector";
import type { Engine } from "./engine";
import type {
  BundleListing,
  DiscoveredRoot,
  MachineIO,
  ParsedBundle,
  RootManifests,
} from "./machine";
import type { HostCaller } from "./remote";
import type { Store } from "./store";
import type { LiveActivity, ServicePresence } from "./types";

/** Call budgets. A bundle summary can be three 60s-class xcresulttool runs. */
const PROBE_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 60_000;
const SUMMARY_TIMEOUT_MS = 4 * 60_000;

/** The local probe's rules, per Mac: see `server.ts`. */
const PROBE_DUTY_FACTOR = 2;
const PROBE_MAX_SLEEP_MS = 60_000;
/** An unreachable Mac is asked again after 5 s, doubling to 5 min. */
const FAILURE_BASE_MS = 5_000;
const FAILURE_MAX_MS = 5 * 60_000;
/** Sweep cadence: soon after a build ends, otherwise every half minute. */
const SWEEP_PENDING_MS = 4_000;
const SWEEP_IDLE_MS = 30_000;
/** How often a watched Mac's DerivedData roots are looked for again. */
const DISCOVER_EVERY_MS = 10 * 60_000;

/** The Mac's host worker, as one Mac's `MachineIO`. */
export class RemoteMachine implements MachineIO {
  constructor(
    private readonly host: HostCaller,
    readonly hostId: string,
    /**
     * Oldest log entry worth shipping, so the first look at a Mac does not
     * carry years of history across the network; null for all of them.
     */
    private readonly notBefore: () => number | null = () => null,
    /** Aborts calls in flight when the Mac stops being watched or bb reloads. */
    private readonly signal?: AbortSignal,
  ) {}

  private options(timeoutMs: number) {
    return { hostId: this.hostId, timeoutMs, ...(this.signal ? { signal: this.signal } : {}) };
  }

  /**
   * The build services the Mac last said were alive. Kept through a failed
   * call: the last thing known of a process is that it was there, and a Mac
   * out of reach is no evidence that it has gone.
   */
  private present: ServicePresence[] | null = null;

  /** Transport failures throw: no answer is never taken for "no builds". */
  async snapshot(): Promise<LiveActivity[] | null> {
    const reply = await this.host.call("probe", {}, this.options(PROBE_TIMEOUT_MS));
    this.present = reply.services ? reply.services.map((service) => ({ ...service })) : null;
    return reply.activities.map((activity) => ({ ...activity }));
  }

  services(): readonly ServicePresence[] | null {
    return this.present;
  }

  async discoverRoots(request: { projectPaths: readonly string[] }): Promise<DiscoveredRoot[]> {
    const reply = await this.host.call(
      "discoverRoots",
      { projectPaths: request.projectPaths.filter((path) => path.startsWith("/")).slice(0, 64) },
      this.options(READ_TIMEOUT_MS),
    );
    return reply.roots;
  }

  async readManifests(
    roots: ReadonlyArray<{ path: string; ifModifiedSince: number | null }>,
  ): Promise<RootManifests[]> {
    const reply = await this.host.call(
      "readManifests",
      {
        // A build's relative `-derivedDataPath` (`.dd`) is recorded as given;
        // the worker takes absolute paths only, and one would fail the call.
        roots: roots
          .filter((root) => root.path.startsWith("/"))
          .slice(0, 200)
          .map((root) => ({ ...root })),
        notBefore: this.notBefore(),
      },
      this.options(READ_TIMEOUT_MS),
    );
    return reply.roots;
  }

  async listBundles(roots: readonly string[], claimed: readonly string[]): Promise<BundleListing> {
    const reply = await this.host.call(
      "inspectBundles",
      {
        roots: roots.filter((path) => path.startsWith("/")).slice(0, 200),
        paths: claimed.filter((path) => path.startsWith("/")).slice(0, 500),
      },
      this.options(READ_TIMEOUT_MS),
    );
    return { candidates: reply.candidates, finalized: new Set(reply.finalized) };
  }

  async parseBundle(path: string): Promise<ParsedBundle> {
    const reply = await this.host.call(
      "summarizeBundle",
      { path },
      this.options(SUMMARY_TIMEOUT_MS),
    );
    switch (reply.status) {
      case "ok":
        return {
          status: "ok",
          build: reply.build,
          summary: reply.summary,
          tests: reply.tests,
        };
      case "unparseable":
        return { status: "empty" };
      // Not finalized after all, or no Xcode there: later, not never.
      case "pending":
        return { status: "unavailable", reason: "the bundle is not finalized yet" };
      case "unavailable":
        return { status: "unavailable", reason: reply.reason };
      case "refused":
        return { status: "refused", reason: reply.reason };
    }
  }
}

/**
 * The Macs to watch: those with a thread checkout active or recently active,
 * those the person opted in, and those with a watched build still open.
 * Never the machine running bb, which its own probe already covers.
 */
export function selectHostsToWatch(input: {
  scopeHosts: readonly string[];
  optIn: readonly string[];
  openRunHosts: readonly string[];
  serverHostId: string | null;
}): string[] {
  // Without bb's word on which machine this is, a Mac named in the setting
  // could be this one, watched twice over under two identities. Scopes are
  // already null-hosted then (`ScopeSync.hostOf`), so this costs nothing new.
  if (input.serverHostId === null) return [];
  const hosts = new Set([...input.scopeHosts, ...input.optIn, ...input.openRunHosts]);
  hosts.delete(input.serverHostId);
  return [...hosts].sort();
}

export interface RemoteWatchSettings {
  scanIntervalMs: number;
  scanProjects: boolean;
  retentionDays: number;
}

export interface RemoteWatchDeps {
  store: Store;
  engine: Engine;
  host: HostCaller;
  /** Other Macs with an active or recently active thread checkout. */
  scopeHosts(now: number): string[];
  /** Thread checkouts on one Mac, scanned there for DerivedData. */
  scopePaths(hostId: string): string[];
  /** Macs the person asked to always watch, as host ids. */
  optInHosts(): string[];
  serverHostId(): string | null;
  /** The project list this machine's collector keeps; never fetched again. */
  projects(): CollectorProject[];
  settings(): RemoteWatchSettings;
  publishSoon(): void;
  log: { debug(m: string): void; info(m: string): void; warn(m: string): void };
  isDisposed(): boolean;
  now?: () => number;
  /** Sweep cadences; tests shorten them. */
  timing?: { sweepPendingMs?: number; sweepIdleMs?: number; failureBaseMs?: number };
}

interface Watched {
  collector: Collector;
  controller: AbortController;
  done: Promise<void>;
}

export class RemoteWatch {
  private readonly watched = new Map<string, Watched>();
  private readonly now: () => number;

  constructor(private readonly deps: RemoteWatchDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** The Macs being watched right now. */
  hosts(): string[] {
    return [...this.watched.keys()];
  }

  /** A watched Mac's latest process snapshot; empty when it is not watched. */
  activitiesOn(hostId: string): readonly LiveActivity[] {
    return this.watched.get(hostId)?.collector.getLastActivities() ?? [];
  }

  /**
   * Start watching the Macs that should be, and stop the rest. A Mac that
   * stops being watched keeps its runs as they are; one with a build still
   * open never stops (see `selectHostsToWatch`).
   */
  reconcile(signal: AbortSignal): void {
    if (this.deps.isDisposed() || signal.aborted) return;
    const wanted = new Set(
      selectHostsToWatch({
        scopeHosts: this.deps.scopeHosts(this.now()),
        optIn: this.deps.optInHosts(),
        openRunHosts: this.deps.store.listHostsWithOpenWatchedRuns(),
        serverHostId: this.deps.serverHostId(),
      }),
    );
    for (const [hostId, entry] of this.watched) {
      if (wanted.has(hostId)) continue;
      entry.controller.abort();
      this.watched.delete(hostId);
      this.deps.log.debug(`stopped watching ${hostId}`);
    }
    for (const hostId of wanted) {
      if (this.watched.has(hostId)) continue;
      this.watch(hostId, signal);
    }
  }

  /** Stop every loop and wait for them to unwind. */
  async stop(): Promise<void> {
    const loops = [...this.watched.values()];
    this.watched.clear();
    for (const entry of loops) entry.controller.abort();
    await Promise.all(loops.map((entry) => entry.done));
  }

  /** One pass over one Mac: what `watch`'s loop does each turn. */
  private async pass(
    hostId: string,
    state: { lastDiscoverAt: number; lastSweepAt: number; pending: boolean },
    signal: AbortSignal,
  ): Promise<void> {
    const entry = this.watched.get(hostId);
    if (!entry) return;
    const collector = entry.collector;
    const now = this.now();
    if (now - state.lastDiscoverAt >= DISCOVER_EVERY_MS) {
      await collector.refreshProjects(now, signal);
      await collector.discoverRoots(now);
      state.lastDiscoverAt = now;
      state.lastSweepAt = 0;
    }
    if (signal.aborted) return;
    if (await collector.probeTick(this.now(), signal)) this.deps.publishSoon();
    if (signal.aborted) return;
    const sweepEvery = state.pending
      ? (this.deps.timing?.sweepPendingMs ?? SWEEP_PENDING_MS)
      : (this.deps.timing?.sweepIdleMs ?? SWEEP_IDLE_MS);
    if (this.now() - state.lastSweepAt >= sweepEvery) {
      state.lastSweepAt = this.now();
      const manifests = await collector.sweepManifests(this.now(), signal);
      if (signal.aborted) return;
      const bundles = await collector.sweepBundles(this.now(), signal);
      if ((manifests || bundles) && !signal.aborted) this.deps.publishSoon();
    }
    state.pending = this.deps.engine.hasOpenRuns(hostId);
  }

  private watch(hostId: string, parent: AbortSignal): void {
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    const settings = this.deps.settings();
    const collector = new Collector(
      {
        store: this.deps.store,
        engine: this.deps.engine,
        listProjects: async () => this.deps.projects(),
        log: this.deps.log,
        // Never read: another Mac's files are read on that Mac.
        dataDir: "",
        hostId,
        io: new RemoteMachine(
          this.deps.host,
          hostId,
          () => this.now() - this.deps.settings().retentionDays * 86_400_000,
          signal,
        ),
        scanPaths: () => this.deps.scopePaths(hostId),
      },
      { scanProjects: settings.scanProjects, extraRoots: [] },
    );
    const entry: Watched = { collector, controller, done: Promise.resolve() };
    this.watched.set(hostId, entry);
    this.deps.log.debug(`watching ${hostId}`);
    entry.done = this.loop(hostId, collector, signal);
  }

  private async loop(hostId: string, collector: Collector, signal: AbortSignal): Promise<void> {
    const state = { lastDiscoverAt: -Infinity, lastSweepAt: 0, pending: false };
    let failures = 0;
    while (!signal.aborted && !this.deps.isDisposed()) {
      const settings = this.deps.settings();
      collector.updateSettings({ scanProjects: settings.scanProjects, extraRoots: [] });
      // Real time spent, not the plugin's clock: this paces `setTimeout`.
      const startedAt = Date.now();
      try {
        await this.pass(hostId, state, signal);
        if (failures > 0) this.deps.log.info(`${hostId} is answering again`);
        failures = 0;
      } catch (error) {
        if (signal.aborted || this.deps.isDisposed()) break;
        failures += 1;
        // One line per outage, not per attempt.
        const log = failures === 1 ? this.deps.log.info : this.deps.log.debug;
        log(`could not watch builds on ${hostId}: ${String(error)}`);
      }
      const elapsed = Date.now() - startedAt;
      const cooldown =
        failures > 0
          ? Math.min(
              (this.deps.timing?.failureBaseMs ?? FAILURE_BASE_MS) * 2 ** (failures - 1),
              FAILURE_MAX_MS,
            )
          : Math.min(
              Math.max(settings.scanIntervalMs, elapsed * PROBE_DUTY_FACTOR),
              PROBE_MAX_SLEEP_MS,
            );
      await sleep(cooldown, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
