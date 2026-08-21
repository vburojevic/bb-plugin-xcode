/**
 * Simulator wiring — everything the Simulators half of this plugin registers.
 *
 * Installed by `server.ts` with one call, so the tracker's own wiring stays
 * readable and the two halves share exactly three things on purpose: the
 * database, the settings handle, and the collector's simulator list.
 *
 * Rules live in `src/model.ts`, state in `src/store.ts` and `src/frames.ts`,
 * I/O in named drivers, each surface in its own module — which is what makes
 * the interesting logic unit-testable without a bb server or a Mac.
 *
 * The staleness discipline is not optional here. A `bb` handle captured before
 * a reload throws `PluginContextStaleError` on use, and from a detached
 * continuation Node raises that as an `uncaughtException` that takes the whole
 * bb server down. Every `bb.*` call that can outlive this load goes through
 * `safely`, and every fire-and-forget through `detach`.
 */
import type { BbPluginApi } from "@bb/plugin-sdk";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { rpcContract } from "./contract.js";
import { CHANNEL } from "./channel.js";
import { prepareConnection } from "./store.js";
import { dataDirOf, framesRootOf, type Ctx, type ThreadScope } from "./context.js";
import { FrameStore } from "./framestore.js";
import { getFrame, getLook, linkThread, listVerdicts, totalBytes } from "./frames.js";
import type { Db } from "./store.js";
import { contentTypeOf } from "./image.js";
import { FRAME_ID_PATTERN, LOOK_ID_PATTERN } from "./model.js";
import { DeviceDriver } from "./devices.js";
import { LiveService } from "./live.js";
import { makeRpcHandlers } from "./rpc.js";
import { makeCli } from "./cli.js";
import { normalizeSettings, type RawSettings, type Settings } from "./settings.js";
import { defaultDeps, platformProbe, runPreflight, type Preflight } from "./preflight.js";
import { resolveSimHostPath } from "./sim-host-sup.js";
import { gitHead, resolveScope } from "./scope.js";
import { locateCheckout, describeCheckoutLocation, resolveServerHostId } from "./hostcheck.js";
import { LeaseRegistry } from "./lease.js";
import { DeviceQueue } from "./queue.js";
import { runAndCompare, summarizeLook } from "./stills-rpc.js";
import { detectProject, findCandidates, shapeOf } from "./onboard.js";
import { DetectCache } from "./detect-cache.js";
import { deviceKey } from "./model.js";
import { findDeviceByNameOrUdid, pickDefaultDevice } from "./devices.js";
import { GLOBAL_INSTRUCTIONS, makeCaptureTool, makeDriveTool, makeStillsTool } from "./tools.js";
import { applyPrune, planPrune, sweepLegacyStillsResults, sweepServeSimLogs } from "./prune.js";
import { DEMO_TTL_MS, type DemoState } from "./demos.js";
import { coalesce, detach, safely } from "./safe.js";
import * as simhost from "./sim-host-client.js";
import type { RunDestination } from "./pick.js";
import {
  ConnectionLimit,
  MAX_PANEL_PRESENCES,
  MAX_PANEL_STREAMS,
} from "./connection-limit.js";
import {
  makePresenceRouteHandler,
  makeStreamRouteHandler,
  type PrivateStreamRouteDeps,
} from "./private-stream-routes.js";

export { rpcContract };

/** Realtime publishes are coalesced onto this floor; see `src/safe.ts`. */
const PUBLISH_FLOOR_MS = 300;

/**
 * What the Simulators half needs from the tracker half.
 *
 * Deliberately four things, not a handle to everything. Three of them exist
 * because the SDK allows exactly one of each per plugin — one migration array,
 * one `settings.define`, one `cli.register` — so they cannot be owned here.
 * The fourth, `bootedSimulators`, is the interesting one: the tracker already
 * polls `simctl list` to resolve `id=<UDID>` destinations in build rows, so
 * asking it costs nothing where a second poller would cost a spawn every few
 * seconds for the same answer.
 */
