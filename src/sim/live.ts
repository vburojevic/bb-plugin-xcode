/**
 * The Live surface: one supervised capture host, one device session, one HID
 * socket, and the state machine that decides which sentence the panel says.
 *
 * **No loops and no polling.** The child is started lazily and awaited once.
 * The device session is created in response to a button. Device death is
 * detected by the surface that already has an open stream: the stream stalls,
 * something reports it, and the server runs *one* `simctl list devices booted
 * -j` — a single command in response to an event. When no panel is mounted the
 * device session is torn down after 60 seconds and the child after five
 * minutes.
 */
import type { SimDevice } from "./devices.js";
import { DeviceDriver, SimctlError, DRIVABLE_PLATFORMS, findDeviceByNameOrUdid, pickDefaultDevice } from "./devices.js";
import { HidSocket, type ButtonName, type Orientation, type ScreenConfig } from "./hid.js";
import { startSimHost, type SimHostHandle, type SpawnDeps } from "./sim-host-sup.js";
import * as host from "./sim-host-client.js";
import { detach } from "./safe.js";

/** How long after the last viewer disconnects before the device session goes. */
export const IDLE_DEVICE_MS = 60_000;
/** And how long before the capture host itself is stopped. */
export const IDLE_HOST_MS = 5 * 60_000;
/** Two crashes inside this window is a pattern rather than a blip. */
export const CRASH_WINDOW_MS = 60_000;
/** After this long, "about twenty seconds" has stopped being true. */
export const SLOW_BOOT_MS = 45_000;
/**
 * How stale the foreground app may get before a panel asking for state kicks a
 * fresh probe.
 *
 * The simulator's accessibility service warms up several seconds after the
 * device does, so the probe fired at attach frequently answers nothing. Without
 * a retry the meta line reads "Home screen" for the rest of the session — with
 * an app plainly visible in the frame above it. This is still event-driven: it
 * happens because a mounted panel asked, not on a timer.
 */
export const FOREGROUND_STALE_MS = 5000;

export type LiveStateKind =
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

export interface LiveDevice {
  udid: string;
  name: string;
  osVersion: string;
}

export interface LiveState {
  kind: LiveStateKind;
  device: LiveDevice | null;
  screen: ScreenConfig | null;
  /** The app on screen, for the meta line. `null` on the home screen. */
  foregroundBundleId: string | null;
  /** Set for `boot-failed` and `dead`; already a sentence with a fix in it. */
  reason: string | null;
  /** Set for `host-restarted`: how many times inside the crash window. */
  crashes: number;
  /** True once boot has taken long enough that the copy has to age. */
  slowBoot: boolean;
  /** Bumped whenever an open stream must be re-opened. Keys the panel's <img>. */
  generation: number;
}

export interface LiveDeps {
  driver: DeviceDriver;
  spawn: () => SpawnDeps;
  allowIntelLive: () => boolean;
  defaultDevice: () => string;
  isAppleSilicon: boolean;
  isMac: boolean;
  log: (level: "info" | "warn" | "error", message: string) => void;
  /** Something changed that a mounted panel would want to know about. */
  publish: () => void;
  now?: () => number;
}

interface Session {
  device: LiveDevice;
  hid: HidSocket | null;
  screen: ScreenConfig | null;
  foregroundBundleId: string | null;
  kind: Extract<LiveStateKind, "booting" | "waiting-frame" | "streaming" | "stalled" | "host-restarted" | "erasing" | "dead" | "boot-failed">;
  reason: string | null;
  startedAt: number;
  /** When the foreground app was last successfully read, or 0 if never. */
  foregroundCheckedAt: number;
  /** Aborts the in-flight boot when the user switches devices or we tear down. */
  abort: AbortController;
}

export class LiveService {
  private child: SimHostHandle | null = null;
  private starting: Promise<SimHostHandle> | null = null;
  private session: Session | null = null;
  private viewers = 0;
  private idleDeviceTimer: ReturnType<typeof setTimeout> | null = null;
  private idleHostTimer: ReturnType<typeof setTimeout> | null = null;
  private crashTimestamps: number[] = [];
  private lastSimctlError: string | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly deps: LiveDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // -------------------------------------------------------------------------
  // The capture host
  // -------------------------------------------------------------------------

