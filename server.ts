/**
 * Xcode activity tracker — backend, v2.
 *
 * Pure wiring. The rules live in `src/model.ts`, state in `src/store.ts`,
 * reconciliation in `src/engine.ts`, I/O in `src/collector.ts`, and each
 * surface in its own module: `src/cli.ts`, `src/tools.ts`, `src/dto.ts`,
 * `src/scope-sync.ts`, `src/thread-sync.ts`, `src/wrapped.ts`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { BbPluginApi } from "@bb/plugin-sdk";

import { XCODE_CHANNEL } from "./src/channel";
import { CLI_COMMANDS, createCli } from "./src/cli";
import { rpcContract } from "./src/contract";
import { Collector, type CollectorProject } from "./src/collector";
import { DtoMapper } from "./src/dto";
import { Engine } from "./src/engine";
import { VERDICT_STATUSES, type Run } from "./src/model";
import { createRpcHandlers } from "./src/rpc";
import { ScopeSync } from "./src/scope-sync";
import { pruneShimBundles, isShimInstalled } from "./src/shim";
import { safely, detach } from "./src/safe";
import { MIGRATIONS, Store, type Db } from "./src/store";
import { installSimulators, type SimulatorCliRun } from "./src/sim/wire";
import { CLI_COMMANDS as SIM_VERBS } from "./src/sim/cli";
import { SETTINGS_DESCRIPTORS as SIMULATOR_SETTINGS } from "./src/sim/settings";
import { ThreadSync } from "./src/thread-sync";
import { AGENT_INSTRUCTIONS, createTools } from "./src/tools";
import type { BuildPhase } from "./src/types";
import type { WrappedDeps } from "./src/wrapped";

/**
 * Share of wall-clock the process probe may consume. A tick costing 40s is
 * followed by an 80s pause, so the probe never exceeds a third of one core's
 * worth of the machine's attention no matter how slow `ps` becomes.
 */
const PROBE_DUTY_FACTOR = 2;
const PROBE_MAX_SLEEP_MS = 60_000;

/** Coalescing window for state-change publishes. */
const PUBLISH_THROTTLE_MS = 300;

const OPPORTUNISTIC_PRUNE_MS = 6 * 3_600_000;

/**
 * The simulator verbs, as one entry.
 *
 * bb validates command names against `[a-z0-9-]+`, so `sim devices` cannot be
 * registered as a name — and registering twenty `sim-<verb>` entries would bury
 * the tracker's own six in `bb xcode --help`. One line advertises the prefix,
 * and `bb xcode sim` with no arguments prints the verb list that
 * `src/sim/cli.ts` already writes for itself.
 */