export interface SimulatorHost {
  /** Already migrated by `server.ts`; this side only sets its pragmas. */
  db: unknown;
  /**
   * The single settings handle, which carries both halves' descriptors.
   *
   * Typed at the shape this side reads rather than at the host's full union:
   * the tracker's keys are none of this module's business, and `RawSettings`
   * is already the "everything is a string, a boolean, or absent" view that
   * `normalizeSettings` is written against.
   */
  settings: {
    get(): Promise<RawSettings>;
    onChange(handler: (next: RawSettings) => void): void;
  };
  /** Mounts the simulator verbs under `bb xcode sim <verb>`. */
  mountCli(run: SimulatorCliRun): void;
  /**
   * Adds this half's paragraph to the plugin's single instruction block.
   *
   * Called only when the agent tools are actually registered, so a machine
   * where they are switched off does not tell every thread how to use tools it
   * does not have.
   */
  contributeInstructions(text: string): void;
  /** The tracker's simulator list, polled for destination labels anyway. */
  bootedSimulators(): ReadonlyArray<{ udid: string; name: string; os: string }>;
  /**
   * Recent builds, newest first, with the destination each one targeted.
   *
   * This is the evidence `pickSimulator` ranks highest: the tracker already
   * parses `-destination` off every `xcodebuild` process it sees and attributes
   * the run to a thread, so "which simulator does this thread mean" is a
   * question the tracker half has been answering all along without being asked.
   */
  recentDestinations(limit: number): readonly RunDestination[];
}

export type SimulatorCliRun = (
  argv: string[],
  ctx: Parameters<ReturnType<typeof makeCli>>[1],
) => ReturnType<ReturnType<typeof makeCli>>;

