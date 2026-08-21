/**
 * RPC handlers.
 *
 * **Nothing here blocks.** `liveStart` records the intent and returns
 * `{kind: "booting"}` immediately, because a first boot after an Xcode update
 * takes minutes and the panel has a sentence explaining exactly that wait — it
 * cannot show it while the call that would tell it is still open. `doctor`
 * answers from the preflight cache.
 */
import type { Ctx } from "./context.js";
import type { LiveState } from "./live.js";
import { DRIVABLE_PLATFORMS, pickDefaultDevice, SimctlError, type SimDevice } from "./devices.js";
import { pickSimulator, udidFromDestination, type RunDestination } from "./pick.js";

/**
 * How far back the picker looks for a `-destination`.
 *
 * Deep enough that a thread whose last build was this morning still has its
 * answer, shallow enough that the query stays an index scan.
 */
const RECENT_DESTINATION_LIMIT = 200;

/** The newest tracked build per simulator, keyed by upper-cased UDID. */
export function latestBuildPerDevice(runs: readonly RunDestination[]): Map<string, number> {
  const newest = new Map<string, number>();
  for (const run of runs) {
    const udid = udidFromDestination(run.destination);
    if (udid === null) continue;
    const seen = newest.get(udid);
    if (seen === undefined || run.startedAt > seen) newest.set(udid, run.startedAt);
  }
  return newest;
}

/** Booted first, then `pickDefaultDevice`'s order, applied repeatedly. */
function rankedAlternatives<T extends { udid: string; booted: boolean }>(
  devices: readonly SimDevice[],
  candidates: readonly T[],
): T[] {
  const order = (pool: T[]): T[] => {
    const remaining = [...pool];
    const out: T[] = [];
    while (remaining.length > 0) {
      const wanted = new Set(remaining.map((device) => device.udid));
      const best = pickDefaultDevice(devices.filter((device) => wanted.has(device.udid)));
      const index = best === null ? 0 : remaining.findIndex((d) => d.udid === best.udid);
      out.push(...remaining.splice(index === -1 ? 0 : index, 1));
    }
    return out;
  };
  return [
    ...order(candidates.filter((device) => device.booted)),
    ...order(candidates.filter((device) => !device.booted)),
  ];
}
import { allLooks, getFrame, recentCaptures, totalBytes, scopeCount } from "./frames.js";
import { checkpoint } from "./store.js";
import { describeUsage } from "./prune.js";
import { formatBytes } from "./format.js";
import { capture } from "./capture.js";
import { makeStillsHandlers } from "./stills-rpc.js";
import type { Frame } from "./model.js";
import { overallState } from "./preflight.js";
import { detach } from "./safe.js";
import { coordinatesOnly, executeStep, type Step } from "./steps.js";
import type { LiveStreamEvent } from "./hid.js";
import { isUiOptionKey, uiOptions } from "./options.js";

export type LiveStateDto = LiveState & {
  streamUrl: string | null;
  directStreamUrl: string | null;
  showDeviceChrome: boolean;
};

/**
 * The proxied stream — the fallback, and still the only one that always works.
 *
 * Same-origin, so a remote bb panel is not blocked as mixed content,
 * and a viewer on another machine has no loopback to talk to. The
 * panel prefers `directStreamUrlFor` and lands here when that fails, which is
 * exactly the remote case.
 */
export function streamUrlFor(pluginId: string, state: LiveState): string | null {
  if (state.device === null) return null;
  if (state.kind !== "streaming" && state.kind !== "waiting-frame" && state.kind !== "stalled") {
    return null;
  }
  const params = new URLSearchParams({
    udid: state.device.udid,
    // The generation forces a fresh connection after a capture-host restart;
    // without it the browser reuses the dead one and the panel never recovers.
    g: String(state.generation),
  });
  return `/api/v1/plugins/${pluginId}/http/stream?${params.toString()}`;
}