const SIMULATOR_CLI_COMMANDS = [
  {
    name: "sim",
    summary: "Look at, and touch, an iOS simulator",
    usage: `bb xcode sim <verb>  (${SIM_VERBS.map((command) => command.name).join(", ")})`,
  },
];

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    scanIntervalSeconds: {
      type: "string",
      label: "Process scan interval (seconds)",
      default: "2",
    },
    retentionDays: {
      type: "string",
      label: "Keep history for (days)",
      default: "30",
    },
    bundleRetentionDays: {
      type: "string",
      label: "Keep result bundles for (days)",
      description:
        "Result bundles are directories, not rows: a test run's can be hundreds of megabytes, and one is written per build. Everything the tracker needs is extracted on the first sweep, so these only have to outlive that.",
      default: "2",
    },
    bundleBudgetGb: {
      type: "string",
      label: "Result bundle disk budget (GB)",
      description:
        "Hard ceiling on the bundle directory; the oldest are deleted first. Age alone cannot hold a line — an afternoon of snapshot tests can pass any sane budget well inside the age window.",
      default: "5",
    },
    scanProjects: {
      type: "boolean",
      label: "Scan project worktrees for DerivedData",
      default: true,
    },
    extraRoots: {
      type: "string",
      label: "Extra DerivedData roots (comma separated)",
      default: "",
    },
    // `bb.settings.define` is one call per plugin, so the Simulators half's
    // descriptors are spread in here rather than declared where they are read.
    // The key spaces are disjoint and asserted to be, in `test/sim/merge.test.ts`.
    ...SIMULATOR_SETTINGS,
  });

  const dataDir = join(homedir(), ".bb", "plugins", bb.pluginId);
  const db = bb.storage.database() as unknown as Db;
  bb.storage.migrate(db as never, [...MIGRATIONS]);
  const store = new Store(db);

  const positive = (raw: string, fallback: number, max = Infinity): number => {
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
  };

  const readSettings = async () => {
    const values = await settings.get();
    const interval = Number(values.scanIntervalSeconds);
    return {
      scanIntervalMs:
        Number.isFinite(interval) && interval >= 1
          ? Math.min(interval, 60) * 1000
          : 2000,
      retentionDays: positive(values.retentionDays, 30),
      bundleRetentionDays: positive(values.bundleRetentionDays, 2),
      bundleBudgetBytes: positive(values.bundleBudgetGb, 5) * 1024 ** 3,
      scanProjects: values.scanProjects,
      extraRoots: values.extraRoots
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  };

  let current = await readSettings();

  /**
   * Retention bookkeeping. Persisted so a string of short-lived instances
   * (dev reloads) does not re-prune on every boot; 0 when never pruned, which
   * makes the first probe pass after load prune immediately — the cron-only
   * schedule below fires at 04:23 and on a laptop that mostly never happens.
   */
  let lastPruneAt = (await bb.storage.kv.get<number>("last-prune-at")) ?? 0;

  let disposed = false;
  const isDisposed = (): boolean => disposed;
  /** Aborted on dispose: stops tailing live builds without killing them. */
  const detachRuns = new AbortController();

  /**
   * Every publish funnels through here, because most of them fire from work
   * that outlives this plugin instance: the tail loop of a wrapped build, the
   * continuation that folds its exit, the collector sweep. Publishing through
   * a disposed handle throws PluginContextStaleError, and from a detached
   * continuation Node raises that as an uncaughtException — which takes the
   * whole bb server down, not just this plugin. The collector loop already
   * re-checks its own abort signal for this reason; the wrapped-build paths
   * had no equivalent and crashed the server on 2026-08-10.
   */
  const publish = safely(isDisposed, (payload?: Record<string, unknown>) => {
    bb.realtime.publish(XCODE_CHANNEL, payload ?? { at: Date.now() });
  });

  /**
   * Coalesced state-change publish. Every bare publish means each open panel
   * refetches the full overview, and several sources fire in bursts (a probe
   * tick, a sweep and a scope backfill can all land within one second).
   * Collapsing them to at most one publish per 300ms bounds that
   * amplification without a subscriber ever seeing stale state for longer
   * than the throttle. The live-progress publish keeps its own payload path.
   */
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPublishAt = 0;
  const publishSoon = (): void => {
    if (disposed || publishTimer) return;
    const wait = Math.max(0, PUBLISH_THROTTLE_MS - (Date.now() - lastPublishAt));
    publishTimer = setTimeout(() => {
      publishTimer = null;
      lastPublishAt = Date.now();
      publish();
    }, wait);
  };

  /**
   * Logging carries the same guard, and for a sharper reason: `bb.log` throws
   * once stale, including from inside the very `catch` that was containing a
   * failure — turning a handled error into an unhandled rejection. Nothing in
   * this plugin calls `bb.log` directly.
   */
  const log = {
    debug: safely(isDisposed, (m: string) => bb.log.debug(m)),
    info: safely(isDisposed, (m: string) => bb.log.info(m)),
    warn: safely(isDisposed, (m: string) => bb.log.warn(m)),
    error: safely(isDisposed, (m: string) => bb.log.error(m)),
  };

  const listProjects = async (): Promise<CollectorProject[]> => {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const out: CollectorProject[] = [];
    for (const project of projects) {
      const sources =
        (project as { sources?: Array<{ path?: string }> }).sources ?? [];
      for (const source of sources) {
        if (source.path) {
          out.push({ id: project.id, name: project.name, path: source.path });
        }
      }
    }
    return out;
  };

  // ------------------------------------------------------------------ core

  // Engine and collector reference each other (engine asks the collector for
  // project attribution); a late-bound holder breaks the cycle for TS.
  let collectorRef: Collector | null = null;
  const scopeSync = new ScopeSync({
    store,
    getThread: (threadId) => bb.sdk.threads.get({ threadId }),
    getEnvironment: (environmentId) =>
      bb.sdk.environments.get({ environmentId }),
    log: (message) => log.debug(message),
    isDisposed,
    onChanged: publishSoon,
  });

  const engine: Engine = new Engine(store, {
    projectFor: (signals): string | null =>
      collectorRef ? collectorRef.projectFor(signals) : null,
    threadFor: (signals): string | null => scopeSync.scopes.threadFor(signals),
    log: (message) => log.debug(message),
  });
  const collector = new Collector(
    { store, engine, listProjects, log, dataDir },
    current,
  );
  collectorRef = collector;
  engine.hydrate(Date.now());

  const dto = new DtoMapper(store, engine, collector);

  const runRescan = (): void => {
    detach(
      async () => {
        if (await collector.fullScan(Date.now(), detachRuns.signal)) {
          publishSoon();
        }
      },
      (error) => log.warn(`scan failed: ${String(error)}`),
    );
  };

  // ------------------------------------------------------ thread reconciling

  const threadSync = new ThreadSync({
    engine,
    listEvents: (args) => bb.sdk.threads.events.list(args),
    kvGet: (key) => bb.storage.kv.get(key),
    kvSet: (key, value) => bb.storage.kv.set(key, value),
    log: (message) => log.debug(message),
    isDisposed,
    onChanged: publishSoon,
  });

  const unsubscribeThreadChanges = bb.sdk.subscribe({
    event: "thread:changed",
    callback(event) {
      if (
        disposed ||
        !event.id ||
        !(
          event.metadata?.eventTypes?.includes(
            "item/backgroundTask/completed",
          ) || event.metadata?.backgroundActivityChanged
        )
      ) {
        return;
      }
      detach(() => threadSync.reconcile(event.id!));
    },
  });

  // Backfill recent verdict-less runs, including cards already rendered in an
  // existing thread before this event consumer was installed.
  for (const threadId of new Set(
    store
      .listRuns({ limit: 500, includeNoise: true })
      .filter(
        (run) =>
          run.threadId &&
          !VERDICT_STATUSES.has(run.status) &&
          run.startedAt >= Date.now() - 24 * 3_600_000,
      )
      .map((run) => run.threadId!),
  )) {
    detach(() => threadSync.reconcile(threadId));
  }

  settings.onChange(async () => {
    if (disposed) return;
    const next = await readSettings();
    if (disposed) return;
    current = next;
    collector.updateSettings(current);
  });

  // -------------------------------------------------------- thread scopes
  //
  // There is no event for "an agent ran xcodebuild"; what bb DOES tell us is
  // when a thread starts a turn, and its environment names the exact checkout
  // any build it launches will run from. Registering that path as a scope
  // lets the probe attribute a new build to its thread on first sighting, and
  // lets the banner / agent tools answer for "this thread's build" instead of
  // the whole machine.

  bb.events.on("thread.active", ({ thread }) => {
    scopeSync.markActive(thread.id);
    detach(() => scopeSync.refresh(thread.id, true));
  });
  bb.events.on("thread.idle", ({ thread }) => scopeSync.deactivate(thread.id));
  bb.events.on("thread.failed", ({ thread }) => scopeSync.deactivate(thread.id));
  bb.events.on("thread.archived", ({ thread }) => {
    scopeSync.remove(thread.id);
    threadSync.forget(thread.id);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    scopeSync.remove(thread.id);
    threadSync.forget(thread.id);
  });

  // -------------------------------------------------------------- shim state

  /**
   * Shim install state, cached. `isShimInstalled` reads the shim script off
   * disk; `overview` is the panel's polling endpoint and must not do fs I/O
   * per call. Served from cache, refreshed detached when stale; the install/
   * uninstall CLI paths update it directly since they just learned the truth.
   */
  let shimInstalled: boolean | null = null;
  let shimCheckedAt = 0;
  const onShimStateKnown = (installed: boolean): void => {
    const changed = installed !== shimInstalled;
    shimInstalled = installed;
    shimCheckedAt = Date.now();
    if (changed) publishSoon();
  };
  const shimInstalledCached = (): boolean => {
    const now = Date.now();
    if (now - shimCheckedAt > 60_000) {
      shimCheckedAt = now;
      detach(async () => {
        const value = await isShimInstalled(dataDir);
        if (disposed) return;
        onShimStateKnown(value);
      });
    }
    return shimInstalled ?? false;
  };

  // Warm both caches off the handler path. Overview answers optimistically
  // until these land; the publish corrects any panel that asked too early.
  shimInstalledCached();
  detach(async () => {
    const available = await collector.isXcodeAvailable();
    if (disposed) return;
    if (!available) publishSoon();
  });

  // ---------------------------------------------------------- build wrapper

  const wrapped: WrappedDeps = {
    store,
    engine,
    collector,
    dataDir,
    detachSignal: detachRuns.signal,
    publishLive: (payload) => publish(payload),
    publishSoon,
    log,
    isDisposed,
  };

  /**
   * Runs the user has dismissed from the activity banner.
   *
   * The banner keeps the last settled run on screen so "how did that go"
   * outlives the build itself; this is the other half of that contract — an
   * explicit way to say "seen it". Persisted, because a dismissal that came
   * back on the next window reload would be worse than no dismissal at all.
   *
   * Loaded BEFORE the RPC handlers are registered: a handler that closed over
   * a `const` still in its temporal dead zone would throw if a call landed in
   * the await between the two.
   */
  const dismissedRuns = new Set(
    (await bb.storage.kv.get<string[]>("dismissed-runs")) ?? [],
  );
  const persistDismissedRuns = async (): Promise<void> => {
    const retained = [...dismissedRuns].slice(-500);
    if (retained.length !== dismissedRuns.size) {
      dismissedRuns.clear();
      for (const id of retained) dismissedRuns.add(id);
    }
    await bb.storage.kv.set("dismissed-runs", retained);
  };

  /**
   * What a live run is doing right now, for the text surfaces.
   *
   * The panel gets this through the DTO; the CLI and the agent tools deal in
   * `Run` rows, which carry no phase because it is derived from the process
   * tree rather than stored. Without it, `bb xcode status` on a build that is
   * seven minutes into a dependency fetch reads as a build that is seven
   * minutes into nothing.
   */
  const phaseFor = (run: Run): BuildPhase | null =>
    run.status === "running"
      ? engine.livePhase(
          run.id,
          engine.liveActivity(run.id, collector.getLastActivities()),
        )
      : null;

  const cli = createCli({
    store,
    collector,
    dataDir,
    projectName: (id) => dto.projectName(id),
    phaseFor,
    refreshProjectNames: () => dto.refreshProjectNames(),
    scopeFor: (threadId) => scopeSync.bounded(threadId),
    wrapped,
    onShimStateKnown,
    confirmHostAction: async (threadId, consent) => {
      try {
        const result = await bb.ui.requestInput({
          threadId,
          rendererId: "server-confirm",
          title: consent.title,
          payload: {
            facts: consent.facts,
            confirmLabel: consent.confirmLabel,
          },
          timeoutMs: 120_000,
        });
        return result.outcome === "submitted" && result.value === true;
      } catch {
        return false;
      }
    },
  });

  // ------------------------------------------------------------------- RPC

  bb.rpc.register(
    rpcContract,
    createRpcHandlers({
      store,
      collector,
      dto,
      scopeSync,
      dataDir,
      dismissedRuns,
      persistDismissedRuns,
      shimInstalledCached,
      rescan: runRescan,
      publishSoon,
      detach: (work) => detach(work),
    }),
  );

  // ------------------------------------------------------------- simulators

  /**
   * The Simulators half, installed with everything it cannot own itself.
   *
   * It registers its own RPC contract, HTTP routes, agent tools, live service
   * and prune schedule; the four things below are the ones the SDK allows only
   * one of per plugin, plus the simulator list the tracker is already polling.
   *
   * A failure here is contained on purpose. Live mirroring is not what this
   * plugin is for — a Mac with no simulator runtimes, or a `serve-sim` addon
   * that will not load, must not stop builds from being tracked.
   */
  let simulatorCli: SimulatorCliRun | null = null;
  let simulatorInstructions: string | null = null;
  try {
    await installSimulators(bb, {
      db,
      settings,
      mountCli: (run) => {
        simulatorCli = run;
      },
      contributeInstructions: (text) => {
        simulatorInstructions = text;
      },
      // The tracker polls `simctl list` anyway, to turn `id=<UDID>` in a build
      // row into "iPhone 17 Pro · iOS 26.5". Reusing that answer is why the
      // merged plugin spawns one simctl poller instead of two.
      bootedSimulators: () =>
        collector.getBootedSimulators().map((sim) => ({
          udid: sim.udid,
          name: sim.name,
          os: sim.os,
        })),
      // The same rows the panel renders as build history, read for the one
      // field the simulator picker cares about. No new query shape, no new
      // index, and it is already sorted newest-first.
      recentDestinations: (limit) =>
        store.listRuns({ limit, includeNoise: true }).map((run) => ({
          destination: run.destination,
          startedAt: run.startedAt,
          threadId: run.threadId,
          projectId: run.projectId,
        })),
    });
  } catch (error) {
    log.warn(`simulators unavailable: ${String(error)}`);
  }

  // -------------------------------------------------------------- services

  bb.background.service("probe", {
    async start(signal) {
      await collector.isXcodeAvailable().catch(() => false);
      await collector.fullScan(Date.now(), signal).catch((error: unknown) => {
        log.warn(`initial scan failed: ${String(error)}`);
      });
      if (signal.aborted) return;
      publishSoon();

      let sinceSweep = 0;
      // The moment a run leaves `running`, sweep soon after: the log store and
      // shim bundle land within a couple of seconds of process exit.
      let pendingVerdicts = false;

      let failures = 0;
      let backedOff = false;
      while (!signal.aborted) {
        const tickStartedAt = Date.now();
        try {
          const changed = await collector.probeTick(Date.now(), signal);
          // A sweep can run for a minute; without these re-checks a reload
          // mid-sweep lets the publish below fire on a disposed handle.
          if (signal.aborted) break;
          if (changed) publishSoon();

          const open = engine.hasOpenRuns();
          sinceSweep += current.scanIntervalMs;
          const due = pendingVerdicts
            ? sinceSweep >= 4_000
            : sinceSweep >= 30_000;
          if (due) {
            sinceSweep = 0;
            const swept = await collector.fullScan(Date.now(), signal);
            if (signal.aborted) break;
            if (swept) publishSoon();
            pendingVerdicts = engine.hasOpenRuns();
          } else if (open) {
            pendingVerdicts = true;
          }
          // Opportunistic retention: the 04:23 cron only fires if bb happens
          // to be awake then, which on this machine it never was — the db held
          // fourteen MONTHS of runs against a 30-day retention setting. The
          // probe loop is already background work, so piggyback on it.
          if (Date.now() - lastPruneAt > OPPORTUNISTIC_PRUNE_MS) {
            lastPruneAt = Date.now();
            detach(runPrune, (error) =>
              log.warn(`opportunistic prune failed: ${String(error)}`),
            );
          }
          failures = 0;
        } catch (error: unknown) {
          failures = Math.min(failures + 1, 5);
          log.warn(`probe tick failed: ${String(error)}`);
        }
        /**
         * Sleep proportionally to what the tick just cost.
         *
         * The old rule backed off only on thrown errors, so a tick that
         * SUCCEEDED slowly reset the counter and slept the flat 2s interval.
         * On a machine at load average 795 — four parallel snapshot suites and
         * a pile of orphaned simulator runtimes — a single `ps -A` took tens
         * of seconds, so the probe ran a ~100% duty cycle against a host that
         * could least afford it, and its own handlers were measured at 38.3s.
         * The plugin then goes `degraded`, which deactivates its frontend and
         * makes the activity row vanish: starved by the very builds it exists
         * to report on.
         *
         * Holding the probe to a fixed share of wall-clock makes it
         * self-limiting — the busier the machine, the quieter the plugin gets,
         * with no threshold to tune and no health check to get wrong.
         */
        const elapsed = Date.now() - tickStartedAt;
        const cooldown =
          failures > 0
            ? Math.min(current.scanIntervalMs * 2 ** failures, PROBE_MAX_SLEEP_MS)
            : Math.min(
                Math.max(current.scanIntervalMs, elapsed * PROBE_DUTY_FACTOR),
                PROBE_MAX_SLEEP_MS,
              );
        if (cooldown > current.scanIntervalMs && failures === 0) {
          if (!backedOff) {
            backedOff = true;
            log.info(
              `probe tick took ${elapsed}ms; backing off to ${cooldown}ms while the host is loaded`,
            );
          }
        } else if (backedOff && failures === 0) {
          backedOff = false;
          log.info("probe tick back to normal cadence");
        }
        await sleep(cooldown, signal);
      }
    },
  });

  bb.background.schedule("discover", "*/10 * * * *", () => {
    // A sweep may spend up to 60s in xcresulttool for each bundle. Keeping
    // that work inside the schedule callback made the host measure a 27s
    // handler and could push the whole plugin into an error state. The
    // schedule only triggers the sweep; the collector owns its lifetime.
    runRescan();
  });

  const runPrune = async (): Promise<void> => {
    if (disposed) return;
    const now = Date.now();
    lastPruneAt = now;
    const bundles = await pruneShimBundles(
      dataDir,
      {
        maxAgeMs: current.bundleRetentionDays * 86_400_000,
        maxTotalBytes: current.bundleBudgetBytes,
      },
      now,
    );
    if (disposed) return;
    const cutoff = now - current.retentionDays * 86_400_000;
    const removed = store.prune(cutoff);
    const orphans = store.pruneOrphans();
    // Roots were never pruned (stale ones make every sweep slower forever),
    // and the WAL was never checkpointed — the visible "4.8MB db" was 82% WAL.
    store.pruneRoots(cutoff);
    store.checkpoint();
    await bb.storage.kv.set("last-prune-at", now);
    if (bundles.removed > 0) {
      log.info(
        `pruned ${bundles.removed} result bundle(s), freeing ${formatBytes(bundles.bytesFreed)} (${formatBytes(bundles.bytesRetained)} retained)`,
      );
    }
    if (removed > 0 || orphans > 0) {
      log.info(
        `pruned ${removed} run(s) and ${orphans} orphaned row(s) past retention`,
      );
    }
    if (removed > 0 || orphans > 0 || bundles.removed > 0) publishSoon();
  };

  bb.background.schedule("prune", "23 4 * * *", () => {
    // Detached like discover: pruning a large backlog plus a WAL checkpoint
    // is real work, and schedule callbacks are measured as handlers.
    detach(runPrune, (error) => log.warn(`scheduled prune failed: ${String(error)}`));
  });

  // ------------------------------------------------------------------- CLI

  bb.cli.register({
    name: "xcode",
    summary: "Track Xcode builds and tests, and drive the simulators they run on",
    commands: [...CLI_COMMANDS, ...SIMULATOR_CLI_COMMANDS],
    run: (argv, ctx) => {
      // `bb xcode sim <verb>` — one `cli.register` per plugin, so the
      // simulator verbs hang off this dispatch rather than owning `bb sims`.
      // They keep their own argv from the verb onwards, so every parser in
      // `src/sim/cli.ts` is untouched by living one level deeper.
      if (argv[0] === "sim" || argv[0] === "sims") {
        if (simulatorCli === null) {
          return {
            exitCode: 1,
            stderr: "Simulators are not available on this server.\n",
          };
        }
        return simulatorCli(argv.slice(1), ctx);
      }
      return cli.dispatch([...argv], ctx);
    },
  });

  // ----------------------------------------------------------- agent tools

  // Tool instructions only reach sessions where the provider is given that
  // native tool. Builds also arrive through repo scripts, xcodebuildmcp, and
  // provider-native shell tools, so make the card contract part of every
  // ordinary thread's resolved instructions as well.
  // One call per plugin, so both halves are joined here. The simulator half
  // contributes only when its tools were actually registered, which is why this
  // reads the variable rather than the module constant.
  bb.agents.contributeInstructions(() =>
    simulatorInstructions === null
      ? AGENT_INSTRUCTIONS
      : `${AGENT_INSTRUCTIONS}\n\n${simulatorInstructions}`,
  );

  const tools = createTools({
    store,
    collector,
    dataDir,
    wrapped,
    refreshProjectNames: () => dto.refreshProjectNames(),
    projectName: (id) => dto.projectName(id),
    phaseFor,
    scopeFor: (threadId) => scopeSync.bounded(threadId),
    showRun: (id) => cli.show(id),
  });

  bb.agents.registerTool(tools.status);
  bb.agents.registerTool(tools.lastFailure);
  bb.agents.registerTool(tools.build);

  bb.onDispose(() => {
    // Order matters: flip the flag before detaching, so anything the tail
    // loop has already queued finds `disposed` true when it lands.
    log.debug("xcode tracker disposed");
    unsubscribeThreadChanges();
    disposed = true;
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    detachRuns.abort();
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)}${units[unit]}`;
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
