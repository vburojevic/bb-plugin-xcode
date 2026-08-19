/**
 * The Live data store.
 *
 * **Module-level, not per component.** The panel header and the panel body are
 * separate React trees — the host renders `headerContent` inside its own title
 * bar — and a split view mounts the body twice. A hook that fetched per
 * instance would turn one realtime ping into N round trips against a `simctl`
 * that takes hundreds of milliseconds. The fact is fetched once and shared.
 *
 * Storm control on top of that: one request in flight with a single queued
 * follow-up, and on error the durable state stays on screen rather than
 * blanking. A panel that flashes "No simulator is running" during a reconnect
 * has told the user something false.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../../src/sim/wire";
import type { Step } from "../../src/sim/steps.js";
import { TouchChannel, type TouchPhase } from "./touch-channel";

export interface LiveState {
  kind:
    | "unsupported"
    | "intel-blocked"
    | "intel-failed"
    | "no-runtimes"
    | "simctl-failed"
    | "idle"
    | "booting"
    | "boot-failed"
    | "waiting-frame"
    | "streaming"
    | "stalled"
    | "host-restarted"
    | "erasing"
    | "dead";
  device: { udid: string; name: string; osVersion: string } | null;
  screen: { width: number; height: number; orientation: string } | null;
  foregroundBundleId: string | null;
  reason: string | null;
  crashes: number;
  slowBoot: boolean;
  streamUrl: string | null;
  /** Loopback and token-scoped; only right for a viewer on this machine. */
  directStreamUrl: string | null;
  generation: number;
  showDeviceChrome: boolean;
}

export interface CapturedFrame {
  id: string;
  lookId: string;
  identity: string;
  source: "preview" | "capture";
  displayName: string;
  groupName: string;
  width: number;
  height: number;
  bytes: number;
  foregroundBundleId: string | null;
  capturedAt: number;
  url: string;
  thumbUrl: string | null;
}

export interface DeviceList {
  devices: Array<{
    udid: string;
    name: string;
    state: string;
    osVersion: string;
    platform: string;
    isAvailable: boolean;
  }>;
  bootedUdids: string[];
  suggested: { udid: string; name: string; osVersion: string } | null;
  hasDrivableRuntime: boolean;
  installedPlatforms: string[];
  error: string | null;
}

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

interface Snapshot {
  state: LiveState | null;
  devices: DeviceList | null;
  frames: CapturedFrame[];
  error: string | null;
  isLoading: boolean;
}

const EMPTY: Snapshot = {
  state: null,
  devices: null,
  frames: [],
  error: null,
  isLoading: true,
};

let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
let rpc: Rpc | null = null;
let inFlight = false;
let queued = false;

/**
 * The one live-touch pipe.
 *
 * Module-level for the same reason the store is: the nav panel and a thread
 * panel are separate React trees over one device, and two channels would
 * interleave their frames. The channel reads the current client lazily, so a
 * reconnect swaps transports without a drag in flight noticing.
 */
let touches: TouchChannel | null = null;

function touchChannel(): TouchChannel {
  touches ??= new TouchChannel((phase, x, y) => {
    const client = rpc;
    if (client === null) return Promise.resolve();
    return client.call("liveTouch", { phase, x, y });
  });
  return touches;
}

function emit(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): Snapshot {
  return snapshot;
}

/**
 * Reload both facts, at most one request pair at a time.
 *
 * A boot fires several signals in a row; without the queue a slow `simctl`
 * turns each into a parallel request and they resolve out of order, so the
 * panel briefly shows an older truth than the one it already had.
 */