/**
 * The direct stream, straight off the capture host's loopback port.
 *
 * Worth the second auth model: measured, proxying the MJPEG through the bb
 * server cost 1.69s of CPU per 8s of streaming — 79% as much as capturing and
 * JPEG-encoding the frames — and spent all of it on the process every other
 * plugin and the whole UI share. The bytes are identical; the hop was pure
 * copying.
 *
 * It carries `streamToken`, not the master secret, because an `<img>` cannot
 * set a header and this URL therefore lives in the DOM. The token opens the
 * MJPEG route and nothing else — no HID socket, no accessibility tree, no
 * shutdown. See `authorize` in `sim-host.mjs`.
 *
 * `null` whenever the capture host is not up. The panel treats a non-null value
 * as a *candidate*: it is wrong for every viewer that is not on this machine,
 * and the only honest way to find that out is to try it.
 */
export function directStreamUrlFor(
  state: LiveState,
  address: { port: number; streamToken: string } | null,
): string | null {
  if (address === null || state.device === null) return null;
  if (state.kind !== "streaming" && state.kind !== "waiting-frame" && state.kind !== "stalled") {
    return null;
  }
  const params = new URLSearchParams({ k: address.streamToken, g: String(state.generation) });
  return `http://127.0.0.1:${address.port}/helper/${state.device.udid}/stream.mjpeg?${params.toString()}`;
}

/**
 * The image route, composed rather than stored.
 *
 * RPC results must be strict JSON and image bytes cannot ride that channel, so
 * the panel gets a URL. The route is exact-match with no path parameters, which
 * is why the identifiers are query parameters — and why the handler resolves
 * them through the database rather than treating either as a path.
 */
export function imageUrl(
  pluginId: string,
  frame: { lookId: string; id: string },
  kind: "frame" | "thumb" | "mask",
): string {
  const params = new URLSearchParams({ look: frame.lookId, frame: frame.id, kind });
  return `/api/v1/plugins/${pluginId}/http/image?${params.toString()}`;
}

export function toFrameDto(pluginId: string, frame: Frame) {
  return {
    id: frame.id,
    lookId: frame.lookId,
    identity: frame.identity,
    source: frame.source,
    displayName: frame.displayName,
    groupName: frame.groupName,
    width: frame.width,
    height: frame.height,
    bytes: frame.bytes,
    foregroundBundleId: frame.foregroundBundleId,
    capturedAt: frame.capturedAt,
    url: imageUrl(pluginId, frame, "frame"),
    thumbUrl: frame.thumbRelPath === null ? null : imageUrl(pluginId, frame, "thumb"),
  };
}

export function toLiveStateDto(ctx: Ctx, state: LiveState): LiveStateDto {
  return {
    ...state,
    streamUrl: streamUrlFor(ctx.pluginId, state),
    directStreamUrl: directStreamUrlFor(state, ctx.live.address()),
    showDeviceChrome: ctx.settings().showDeviceChrome,
  };
}