export async function installSimulators(bb: BbPluginApi, host: SimulatorHost): Promise<void> {
  let disposed = false;
  const isDisposed = (): boolean => disposed;

  const log = (level: "info" | "warn" | "error", message: string): void => {
    safely(isDisposed, () => bb.log[level](message));
  };

  // ---------------------------------------------------------------------------
  // Platform first, before anything else is registered
  // ---------------------------------------------------------------------------

  // bb supports a Linux server with enrolled Macs — which is why
  // `bb.sdk.terminals` takes an explicit `{ kind: "host_path", hostId }` scope.
  // Without this check that topology gets told to run `xcode-select --install`.
  const platform = platformProbe(process.platform);
  if (platform.state === "blocked") {
    bb.status.needsConfiguration(platform.detail);
    return;
  }

  // ---------------------------------------------------------------------------
  // Settings, storage, preflight
  // ---------------------------------------------------------------------------

  const settingsApi = host.settings;
  let settings: Settings = normalizeSettings(await settingsApi.get());
  // The host has already migrated: `bb.storage.migrate` keys by statement
  // index across the whole plugin, so there is exactly one array and it lives
  // in `src/store.ts`. Only the pragmas are ours.
  const db = host.db as unknown as ReturnType<BbPluginApi["storage"]["database"]>;
  prepareConnection(db);

  const dataDir = dataDirOf(db);
  const framesRoot = framesRootOf(db);
  const store = new FrameStore(framesRoot);

  // Probed on first use, not at load: the probes cost a few seconds of child
  // processes and nothing needs them until someone opens the doctor. Memoized
  // on the in-flight promise so two panels mounting together share one sweep.
  // Two above `src/sim/`, so this is the plugin root either way — bundled at
  // `dist/server.js` or evaluated from source.
  const preflightDeps = defaultDeps(new URL("../../", import.meta.url).pathname);
  let preflight: Promise<Preflight> | null = null;
  const getPreflight = (): Promise<Preflight> => {
    preflight ??= runPreflight(preflightDeps);
    return preflight;
  };
  const refreshPreflight = (): Promise<Preflight> => {
    preflight = runPreflight(preflightDeps);
    return preflight;
  };

  // ---------------------------------------------------------------------------
  // Realtime, coalesced
  // ---------------------------------------------------------------------------

  const pending = new Set<"look" | "live">();
  const flush = coalesce(PUBLISH_FLOOR_MS, () => {
    const kinds = [...pending];
    pending.clear();
    for (const kind of kinds) {
      safely(isDisposed, () => bb.realtime.publish(CHANNEL, { kind }));
    }
  });
  const publish = (kind: "look" | "live"): void => {
    if (disposed) return;
    pending.add(kind);
    flush.schedule();
  };

  // ---------------------------------------------------------------------------
  // The live surface
  // ---------------------------------------------------------------------------

  const driver = new DeviceDriver();
  const simHost = resolveSimHostPath(import.meta.url);
  log("info", `capture host at ${simHost.path}`);
  const live = new LiveService({
    driver,
    spawn: () => ({
      // In the packaged desktop build this is the Electron binary, which
      // behaves as Node only while ELECTRON_RUN_AS_NODE is set — see
      // `startSimHost`, which sets it unconditionally.
      execPath: process.execPath,
      simHostPath: simHost.path,
      env: process.env,
    }),
    allowIntelLive: () => settings.allowIntelLive,
    defaultDevice: () => settings.defaultDevice,
    isAppleSilicon: process.arch === "arm64",
    isMac: true,
    log,
    publish: () => publish("live"),
  });

  // The lease is keyed on the device, because the device is the contended
  // resource: `stillsDevice` is one shared UDID by design, and two callers with
  // different scopes still drive the same simulator.
  const leases = new LeaseRegistry(() => live.currentDevice()?.name ?? "the simulator");

  // The stills queue is keyed on the device UDID rather than the project: the
  // contended resource is the simulator, and `stillsDevice` is one shared UDID
  // by design, so two projects rendering at once would otherwise both pass a
  // scope-keyed in-flight check and drive the same device.
  const queue = new DeviceQueue();

  /**
   * Project detection, cached and refreshed in the background.
   *
   * Measured at 47 seconds for one `xcodebuild -list` on a project with package
   * dependencies, inside a handler the Stills panel calls on every mount. A
   * handler must never wait on that; the panel gets what is known and a signal
   * when more arrives.
   */
  const detection = new DetectCache(
    (request) =>
      detectProject(
        request.checkoutPath,
        { shape: shapeOf(request.relPath.split("/").pop() ?? "") ?? "unknown", relPath: request.relPath },
        request.scheme,
      ),
    () => publish("look"),
  );

  // ---------------------------------------------------------------------------
  // Scope resolution, cached per thread
  // ---------------------------------------------------------------------------

  const scopeCache = new Map<string, ThreadScope | null>();

  // Registered here rather than beside `settings.get()`, so it closes over
  // caches that already exist: a settings save can arrive at any time, and a
  // handler referencing a binding from a later line is a hazard waiting for a
  // race to find it.
  settingsApi.onChange((next) => {
    if (disposed) return;
    const previous = settings;
    settings = normalizeSettings(next);
    // A changed project path or scheme makes every cached detection wrong.
    if (previous.projectPath !== settings.projectPath || previous.scheme !== settings.scheme) {
      detection.clear();
      scopeCache.clear();
      publish("look");
    }
  });


  const scopeForThread = async (threadId: string | null): Promise<ThreadScope | null> =>
    scopeForInvocation(threadId === null ? {} : { threadId });

  /**
   * The scope, from whatever the caller knew.
   *
   * Order matters and was arrived at by getting it wrong: a bare
   * `bb xcode sim onboard` in a terminal has no thread, so falling straight through
   * to "bb's first project" made it analyse a completely different repository
   * from the one the user was standing in. `cwd` is the strongest evidence a
   * terminal invocation carries.
   */
  const scopeForInvocation = async (hints: {
    threadId?: string;
    projectId?: string;
    cwd?: string;
  }): Promise<ThreadScope | null> => {
    const cacheKey = `${hints.threadId ?? ""}|${hints.projectId ?? ""}|${hints.cwd ?? ""}`;
    const cached = scopeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const resolved = await resolveScopeFor(hints);
    if (disposed) return resolved;
    scopeCache.set(cacheKey, resolved);
    return resolved;
  };

  const resolveScopeFor = async (hints: {
    threadId?: string;
    projectId?: string;
    cwd?: string;
  }): Promise<ThreadScope | null> => {
    try {
      const projects = await bb.sdk.projects.list();
      const hasHint = hints.threadId !== undefined || hints.projectId !== undefined || hints.cwd !== undefined;

      let projectId: string | null = null;
      let environmentId: string | null = null;
      if (hints.threadId !== undefined) {
        const thread = await bb.sdk.threads.get({ threadId: hints.threadId });
        projectId = thread.projectId;
        environmentId = thread.environmentId;
        if (hints.projectId !== undefined && hints.projectId !== projectId) return null;
      } else if (hints.projectId !== undefined) {
        projectId = hints.projectId;
      } else if (hints.cwd !== undefined) {
        // The project whose source directory contains the caller's cwd. The
        // longest matching root wins, so a project nested inside another
        // resolves to the inner one.
        const matches = projects
          .flatMap((project) => project.sources.map((source) => ({ project, path: source.path })))
          .filter(({ path }) => hints.cwd === path || hints.cwd!.startsWith(`${path}/`))
          .sort((a, b) => b.path.length - a.path.length);
        projectId = matches[0]?.project.id ?? null;
      }
      // Only a trusted panel call has no hints. An agent-facing CLI call with a
      // bad cwd must fail closed instead of widening to whichever project bb
      // happens to list first.
      if (projectId === null && !hasHint) projectId = projects[0]?.id ?? null;
      if (projectId === null) return null;

      let checkoutPath: string | null = null;
      let hostId: string | null = null;
      if (environmentId !== null) {
        // A thread's environment is the authority: bb creates a per-thread git
        // worktree, so this is where the code actually is.
        const environment = await bb.sdk.environments.get({ environmentId });
        checkoutPath = environment.path;
        hostId = environment.hostId;
      }
      if (checkoutPath === null) {
        // No environment — fall back to the project's default source.
        const project = projects.find((entry) => entry.id === projectId);
        const source = project?.sources.find((entry) => entry.isDefault) ?? project?.sources[0];
        checkoutPath = source?.path ?? null;
        hostId = source?.hostId ?? null;
      }
      if (checkoutPath === null) return null;
      if (hints.cwd !== undefined) {
        const rel = relative(resolve(checkoutPath), resolve(hints.cwd));
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
      }

      const projectPath =
        settings.projectPath === ""
          ? null
          : `${checkoutPath.replace(/\/+$/, "")}/${settings.projectPath.replace(/^\/+/, "")}`;
      const scope = await resolveScope({ checkoutPath, projectPath, projectId });

      // Where the checkout lives matters for Stills, which builds on the
      // server's own filesystem. Live is unaffected: it needs no checkout.
      const hosts = await bb.sdk.hosts.list();
      const summaries = hosts.map((host) => ({ id: host.id, name: host.name }));
      const resolvedHostId = await resolveHostId();

      return {
        scope,
        projectId,
        checkoutElsewhere: describeCheckoutLocation(
          locateCheckout(resolvedHostId, hostId, summaries),
        ),
      };
    } catch (error) {
      log("warn", `could not resolve the project scope: ${describe(error)}`);
      return null;
    }
  };

  // ---------------------------------------------------------------------------
  // The context every surface is built from
  // ---------------------------------------------------------------------------

  /**
   * Resolve everything a render needs, then put it on the device queue.
   *
   * Resolution happens *here* rather than inside the queued job, so the job
   * closes over facts rather than over `bb`, which may be stale by the time
   * the queue reaches it. Every refusal is a sentence naming what to do next:
   * "could not run" for a project with twelve schemes is a dead end, and
   * naming the twelve is not.
   */
  const startStills = async (
    scope: ThreadScope,
    deviceQuery: string | null,
  ): Promise<{ handle: { lookId: string | null; queued: number }; promise: Promise<string> }> => {
      // Stills builds on the server's own filesystem; Live does not care.
      if (scope.checkoutElsewhere !== null) throw new Error(scope.checkoutElsewhere);

      const devices = await driver.list();
      const wanted = deviceQuery ?? settings.stillsDevice;
      const device =
        wanted.trim() === "" ? pickDefaultDevice(devices) : findDeviceByNameOrUdid(devices, wanted);
      if (device === null) {
        throw new Error(
          wanted.trim() === ""
            ? "No simulator to render on. Install an iOS runtime in Xcode → Settings → Components."
            : `No simulator matched "${wanted}".`,
        );
      }

      const candidates = await findCandidates(scope.scope.checkoutPath);
      const candidate =
        settings.projectPath === ""
          ? candidates[0]
          : candidates.find((entry) => entry.relPath === settings.projectPath);
      if (candidate === undefined) {
        throw new Error(
          settings.projectPath === ""
            ? "No Xcode project found under this checkout. Set projectPath if it lives somewhere unusual."
            : `No Xcode project at ${settings.projectPath}.`,
        );
      }

      const project = await detectProject(scope.scope.checkoutPath, candidate, settings.scheme);
      const scheme = project.scheme;
      if (scheme === null) {
        // Twelve schemes must not silently resolve to one.
        throw new Error(
          project.schemes.length === 0
            ? `xcodebuild reported no schemes for ${project.relPath}.`
            : `${project.relPath} has ${project.schemes.length} schemes. Set the scheme setting to one of: ${project.schemes.join(", ")}.`,
        );
      }
      if (project.snapshotTestTarget === null) {
        throw new Error(
          "Stills needs a hosted unit-test target linking SnapshottingTests. Run `bb xcode sim onboard` to see the exact changes.",
        );
      }

      const head = await gitHead(scope.scope.checkoutPath);
      const probes = await getPreflight();
      const scale = 3;
      const derived = join(dataDir, "derived", scope.scope.scopeKey);
      const key = deviceKey({
        name: device.name,
        osVersion: device.osVersion,
        scale,
        arch: process.arch,
      });

      const enqueued = queue.enqueue({
        key: { udid: device.udid, scopeKey: scope.scope.scopeKey, deviceKey: key },
        run: (signal) =>
          runAndCompare(
            ctx,
            {
              scopeKey: scope.scope.scopeKey,
              projectId: scope.projectId,
              checkoutPath: scope.scope.checkoutPath,
              device: { udid: device.udid, name: device.name, osVersion: device.osVersion },
              scale,
              commitSha: head.commitSha,
              branch: head.branch,
              target: {
                projectRelPath: project.relPath,
                shape: project.shape,
                scheme,
                // Composed from the device inside the run.
                destination: "",
                derivedDataPath: derived,
                resultBundlePath: join(derived, "results"),
              },
              testTargetName: project.snapshotTestTarget,
              odiffPath: probes.odiffPath,
              globalThreshold: settings.diffThreshold,
            },
            signal,
          ),
      });

      detach(
        () =>
          enqueued.promise.then((lookId) => {
            // Link the finished run to whichever thread was active when it
            // started, then take the chance to prune.
            //
            // Both of these were written and then never called — the stricter
            // typecheck of the merged plugin is what surfaced it. The link is
            // the one that mattered: a linked look is exempt from retention,
            // so without this the run a thread's banner is pointing at could
            // be pruned out from under the banner still showing it.
            if (lookId !== "") linkRunToThread(scope.projectId, lookId);
            pruneIfDue();
          }),
        (error) => log("error", `stills run failed: ${describe(error)}`),
      );
      return { handle: { lookId: null, queued: enqueued.queued }, promise: enqueued.promise };
  };

  /**
   * The host id of the machine running bb, resolved once.
   *
   * The `Host` DTO carries no "this is the server's own host" flag, so it is
   * derived by writing a nonce file under the plugin's own data directory and
   * asking each host whether that exact absolute path exists. Cached in kv, so
   * it survives a reload.
   */
  let serverHostId: string | null = null;
  const resolveHostId = async (): Promise<string | null> => {
    if (serverHostId !== null) return serverHostId;
    const hosts = await bb.sdk.hosts.list();
    serverHostId = await resolveServerHostId({
      pluginDataDir: dataDir,
      listHosts: async () => hosts.map((host) => ({ id: host.id, name: host.name })),
      pathsExist: async (id, paths) => (await bb.sdk.hosts.pathsExist({ hostId: id, paths })).existence,
      kvGet: async (key) => (await bb.storage.kv.get<string>(key)) ?? null,
      kvSet: async (key, value) => bb.storage.kv.set(key, value),
    });
    return serverHostId;
  };

  /**
   * Which thread most recently ran in a project.
   *
   * A run started from the panel has no thread of its own, and the banner is
   * per thread — so the run is linked to the thread that was last active in the
   * same project. It is a heuristic, and the honest one: the alternative is a
   * banner that never appears for anyone who used the panel rather than a tool.
   */
  const lastActiveThread = new Map<string, { threadId: string; at: number }>();
  /** Older than this and it was somebody else's session. */
  const THREAD_LINK_WINDOW_MS = 30 * 60_000;

  const rememberThread = (thread: { id: string; projectId: string }): void => {
    lastActiveThread.set(thread.projectId, { threadId: thread.id, at: Date.now() });
  };
  bb.events.on("thread.active", ({ thread }) => rememberThread(thread));
  bb.events.on("thread.idle", ({ thread }) => rememberThread(thread));

  const linkRunToThread = (projectId: string, lookId: string): void => {
    const recent = lastActiveThread.get(projectId);
    if (recent === undefined || Date.now() - recent.at > THREAD_LINK_WINDOW_MS) return;
    // A linked look is also exempt from pruning, which is the point: a record
    // someone is being shown must not vanish underneath the banner showing it.
    linkThread(db, recent.threadId, lookId, Date.now());
  };

  // Host-owned confirmations are serialized so two destructive prompts cannot
  // race each other in one thread.
  let hostConfirmationInFlight = false;

  const confirmInThread = async (
    threadId: string,
    consent: { title: string; facts: string[]; confirmLabel: string },
  ): Promise<boolean> => {
    try {
      const result = await bb.ui.requestInput({
        threadId,
        rendererId: "server-confirm",
        title: consent.title,
        payload: { facts: consent.facts, confirmLabel: consent.confirmLabel },
        timeoutMs: 120_000,
      });
      return result.outcome === "submitted" && result.value === true;
    } catch (error) {
      log("warn", `consent request failed: ${describe(error)}`);
      return false;
    }
  };

  const confirmationThread = (hints: { threadId?: string | null; projectId?: string | null }): string | null => {
    if (typeof hints.threadId === "string" && hints.threadId !== "") return hints.threadId;
    if (typeof hints.projectId !== "string" || hints.projectId === "") return null;
    const recent = lastActiveThread.get(hints.projectId);
    if (recent === undefined || Date.now() - recent.at > THREAD_LINK_WINDOW_MS) return null;
    return recent.threadId;
  };

  let demoState: DemoState | null = null;
  let reserveFrameBytes: (incomingBytes: number) => Promise<void> = async () => {};

  const ctx: Ctx = {
    pluginId: bb.pluginId,
    db,
    dataDir,
    framesRoot,
    store,
    settings: () => settings,
    preflight: getPreflight,
    refreshPreflight,
    live,
    driver,
    leases: {
      acquire: (threadId) => {
        const device = live.currentDevice();
        return leases.acquire(device?.udid ?? "none", threadId);
      },
    },
    log,
    publish,
    scopeForThread,
    scopeForInvocation,
    gitHead,
    recentDestinations: (limit) => host.recentDestinations(limit),

    rawSettings: () => settingsApi.get(),

    async writeSetting(key, value) {
      await bb.sdk.plugins.updateSettings({ pluginId: bb.pluginId, values: { [key]: value } });
    },

    /**
     * The machine dimension, for the device picker. Failure-tolerant by
     * contract: a hosts API that cannot answer must not take the device list
     * down with it — the picker simply shows no machine line.
     */
    async machines() {
      try {
        const [hosts, serverId] = await Promise.all([bb.sdk.hosts.list(), resolveHostId()]);
        const current = hosts.find((entry) => entry.id === serverId)?.name ?? null;
        const others = hosts
          .filter((entry) => entry.id !== serverId)
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b));
        return { current, others };
      } catch {
        return { current: null, others: [] };
      }
    },
    beforeFrameImport: (incomingBytes) => reserveFrameBytes(incomingBytes),

    /**
     * Write a frame to a path on the machine that invoked the CLI.
     *
     * `run` executes on the server, so `--out ./shot.jpg` names a file in the
     * *caller's* working directory. Resolving the invoking host and going
     * through `bb.sdk.files` is the difference between writing where the user
     * is looking and writing somewhere they will never find.
     */
    async writeToInvokingHost(threadId, path, rootPath, frameId) {
      const frame = getFrame(db, frameId);
      const look = frame === null ? null : getLook(db, frame.lookId);
      if (frame === null || look === null) return { ok: false, reason: "That frame is gone." };

      const bytes = await store.read({
        scopeKey: look.scopeKey,
        lookId: frame.lookId,
        relPath: frame.relPath,
      });
      if (bytes === null) return { ok: false, reason: "That frame is no longer on disk." };

      let hostId: string | undefined;
      if (threadId !== null) {
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          if (thread.environmentId !== null) {
            const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
            hostId = environment.hostId;
          }
        } catch {
          // No thread context: `undefined` targets the server's own host, which
          // is the honest default for a command run without one.
        }
      }

      try {
        const written = await bb.sdk.files.write({
          ...(hostId === undefined ? {} : { hostId }),
          path,
          rootPath,
          content: bytes.toString("base64"),
          contentEncoding: "base64",
          expectedSha256: null,
          mode: 0o600,
        });
        if (written.outcome !== "written") {
          return { ok: false, reason: `Could not write ${path}: ${written.outcome}.` };
        }
        return { ok: true, path };
      } catch (error) {
        return { ok: false, reason: `Could not write ${path}: ${describe(error)}` };
      }
    },

    /**
     * Enqueue a render.
     *
     * Everything the run needs is resolved *here* — the device, the project,
     * the scheme, the build path — so the queued job closes over facts rather
     * than over `bb`, which may be stale by the time the queue reaches it.
     *
     * Every refusal is a sentence naming what to do next. "Could not run" for
     * a project with twelve schemes is a dead end; naming the twelve is not.
     */
    stills: {
      async enqueue(scope, deviceQuery) {
        return (await startStills(scope, deviceQuery)).handle;
      },
      async run(scope, deviceQuery) {
        const started = await startStills(scope, deviceQuery);
        const lookId = await started.promise;
        const look = getLook(db, lookId);
        return look === null ? null : summarizeLook(ctx, look);
      },
    },

    /**
     * Write the onboarding files through `bb.sdk.files`.
     *
     * Confined beneath the checkout root, and never with `node:fs`: the
     * checkout can be on another host, and a plugin writing to the wrong disk
     * is a bug nobody would look for. `expectedSha256: null` is create-only —
     * an onboarding run must never clobber a file someone has since edited.
     */
    /** Ask a human, in the composer, before a destructive server action. */
    async confirmAction(hints, consent) {
      if (hostConfirmationInFlight) return false;
      const threadId = confirmationThread(hints);
      if (threadId === null) return false;
      hostConfirmationInFlight = true;
      try {
        return await confirmInThread(threadId, consent);
      } finally {
        hostConfirmationInFlight = false;
      }
    },

    /**
     * The demo banner, held in memory with its own expiry.
     *
     * Not persisted: a demo that survived a restart would be a lie waiting to
     * be believed.
     */
    detection,

    demo: () => (demoState !== null && demoState.until > Date.now() ? demoState.state : null),
    setDemo: (state) => {
      demoState = state === null ? null : { state, until: Date.now() + DEMO_TTL_MS };
      publish("look");
    },

    async writeOnboardingFiles(files) {
      const scope = await scopeForThread(null);
      if (scope === null) return [];
      const root = scope.scope.checkoutPath;
      const written: string[] = [];
      for (const file of files) {
        const result = await bb.sdk.files.write({
          path: `${root}/${file.relPath}`,
          rootPath: root,
          content: file.contents,
          expectedSha256: null,
        });
        if (result.outcome === "written") written.push(file.relPath);
      }
      return written;
    },

    isDisposed,
  };

  // ---------------------------------------------------------------------------
  // RPC
  // ---------------------------------------------------------------------------

  bb.rpc.register(rpcContract, makeRpcHandlers(ctx));

  // ---------------------------------------------------------------------------
  // The stream proxy
  // ---------------------------------------------------------------------------

  // These routes are long-lived by design. Hard ceilings keep a buggy or
  // hostile local-route client from turning reconnects into unbounded child
  // streams or open response bodies.
  const presenceConnections = new ConnectionLimit(MAX_PANEL_PRESENCES);
  const streamConnections = new ConnectionLimit(MAX_PANEL_STREAMS);
  const privateStreamDeps: PrivateStreamRouteDeps = {
    currentDeviceUdid: () => live.currentDevice()?.udid ?? null,
    address: () => live.address(),
    noteViewerOpened: () => live.noteViewerOpened(),
    noteViewerClosed: () => live.noteViewerClosed(),
    open: simhost.open,
    streamPath: simhost.streamPath,
  };

  /**
   * Viewer presence, with no pixels in it.
   *
   * Presence used to be a side effect of the proxied stream: the panel opened
   * it only while mounted and visible, so an open connection *was* a viewer and
   * closing one started the 60-second teardown. Streaming directly from the
   * capture host keeps every byte off this process — which is the point — and
   * takes that signal with it, so a watching user would have had the device
   * session shut down underneath them a minute in.
   *
   * So presence is its own route now: one connection, zero bytes, held open for
   * exactly as long as the frame is on screen. Everything downstream of
   * `noteViewerOpened` is unchanged, and there is still no heartbeat and no
   * timer running while nothing is being watched.
   */
  bb.http.route(
    "GET",
    "/presence",
    makePresenceRouteHandler(privateStreamDeps, presenceConnections),
    { auth: "local" },
  );

  /**
   * The device stream, proxied from the capture host — H.264 or MJPEG.
   *
   * The fallback path since direct streaming landed: it is what a remote
   * bb panel uses. It keeps its own presence accounting for that
   * case, and it carries both codecs because the 18× bandwidth difference
   * matters most across a remote connection.
   */
  bb.http.route(
    "GET",
    "/stream",
    makeStreamRouteHandler(privateStreamDeps, streamConnections),
    { auth: "local" },
  );

  /**
   * Frame bytes.
   *
   * `?look=…&frame=…&kind=frame|thumb|mask`. The route is exact-match with no
   * path parameters, which is why the identifiers are query parameters — and
   * the handler resolves them **through the database**, never as paths, then
   * asserts the resolved absolute path is inside the frames root before opening
   * it. Both halves are needed: the first stops a traversal, the second stops a
   * bug in the first.
   *
   * `ETag: <content_hash>` with a one-year immutable cache is honest here,
   * because a frame row is never rewritten.
   */
  bb.http.route(
    "GET",
    "/image",
    async (context) => {
      const lookId = context.req.query("look") ?? "";
      const frameId = context.req.query("frame") ?? "";
      const kind = context.req.query("kind") ?? "frame";
      // Identifiers are validated against a strict pattern before they are used
      // for anything at all — including as a database key.
      if (!LOOK_ID_PATTERN.test(lookId) || !FRAME_ID_PATTERN.test(frameId)) {
        return context.text("Not found", 404);
      }
      if (kind !== "frame" && kind !== "thumb" && kind !== "mask") {
        return context.text("Not found", 404);
      }

      const frame = getFrame(db, frameId);
      if (frame === null || frame.lookId !== lookId) return context.text("Not found", 404);
      const look = getLook(db, lookId);
      if (look === null) return context.text("Not found", 404);

      const relPath =
        kind === "thumb"
          ? frame.thumbRelPath
          : kind === "mask"
            ? maskRelPathFor(db, lookId, frame.identity)
            : frame.relPath;
      if (relPath === null) return context.text("Not found", 404);

      const bytes = await store.read({ scopeKey: look.scopeKey, lookId, relPath });
      // A frame that is no longer on disk is a state the UI renders — never a
      // broken-image glyph.
      if (bytes === null) return context.text("This frame is no longer on disk.", 404);

      const etag = `"${frame.contentHash}-${kind}"`;
      if (context.req.header("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "Content-Type": contentTypeOf(relPath),
          "Content-Length": String(bytes.byteLength),
          ETag: etag,
          "Cache-Control": "private, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
    { auth: "local" },
  );

  // ---------------------------------------------------------------------------
  // Background service
  // ---------------------------------------------------------------------------

  // Owns the loopback capture host and its control sockets. It awaits an abort
  // — there is no loop and no timer running while nothing is on screen.
  bb.background.service("sim-live", {
    async start(signal) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await live.dispose();
    },
  });

  /**
   * Prune.
   *
   * The schedule **enqueues** onto the stills queue rather than sweeping
   * inline. The reason is not that a schedule throw is dangerous — it only
   * lands in that schedule's `last_status` — but that a long sweep inside a
   * schedule callback is unbounded work a reload teardown has to wait on, and
   * it needs the same abort signal and the same in-flight coalescing as every
   * other job.
   *
   * It also piggybacks on the end of every run behind a `lastPruneAt`
   * watermark, because on a laptop 04:37 mostly never happens.
   */
  const PRUNE_INTERVAL_MS = 6 * 60 * 60_000;

  const runPrune = async (incomingBytes = 0): Promise<void> => {
    const plan = planPrune({
      db,
      retainLooks: settings.retainLooks,
      diskBudgetBytes: settings.diskBudgetMb * 1024 * 1024,
      incomingBytes,
    });
    if (plan.evict.length > 0) {
      const result = await applyPrune(db, store, plan);
      log(
        "info",
        `pruned ${result.removed} run(s) (${plan.reason}), freeing ${Math.round(plan.bytesFreed / 1024 / 1024)}MB`,
      );
      publish("look");
    }
    await sweepServeSimLogs(tmpdir(), Date.now());
    await sweepLegacyStillsResults(dataDir);
    await bb.storage.kv.set("lastPruneAt", Date.now());
  };

  reserveFrameBytes = async (incomingBytes) => {
    await runPrune(incomingBytes);
    const budget = settings.diskBudgetMb * 1024 * 1024;
    if (totalBytes(db) + incomingBytes > budget) {
      throw new Error("The preview export would exceed the simulator frame disk budget.");
    }
  };

  const pruneIfDue = (): void => {
    detach(async () => {
      const last = (await bb.storage.kv.get<number>("lastPruneAt")) ?? 0;
      if (Date.now() - last < PRUNE_INTERVAL_MS) return;
      await runPrune();
    }, (error) => log("warn", `prune failed: ${describe(error)}`));
  };

  // Named apart from the tracker's own `prune`: schedule names are unique
  // per plugin, and a collision leaves the whole plugin in `error`.
  bb.background.schedule("sim-prune", "37 4 * * *", async () => {
    // Enqueued rather than run inline: it is unbounded work, and reload
    // teardown must not wait on it.
    queue.enqueue({
      key: { udid: "prune", scopeKey: "prune", deviceKey: "prune" },
      run: async () => {
        await runPrune();
        return "prune";
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Agent tools
  // ---------------------------------------------------------------------------

  // Registered only when the setting is on. A captured frame is sent to the
  // model provider, and a setting that turns that off has to actually remove
  // the tools rather than make them refuse.
  if (settings.allowAgentCapture) {
    bb.agents.registerTool(makeCaptureTool(ctx));
    bb.agents.registerTool(makeDriveTool(ctx));
    bb.agents.registerTool(makeStillsTool(ctx));
    // The instructions themselves are contributed by `server.ts`:
    // `contributeInstructions` is one call per plugin, and both halves have
    // something to say. They are still contributed *globally* rather than only
    // through these tools, for the reason they always were — simulator input
    // also arrives via simctl, AXe and xcodebuildmcp, so the "don't narrate the
    // screen" contract has to reach threads that never touch them.
    host.contributeInstructions(GLOBAL_INSTRUCTIONS);
  }

  // ---------------------------------------------------------------------------
  // CLI
  // ---------------------------------------------------------------------------

  // `bb.cli.register` is one-per-plugin, so these are handed to the host and
  // dispatched as `bb xcode sim <verb>` rather than registered here.
  host.mountCli(makeCli(ctx));

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  bb.onDispose(() => {
    flush.cancel();
    leases.releaseAll();
    queue.abortAll();
    detach(
      () => live.dispose(),
      () => {
        // The handle is already stale; there is nowhere left to report to.
      },
    );
    disposed = true;
  });
}

/**
 * The diff mask for one identity, which lives on the verdict rather than the
 * frame — a mask exists only when there was something to compare against.
 */
function maskRelPathFor(database: Db, lookId: string, identity: string): string | null {
  const verdict = listVerdicts(database, lookId).find((entry) => entry.identity === identity);
  return verdict?.maskRelPath ?? null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