function refresh(): void {
  const client = rpc;
  if (client === null) return;
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  emit({ isLoading: snapshot.state === null });

  Promise.allSettled([
    client.call("liveState", {}),
    client.call("devices"),
    client.call("liveFrames", {}),
  ])
    .then(([live, devices, frames]) => {
      const patch: Partial<Snapshot> = { isLoading: false, error: null };
      // Keep whatever durable state is already on screen when a call fails.
      if (live.status === "fulfilled") patch.state = live.value as LiveState;
      else patch.error = describe(live.reason);
      if (devices.status === "fulfilled") patch.devices = devices.value as DeviceList;
      else patch.error = patch.error ?? describe(devices.reason);
      if (frames.status === "fulfilled") {
        patch.frames = (frames.value as { frames: CapturedFrame[] }).frames;
      }
      emit(patch);
    })
    .finally(() => {
      inFlight = false;
      if (queued) {
        queued = false;
        refresh();
      }
    });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reset between tests; the store outlives a component by design. */
export function resetLiveStore(): void {
  snapshot = EMPTY;
  rpc = null;
  inFlight = false;
  queued = false;
  touches = null;
  listeners.clear();
}

export interface LiveApi extends Snapshot {
  refresh: () => void;
  start: (device?: string) => Promise<void>;
  stop: () => Promise<void>;
  shutdown: (udid: string) => Promise<void>;
  erase: (udid: string) => Promise<void>;
  /** One input step. Rejects with the server's sentence when it refuses. */
  input: (step: Step) => Promise<{ log: string; dropped: string[] }>;
  /** One live touch frame — fire-and-forget, ordered, moves collapse. */
  touch: (phase: TouchPhase, x: number, y: number) => void;
  capture: (label?: string) => Promise<{ summary: string }>;
  reportStall: () => void;
  reportAlive: () => void;
}

export function useLive(): LiveApi {
  const client = useRpc<typeof rpcContract>();
  rpc = client;

  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    refresh();
  }, []);

  useRealtime("simulator-changed", (payload: unknown) => {
    const kind = (payload as { kind?: string } | null)?.kind;
    if (kind === "live" || kind === "look") refresh();
  });

  // Signals are ephemeral and never replayed, so reconcile on every transition
  // back to connected after the first. A laptop closed for an hour must not
  // wake showing a device that shut down while it slept.
  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection]);

  const start = useCallback(
    async (device?: string) => {
      const next = await client.call("liveStart", device === undefined ? {} : { device });
      emit({ state: next as LiveState });
      refresh();
    },
    [client],
  );

  const stop = useCallback(async () => {
    const next = await client.call("liveStop", {});
    emit({ state: next as LiveState });
  }, [client]);

  const shutdown = useCallback(
    async (udid: string) => {
      const next = await client.call("liveStop", { shutdown: udid });
      emit({ state: next as LiveState });
      refresh();
    },
    [client],
  );

  const erase = useCallback(
    async (udid: string) => {
      const next = await client.call("liveStop", { erase: udid });
      emit({ state: next as LiveState });
      refresh();
    },
    [client],
  );

  const input = useCallback(
    async (step: Step) => {
      return (await client.call("liveInput", { step })) as { log: string; dropped: string[] };
    },
    [client],
  );

  /**
   * Pointer events, straight through. The channel orders and coalesces; this
   * wrapper only exists so the panel never holds the channel itself.
   */
  const touch = useCallback((phase: TouchPhase, x: number, y: number) => {
    touchChannel().push(phase, x, y);
  }, []);

  const capture = useCallback(
    async (label?: string) => {
      const result = (await client.call(
        "liveCapture",
        label === undefined ? {} : { label },
      )) as { frame: CapturedFrame; summary: string };
      // The new tile appears where frames live, which is a better confirmation
      // than a toast that covers it.
      emit({ frames: [result.frame, ...snapshot.frames].slice(0, 12) });
      return { summary: result.summary };
    },
    [client],
  );

  /**
   * The panel's watchdog telling the server its stream died.
   *
   * This is the only stall detector that works: an `<img>` whose multipart
   * stream wedges fires no event at all, so nothing server-side can tell it
   * from a device showing a static screen.
   */
  const reportStall = useCallback(() => {
    void client
      .call("liveState", { reportStall: true })
      .then((next) => emit({ state: next as LiveState }))
      .catch(() => {
        // The server will be asked again on the next signal.
      });
  }, [client]);

  /**
   * The other half of the watchdog's job: frames resumed after a stall.
   *
   * Without this, one misfired stall report left "The stream stopped" on
   * screen forever — the server had a path that set the sentence and none
   * that cleared it.
   */
  const reportAlive = useCallback(() => {
    void client
      .call("liveState", { stallCleared: true })
      .then((next) => emit({ state: next as LiveState }))
      .catch(() => {
        // The next frame will say it again.
      });
  }, [client]);

  return useMemo(
    () => ({ ...value, refresh, start, stop, shutdown, erase, input, touch, capture, reportStall, reportAlive }),
    [value, start, stop, shutdown, erase, input, touch, capture, reportStall, reportAlive],
  );
}