export function makeRpcHandlers(ctx: Ctx) {
  return {
    ...makeStillsHandlers(ctx),
    async doctor({ refresh }: { refresh?: boolean }) {
      const preflight = refresh === true ? await ctx.refreshPreflight() : await ctx.preflight();
      // A nav panel owns a route rather than a thread, so this is the default
      // project's checkout. `scopeForThread` answers `null` when it cannot tell,
      // and `null` here means "do not claim the checkout is elsewhere" — a
      // refusal on a guess is worse than an attempt.
      const scope = await ctx.scopeForThread(null);
      return {
        probes: preflight.probes.map((probe) => ({
          id: probe.id,
          label: probe.label,
          state: probe.state,
          detail: probe.detail,
          value: probe.value ?? null,
        })),
        overall: overallState(preflight.probes),
        diskBytes: totalBytes(ctx.db),
        scopeCount: scopeCount(ctx.db),
        checkoutElsewhere: scope?.checkoutElsewhere ?? null,
        checkedAt: preflight.checkedAt,
      };
    },

    /**
     * Which simulator this thread means. See `src/sim/pick.ts` for the ranking.
     *
     * A failed `simctl list` answers `device: null` rather than throwing: the
     * thread panel's whole job is to show *something* useful beside a
     * conversation, and an empty panel with a sentence beats an error boundary.
     */
    async simPick({ threadId }: { threadId: string | null }) {
      let devices: Awaited<ReturnType<Ctx["live"]["devices"]>>["devices"] = [];
      let booted: string[] = [];
      try {
        const result = await ctx.live.devices();
        devices = result.devices;
        booted = result.bootedUdids;
      } catch {
        return { device: null, booted: false, reason: null, because: null, alternatives: [] };
      }

      const bootedSet = new Set(booted);
      const candidates = devices
        .filter((device) => DRIVABLE_PLATFORMS.includes(device.platform))
        .map((device) => ({
          udid: device.udid,
          name: device.name,
          osVersion: device.osVersion,
          booted: bootedSet.has(device.udid),
          isAvailable: device.isAvailable,
        }));

      const live = ctx.live.state();
      const picked = pickSimulator({
        candidates,
        runs: ctx.recentDestinations(RECENT_DESTINATION_LIMIT),
        threadId,
        projectId: (await ctx.scopeForInvocation({ threadId: threadId ?? undefined }))?.projectId ?? null,
        mirroring: live.device?.udid ?? null,
        // Ranked on the real `SimDevice` rows, not on reconstructed ones:
        // `pickDefaultDevice` sorts by OS version, model number and tier, and
        // a rebuilt row loses the fields it reads.
        rank: (pool) => {
          const wanted = new Set(pool.map((device) => device.udid));
          const best = pickDefaultDevice(devices.filter((device) => wanted.has(device.udid)));
          return best === null
            ? null
            : (pool.find((device) => device.udid === best.udid) ?? null);
        },
      });

      return {
        device:
          picked === null
            ? null
            : {
                udid: picked.device.udid,
                name: picked.device.name,
                osVersion: picked.device.osVersion,
              },
        booted: picked?.device.booted ?? false,
        reason: picked?.reason ?? null,
        because: picked?.because ?? null,
        // Ranked, not listed. A Mac that has been running agents for a week
        // has fifty simulators, most of them named after a branch, and an
        // unordered dropdown of those is not a control anyone can use. Booted
        // ones first — they are the ones with something on screen — then the
        // same ordering the device list uses.
        alternatives: rankedAlternatives(devices, candidates).map((device) => ({
          udid: device.udid,
          name: device.name,
          osVersion: device.osVersion,
        })),
      };
    },

    async devices() {
      const machines = await ctx.machines();
      try {
        const result = await ctx.live.devices();
        // The tracker half already parses `-destination` off every xcodebuild
        // it sees; folding it in here is what makes "recently used" mean "the
        // device your work ran on", not merely "a device that was booted".
        const lastBuilt = latestBuildPerDevice(ctx.recentDestinations(RECENT_DESTINATION_LIMIT));
        return {
          devices: result.devices.map((device) => ({
            udid: device.udid,
            name: device.name,
            state: device.state,
            osVersion: device.osVersion,
            platform: device.platform,
            family: device.family,
            isAvailable: device.isAvailable,
            lastBootedAt: device.lastBootedAt,
            lastBuiltAt: lastBuilt.get(device.udid.toUpperCase()) ?? null,
          })),
          bootedUdids: result.bootedUdids,
          suggested: result.suggested,
          hasDrivableRuntime: result.hasDrivableRuntime,
          installedPlatforms: result.installedPlatforms,
          machine: machines.current,
          otherMachines: machines.others,
          error: null,
        };
      } catch (error) {
        // A failed `simctl list` is not "no devices exist". Saying so to
        // someone with twelve simulators is how a tool loses trust in one
        // screen.
        return {
          devices: [],
          bootedUdids: [],
          suggested: null,
          hasDrivableRuntime: false,
          installedPlatforms: [],
          machine: machines.current,
          otherMachines: machines.others,
          error:
            error instanceof SimctlError
              ? `Xcode Simulators could not ask about simulators — ${error.message}`
              : "Xcode Simulators could not ask about simulators — `xcrun simctl list` failed.",
        };
      }
    },

    async liveState({ reportStall, stallCleared }: { reportStall?: boolean; stallCleared?: boolean }) {
      const state =
        reportStall === true
          ? await ctx.live.reportStall()
          : stallCleared === true
            ? await ctx.live.clearStall()
            : ctx.live.state();
      // A panel asking for state is the event that refreshes the foreground
      // app. Nothing here waits for it: when the answer changes, the realtime
      // signal brings the panel back for it.
      ctx.live.noteStateRead();
      return toLiveStateDto(ctx, state);
    },

    async liveStart({ device }: { device?: string }) {
      const state = await ctx.live.start(device ?? null);
      return toLiveStateDto(ctx, state);
    },

    async liveStop({
      erase,
      shutdown,
      threadId,
      projectId,
    }: {
      erase?: string;
      shutdown?: string;
      threadId?: string | null;
      projectId?: string | null;
    }) {
      if (erase !== undefined) {
        const target = ctx.live.currentDevice();
        if (target === null || target.udid !== erase) {
          throw new Error("Only the simulator currently shown in the panel can be erased.");
        }
        const approved = await ctx.confirmAction(
          { threadId, projectId },
          {
            title: "Erase this simulator?",
            facts: [
              `Every app, login, and setting on ${target.name} (${target.udid}) will be deleted.`,
              "This cannot be undone, and the simulator shuts down while it happens.",
            ],
            confirmLabel: "Erase permanently",
          },
        );
        if (!approved) throw new Error("Erase was not confirmed.");
        await ctx.live.erase(erase);
      } else if (shutdown !== undefined) {
        const target = ctx.live.currentDevice();
        if (target === null || target.udid !== shutdown) {
          throw new Error("Only the simulator currently shown in the panel can be shut down.");
        }
        const approved = await ctx.confirmAction(
          { threadId, projectId },
          {
            title: "Shut down this simulator?",
            facts: [`The running simulator ${target.name} (${target.udid}) and its active streams will stop.`],
            confirmLabel: "Shut down",
          },
        );
        if (!approved) throw new Error("Shutdown was not confirmed.");
        await ctx.live.shutdown(shutdown);
      } else {
        await ctx.live.stop();
      }
      return toLiveStateDto(ctx, ctx.live.state());
    },

    async liveCapture({ label, settleMs }: { label?: string; settleMs?: number }) {
      const result = await captureNow(ctx, label ?? null, settleMs);
      const frame = getFrame(ctx.db, result.frameId);
      if (frame === null) throw new Error("The capture was written but could not be read back.");
      ctx.publish("look");
      return { frame: toFrameDto(ctx.pluginId, frame), summary: result.summary };
    },

    async liveFrames({ limit }: { limit?: number }) {
      const device = ctx.live.currentDevice();
      if (device === null) return { frames: [] };
      const scope = await ctx.scopeForThread(null);
      if (scope === null) return { frames: [] };
      const frames = recentCaptures(ctx.db, scope.scope.scopeKey, device.udid, limit ?? 12);
      return { frames: frames.map((frame) => toFrameDto(ctx.pluginId, frame)) };
    },

    async purgePreview() {
      const looks = allLooks(ctx.db);
      const bytes = totalBytes(ctx.db);
      const scopes = scopeCount(ctx.db);
      return {
        looks: looks.length,
        bytes,
        scopes,
        sentence: describeUsage(bytes, scopes, formatBytes),
      };
    },

    async purgeApply(hints: { threadId?: string | null; projectId?: string | null }) {
      const approved = await ctx.confirmAction(hints, {
        title: "Remove every stored simulator frame?",
        facts: [
          "All captured frames, preview runs, baselines, and their database records will be removed.",
          "This cannot be undone.",
        ],
        confirmLabel: "Remove all stored frames",
      });
      if (!approved) throw new Error("Purge was not confirmed.");
      const looks = allLooks(ctx.db);
      const bytes = totalBytes(ctx.db);
      await ctx.store.removeAll();
      // Everything, including the tombstones: purge is the uninstall path, and
      // half-removing someone's data is worse than not offering to.
      ctx.db.prepare("DELETE FROM looks").run();
      checkpoint(ctx.db);
      ctx.publish("look");
      return { looks: looks.length, bytes };
    },

    async liveInput({ step }: { step: Step }) {
      const socket = ctx.live.requireSocket();
      const result = await executeStep(socket, step, coordinatesOnly, {
        pasteText: (text) => ctx.live.pasteText(text),
      });
      // A tap can move the foreground app, and the meta line under the frame
      // claims to say which one is there.
      if (step.kind === "tap" || step.kind === "button") {
        detach(
          () => ctx.live.pollForeground().then(() => undefined),
          () => {
            // The accessibility service warms up after the device does.
          },
        );
      }
      return { log: result.log, dropped: result.dropped };
    },

    async liveTouch({ phase, x, y }: { phase: "begin" | "move" | "end"; x: number; y: number }) {
      const ok = ctx.live.touch(phase, x, y);
      // A finger coming up can move the foreground app, and the meta line
      // claims to say which one is there. Once per gesture end — never per
      // move, or the probe would run at display rate.
      if (phase === "end") {
        detach(
          () => ctx.live.pollForeground().then(() => undefined),
          () => {
            // The accessibility service warms up after the device does.
          },
        );
      }
      return { ok };
    },

    async uiOptions() {
      return { options: uiOptions(await ctx.rawSettings()) };
    },

    async uiOptionSet({ key, value }: { key: string; value: boolean }) {
      // The allowlist is the security boundary: this route is reachable by any
      // same-user local caller, so only presentation may live behind it.
      if (!isUiOptionKey(key)) {
        throw new Error(`"${key}" is not a toggle this menu owns. Use the plugin's settings screen.`);
      }
      await ctx.writeSetting(key, value);
      return { options: uiOptions(await ctx.rawSettings()) };
    },

    async liveStream({ events }: { events: LiveStreamEvent[] }) {
      const ok = ctx.live.stream(events);
      // Same probe, same discipline: once per batch that lifts a finger,
      // never per move.
      if (ok && events.some((event) => event.kind !== "scroll" && event.phase === "end")) {
        detach(
          () => ctx.live.pollForeground().then(() => undefined),
          () => {
            // The accessibility service warms up after the device does.
          },
        );
      }
      return { ok };
    },
  };
}


/**
 * Capture, with the context the store needs assembled in one place.
 *
 * Shared by the RPC handler, the agent tool and `bb sims shot`, so a frame taken
 * three ways is one frame taken one way.
 */
export async function captureNow(
  ctx: Ctx,
  label: string | null,
  settleMs?: number,
): Promise<Awaited<ReturnType<typeof capture>>> {
  const device = ctx.live.currentDevice();
  if (device === null) throw new Error("No simulator is running.");
  const address = ctx.live.address();
  if (address === null) throw new Error("The capture host is not running.");
  const scope = await ctx.scopeForThread(null);
  if (scope === null) {
    throw new Error("Xcode Simulators could not work out which project this is.");
  }
  const head = await ctx.gitHead(scope.scope.checkoutPath);
  return capture({
    db: ctx.db,
    store: ctx.store,
    address,
    device,
    scopeKey: scope.scope.scopeKey,
    projectId: scope.projectId,
    commitSha: head.commitSha,
    branch: head.branch,
    screen: ctx.live.state().screen,
    label,
    settleMs,
    now: Date.now,
  });
}