  /** The child's address, if it is running. Callers that need it start it first. */
  address(): host.SimHostAddress | null {
    if (this.child === null || !this.child.isAlive()) return null;
    return {
      port: this.child.port,
      secret: this.child.secret,
      streamToken: this.child.streamToken,
    };
  }

  /**
   * Start the capture host, or return the one already running.
   *
   * Memoized on the in-flight promise, because two panels mounting in the same
   * tick would otherwise spawn two children and the second would win the
   * variable while the first kept a port bound.
   */
  async ensureHost(): Promise<SimHostHandle> {
    if (this.child !== null && this.child.isAlive()) return this.child;
    if (this.starting !== null) return this.starting;

    this.starting = startSimHost(this.deps.spawn(), {
      onLog: (line) => this.deps.log("info", `capture host: ${line}`),
      onExit: ({ code, signal, expected }) => this.handleHostExit(code, signal, expected),
    })
      .then((handle) => {
        this.child = handle;
        this.starting = null;
        if (handle.addonLoaded === false) {
          this.deps.log("warn", `capture addon did not load: ${handle.addonError ?? "no reason given"}`);
        }
        return handle;
      })
      .catch((error: unknown) => {
        this.starting = null;
        this.child = null;
        throw error;
      });

    return this.starting;
  }

  /**
   * The child died. This state exists because the child-process architecture
   * exists: without it the crash falls through to "the stream stopped, checking
   * the simulator", which blames a healthy device and sends the user to shut it
   * down and re-boot it.
   */
  private handleHostExit(code: number | null, signal: NodeJS.Signals | null, expected: boolean): void {
    this.child = null;
    this.generation += 1;
    if (expected || this.disposed) return;

    const at = this.now();
    this.crashTimestamps = [...this.crashTimestamps, at].filter((stamp) => at - stamp < CRASH_WINDOW_MS);
    this.deps.log(
      "warn",
      `capture host exited (${signal ?? `code ${code ?? "?"}`}); ${this.crashTimestamps.length} time(s) in the last minute`,
    );

    if (this.session !== null) {
      this.session.hid?.close();
      this.session.hid = null;
      this.session.kind = "host-restarted";
      this.session.reason = null;
      // Reconnect only while someone is watching; a crash with no viewer is a
      // fact to remember, not work to do.
      if (this.viewers > 0) {
        const udid = this.session.device.udid;
        detach(
          () => this.attach(udid),
          (error) => this.deps.log("error", `could not reconnect after a capture host restart: ${describe(error)}`),
        );
      }
    }
    this.deps.publish();
  }

  // -------------------------------------------------------------------------
  // Viewer presence
  // -------------------------------------------------------------------------

  /**
   * A stream opened. This is the presence signal: the panel opens the stream
   * only while mounted and visible, so there is no heartbeat to maintain and no
   * timer running while nothing is on screen.
   */
  noteViewerOpened(): void {
    this.viewers += 1;
    this.clearIdleTimers();
  }

  noteViewerClosed(): void {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers > 0) return;
    this.clearIdleTimers();
    this.idleDeviceTimer = setTimeout(() => {
      detach(
        () => this.detachDevice(),
        (error) => this.deps.log("warn", `idle teardown failed: ${describe(error)}`),
      );
    }, IDLE_DEVICE_MS);
    this.idleDeviceTimer.unref?.();
    this.idleHostTimer = setTimeout(() => this.stopHost(), IDLE_HOST_MS);
    this.idleHostTimer.unref?.();
  }

  private clearIdleTimers(): void {
    if (this.idleDeviceTimer !== null) clearTimeout(this.idleDeviceTimer);
    if (this.idleHostTimer !== null) clearTimeout(this.idleHostTimer);
    this.idleDeviceTimer = null;
    this.idleHostTimer = null;
  }

  private stopHost(): void {
    this.child?.stop();
    this.child = null;
  }

  // -------------------------------------------------------------------------
  // Device sessions
  // -------------------------------------------------------------------------

  /** The device currently being watched, if any. */
  currentDevice(): LiveDevice | null {
    return this.session?.device ?? null;
  }

  /**
   * Begin watching a device. Returns as soon as the intent is recorded — the
   * boot itself can take three minutes on a first run after an Xcode update,
   * and an RPC handler that waited for it would block a panel from rendering
   * the "Booting" sentence that explains the wait.
   */
  async start(query: string | null, signal?: AbortSignal): Promise<LiveState> {
    const device = await this.resolveDevice(query, signal);
    if (device === null) {
      return this.state();
    }
    if (this.session !== null && this.session.device.udid !== device.udid) {
      await this.detachDevice();
    }
    if (this.session?.device.udid === device.udid && this.session.kind === "streaming") {
      return this.state();
    }

    const abort = new AbortController();
    this.session = {
      device,
      hid: null,
      screen: null,
      foregroundBundleId: null,
      kind: "booting",
      reason: null,
      startedAt: this.now(),
      foregroundCheckedAt: 0,
      abort,
    };
    this.deps.publish();

    detach(
      () => this.attach(device.udid),
      (error) => {
        if (this.session?.device.udid !== device.udid) return;
        this.session.kind = "boot-failed";
        this.session.reason = describe(error);
        this.deps.publish();
      },
    );

    return this.state();
  }

  /**
   * Bring a device session up: boot through the child, then open the control
   * socket that pushes dimensions.
   */
  private async attach(udid: string): Promise<void> {
    const handle = await this.ensureHost();
    if (this.session?.device.udid !== udid) return;

    await host.startDevice(
      { port: handle.port, secret: handle.secret, streamToken: handle.streamToken },
      udid,
      this.session.abort.signal,
    );
    if (this.session?.device.udid !== udid) return;

    this.deps.driver.invalidateBooted();

    const socket = new HidSocket({
      port: handle.port,
      udid,
      secret: handle.secret,
      onConfig: (config) => this.handleConfig(udid, config),
      onClose: (reason) => this.handleSocketClose(udid, reason),
    });
    await socket.open();
    if (this.session?.device.udid !== udid) {
      socket.close();
      return;
    }

    this.generation += 1;
    this.session.hid = socket;
    // `0x82` is only pushed once a frame has arrived: `attachHidSocket` sends
    // the config frame `if (configFrame())`, and that returns null while the
    // size is still 0x0. So "we have a socket" does not mean "we have
    // dimensions", and "Waiting for the first frame" is a real state rather
    // than a loading state.
    this.session.kind = socket.screen() === null ? "waiting-frame" : "streaming";
    this.session.screen = socket.screen();
    this.deps.publish();

    detach(
      () => this.refreshForeground(udid),
      () => {
        // The accessibility service warms up after the device does; a missing
        // foreground app in the first seconds is normal.
      },
    );
  }

  private handleConfig(udid: string, config: ScreenConfig): void {
    if (this.session?.device.udid !== udid) return;
    this.session.screen = config;
    if (config.width > 0 && config.height > 0) {
      // A frame arrived, which clears both "waiting" and any restart notice.
      if (this.session.kind !== "erasing" && this.session.kind !== "dead") {
        this.session.kind = "streaming";
        this.session.reason = null;
      }
    }
    this.deps.publish();
  }

  private handleSocketClose(udid: string, reason: string): void {
    if (this.session?.device.udid !== udid) return;
    if (this.session.kind === "erasing" || this.session.kind === "dead") return;
    this.session.hid = null;
    this.session.kind = "stalled";
    this.deps.publish();
    detach(
      () => this.recheckDevice(udid),
      (error) => this.deps.log("warn", `could not recheck ${udid} after ${reason}: ${describe(error)}`),
    );
  }

  /** The panel's watchdog fired. One `simctl` call, in response to one event. */
  async reportStall(): Promise<LiveState> {
    const session = this.session;
    if (session === null) return this.state();
    if (session.kind === "streaming" || session.kind === "waiting-frame") {
      session.kind = "stalled";
      this.deps.publish();
    }
    await this.recheckDevice(session.device.udid);
    return this.state();
  }

  private async recheckDevice(udid: string): Promise<void> {
    this.deps.driver.invalidateBooted();
    let booted: boolean;
    try {
      booted = await this.deps.driver.isBooted(udid);
    } catch (error) {
      this.lastSimctlError = describe(error);
      this.deps.publish();
      return;
    }
    if (this.session?.device.udid !== udid) return;

    if (!booted) {
      this.session.hid?.close();
      this.session.hid = null;
      this.session.kind = "dead";
      this.session.reason = null;
      // Evict the child's cached capture session, or the next start reuses a
      // session bound to a dead device and produces no frames.
      const address = this.address();
      if (address !== null) {
        detach(
          () => host.shutdownDevice(address, udid),
          () => {
            // Best effort: the session is already unusable either way.
          },
        );
      }
      this.deps.publish();
      return;
    }

    // The device is alive and the stream is not. Reconnect rather than
    // reporting a device problem that is not one.
    if (this.session.hid === null && this.viewers > 0) {
      detach(
        () => this.attach(udid),
        (error) => this.deps.log("warn", `reconnect failed: ${describe(error)}`),
      );
    }
  }

  private async refreshForeground(udid: string): Promise<void> {
    const address = this.address();
    if (address === null) return;
    const app = await host.foregroundApp(address, udid);
    if (this.session?.device.udid !== udid) return;
    // A failed probe leaves the timestamp alone, so the next request retries
    // rather than trusting a silence.
    if (app.bundleId !== null) this.session.foregroundCheckedAt = this.now();
    if (this.session.foregroundBundleId === app.bundleId) return;
    this.session.foregroundBundleId = app.bundleId;
    this.deps.publish();
  }

  /**
   * Refresh the foreground app if it has gone stale, without blocking the
   * caller.
   *
   * Called from the `liveState` handler: a mounted panel asking for state is
   * the event. When the answer changes, the realtime signal brings the panel
   * back for it.
   */
  noteStateRead(): void {
    const session = this.session;
    if (session === null || session.kind !== "streaming") return;
    if (this.now() - session.foregroundCheckedAt < FOREGROUND_STALE_MS) return;
    // Claim the window immediately so a burst of reads produces one probe.
    session.foregroundCheckedAt = this.now();
    detach(
      () => this.refreshForeground(session.device.udid),
      () => {
        // The accessibility service is still warming up. The next read retries.
      },
    );
  }

  /** Ask again what is on screen — after a tap, a capture, or on demand. */
  async pollForeground(): Promise<string | null> {
    const session = this.session;
    if (session === null) return null;
    await this.refreshForeground(session.device.udid);
    return this.session?.foregroundBundleId ?? null;
  }

  async detachDevice(): Promise<void> {
    const session = this.session;
    if (session === null) return;
    session.abort.abort();
    session.hid?.close();
    this.session = null;
    this.deps.publish();
  }

  async stop(): Promise<LiveState> {
    await this.detachDevice();
    return this.state();
  }

  /**
   * Erase gets its own state, because erase shuts the device down: without it
   * the panel says "iPhone 17 Pro shut down" seconds after you asked it to
   * erase, which reads as a crash.
   */
  async erase(udid: string): Promise<void> {
    const session = this.session;
    if (session?.device.udid === udid) {
      session.hid?.close();
      session.hid = null;
      session.kind = "erasing";
      this.deps.publish();
    }
    const address = this.address();
    if (address !== null) await host.shutdownDevice(address, udid);
    await this.deps.driver.erase(udid);
    if (this.session?.device.udid === udid) {
      // Erase leaves the device shut down. Bring it back, because the user
      // asked to erase it rather than to lose it.
      detach(
        () => this.attach(udid),
        (error) => {
          if (this.session?.device.udid !== udid) return;
          this.session.kind = "boot-failed";
          this.session.reason = describe(error);
          this.deps.publish();
        },
      );
    }
  }

  async shutdown(udid: string): Promise<void> {
    const address = this.address();
    if (address !== null) {
      // Through the child, so its cached capture session is evicted too.
      await host.shutdownDevice(address, udid);
    } else {
      await this.deps.driver.shutdown(udid);
    }
    this.deps.driver.invalidateBooted();
    if (this.session?.device.udid === udid) {
      this.session.hid?.close();
      this.session.hid = null;
      this.session.kind = "dead";
      this.deps.publish();
    }
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /** The control socket for the current device, or a sentence saying why not. */
  requireSocket(): HidSocket {
    const session = this.session;
    if (session === null) throw new Error("No simulator is running.");
    if (session.hid === null) {
      throw new Error(`${session.device.name} is not accepting input right now.`);
    }
    return session.hid;
  }

  async button(name: ButtonName): Promise<void> {
    this.requireSocket().button(name);
    // The home screen is a different meta line, and a button is the commonest
    // way to get there.
    if (name === "home" || name === "swipe_home") {
      const session = this.session;
      if (session !== null) {
        detach(
          () => this.refreshForeground(session.device.udid),
          () => {},
        );
      }
    }
  }

  rotate(orientation: Orientation): void {
    this.requireSocket().rotate(orientation);
  }

  // -------------------------------------------------------------------------
  // Device resolution
  // -------------------------------------------------------------------------

  private async resolveDevice(query: string | null, signal?: AbortSignal): Promise<LiveDevice | null> {
    let devices: SimDevice[];
    try {
      devices = await this.deps.driver.list(signal);
      this.lastSimctlError = null;
    } catch (error) {
      this.lastSimctlError = error instanceof SimctlError ? error.message : describe(error);
      return null;
    }
    const wanted = query ?? this.deps.defaultDevice();
    const found =
      wanted.trim() === "" ? pickDefaultDevice(devices) : findDeviceByNameOrUdid(devices, wanted);
    if (found === null) return null;
    return { udid: found.udid, name: found.name, osVersion: found.osVersion };
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /**
   * The whole state, in one object, computed rather than stored.
   *
   * Every branch here has exactly one sentence in the frontend, and the
   * frontend tests assert the sentence rather than the branch — the sentence is
   * the contract.
   */
  state(): LiveState {
    const base: LiveState = {
      kind: "idle",
      device: null,
      screen: null,
      foregroundBundleId: null,
      reason: null,
      crashes: this.crashTimestamps.length,
      slowBoot: false,
      generation: this.generation,
    };

    if (!this.deps.isMac) return { ...base, kind: "unsupported" };
    if (this.lastSimctlError !== null) {
      return { ...base, kind: "simctl-failed", reason: this.lastSimctlError };
    }
    if (!this.deps.isAppleSilicon && !this.deps.allowIntelLive()) {
      return { ...base, kind: "intel-blocked" };
    }

    const session = this.session;
    if (session === null) return base;

    return {
      ...base,
      kind: session.kind,
      device: session.device,
      screen: session.screen,
      foregroundBundleId: session.foregroundBundleId,
      reason: session.reason,
      slowBoot: session.kind === "booting" && this.now() - session.startedAt > SLOW_BOOT_MS,
    };
  }

  /**
   * Everything the picker needs, in one `simctl` call.
   *
   * A failed `simctl list` is not "no devices exist" — it is its own state with
   * its own sentence, which is why the failure is thrown rather than swallowed
   * into an empty array.
   */
  async devices(signal?: AbortSignal): Promise<{
    devices: SimDevice[];
    bootedUdids: string[];
    suggested: LiveDevice | null;
    hasDrivableRuntime: boolean;
    installedPlatforms: string[];
  }> {
    const [all, runtimes] = await Promise.all([
      this.deps.driver.list(signal),
      this.deps.driver.runtimes(signal).catch(() => []),
    ]);
    this.lastSimctlError = null;
    const booted = all.filter((device) => device.state === "Booted").map((device) => device.udid);
    const suggestion = pickDefaultDevice(all);
    const installedPlatforms = [
      ...new Set(runtimes.filter((runtime) => runtime.isAvailable).map((runtime) => runtime.platform)),
    ];
    return {
      devices: all,
      bootedUdids: booted,
      suggested:
        suggestion === null
          ? null
          : { udid: suggestion.udid, name: suggestion.name, osVersion: suggestion.osVersion },
      hasDrivableRuntime: installedPlatforms.some((platform) =>
        (DRIVABLE_PLATFORMS as readonly string[]).includes(platform),
      ),
      installedPlatforms,
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimers();
    await this.detachDevice();
    this.stopHost();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
