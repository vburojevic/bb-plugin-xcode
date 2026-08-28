/**
 * The live state machine's honesty tests.
 *
 * What is asserted here is not mechanics but *sentences*: when the service
 * claims "stalled", when it takes the claim back, and when it keeps its mouth
 * shut. Every one of these was a way the panel used to lie — a stall declared
 * over a playing video, a crash count that never forgot, a clear that could
 * raise the dead.
 *
 * The capture host, the HID socket and simctl are all faked at the module
 * seam, so this runs anywhere with no simulator and no Mac.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  interface FakeScreen {
    width: number;
    height: number;
    orientation: string;
  }

  class FakeHidSocket {
    static instances: FakeHidSocket[] = [];
    config: FakeScreen | null = null;
    closed = false;
    constructor(
      public options: {
        port: number;
        udid: string;
        secret: string;
        onConfig: (config: FakeScreen) => void;
        onClose: (reason: string) => void;
      },
    ) {
      FakeHidSocket.instances.push(this);
    }
    screen(): FakeScreen | null {
      return this.config;
    }
    async open(): Promise<void> {
      this.config = { width: 1170, height: 2532, orientation: "portrait" };
      this.options.onConfig(this.config);
    }
    close(): void {
      this.closed = true;
    }
    button(): void {}
    rotate(): void {}
    simulateClose(reason = "closed"): void {
      this.options.onClose(reason);
    }
  }

  const state = {
    exitHandler: null as
      | null
      | ((info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void),
    handle: {
      port: 51234,
      secret: "s".repeat(32),
      streamToken: "t".repeat(32),
      addonLoaded: true,
      addonError: null,
      stop: vi.fn(),
      isAlive: () => true,
    },
    startDevice: vi.fn(() => Promise.resolve()),
  };

  return { FakeHidSocket, state };
});

vi.mock("../../src/sim/hid.js", () => ({ HidSocket: mocks.FakeHidSocket }));

vi.mock("../../src/sim/sim-host-sup.js", () => ({
  startSimHost: (
    _deps: unknown,
    events: {
      onExit: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void;
      onLog: (line: string) => void;
    },
  ) => {
    mocks.state.exitHandler = events.onExit;
    return Promise.resolve(mocks.state.handle);
  },
}));

vi.mock("../../src/sim/sim-host-client.js", () => ({
  startDevice: mocks.state.startDevice,
  shutdownDevice: () => Promise.resolve(),
  foregroundApp: () => Promise.resolve({ bundleId: null, pid: null }),
}));

import { LiveService, type LiveDeps } from "../../src/sim/live.js";
import type { DeviceDriver, SimDevice } from "../../src/sim/devices.js";

const DEVICE: SimDevice = {
  udid: "11111111-2222-3333-4444-555555555555",
  name: "iPhone 17 Pro",
  state: "Shutdown",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-5",
  osVersion: "26.5",
  platform: "iOS",
  family: "iphone",
  isAvailable: true,
  lastBootedAt: null,
};

let now = 1_000_000;

function makeDeps(booted: Set<string>): LiveDeps {
  return {
    driver: {
      list: async () => [DEVICE],
      runtimes: async () => [],
      isBooted: async (udid: string) => booted.has(udid),
      invalidateBooted: () => {},
      shutdown: async () => {},
      erase: async () => {},
    } as unknown as DeviceDriver,
    spawn: () => ({ execPath: "node", simHostPath: "/dev/null", env: {} }),
    allowIntelLive: () => false,
    defaultDevice: () => DEVICE.name,
    isAppleSilicon: true,
    isMac: true,
    log: () => {},
    publish: () => {},
    now: () => now,
  };
}

async function streamingService(booted = new Set([DEVICE.udid])): Promise<LiveService> {
  const service = new LiveService(makeDeps(booted));
  // A watcher, or every reconnect path declines to do its work.
  service.noteViewerOpened();
  await service.start(null);
  await vi.waitFor(() => expect(service.state().kind).toBe("streaming"));
  return service;
}

beforeEach(() => {
  mocks.FakeHidSocket.instances.length = 0;
  mocks.state.exitHandler = null;
  mocks.state.handle.stop.mockClear();
  mocks.state.startDevice.mockClear();
});

afterEach(() => vi.useRealTimers());

describe("viewer-idle capture parking", () => {
  it("parks once after 15 seconds, retaining the booted simulator selection", async () => {
    const booted = new Set([DEVICE.udid]);
    const service = await streamingService(booted);
    const generation = service.state().generation;
    vi.useFakeTimers();

    service.noteViewerClosed();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(service.state().kind).toBe("streaming");
    expect(mocks.state.handle.stop).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(service.state()).toMatchObject({
      kind: "waiting-frame",
      device: { udid: DEVICE.udid },
      generation,
    });
    expect(service.currentDevice()?.udid).toBe(DEVICE.udid);
    expect(booted.has(DEVICE.udid)).toBe(true);
    expect(mocks.FakeHidSocket.instances.at(-1)?.closed).toBe(true);
    expect(mocks.state.handle.stop).toHaveBeenCalledTimes(1);
    expect(service.address()).toBeNull();

    mocks.state.exitHandler!({ code: 0, signal: "SIGTERM", expected: true });
    expect(service.state().kind).toBe("waiting-frame");
  });

  it("cancels parking when a viewer returns inside 15 seconds", async () => {
    const service = await streamingService();
    vi.useFakeTimers();

    service.noteViewerClosed();
    await vi.advanceTimersByTimeAsync(14_999);
    service.noteViewerOpened();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(service.state().kind).toBe("streaming");
    expect(mocks.state.handle.stop).not.toHaveBeenCalled();
  });

  it("reattaches one parked selection with a fresh generation", async () => {
    const service = await streamingService();
    vi.useFakeTimers();
    service.noteViewerClosed();
    await vi.advanceTimersByTimeAsync(15_000);
    const parkedGeneration = service.state().generation;
    vi.useRealTimers();

    await service.start(DEVICE.udid);
    await vi.waitFor(() => expect(service.state().kind).toBe("streaming"));

    expect(service.state().generation).toBe(parkedGeneration + 1);
    expect(mocks.state.startDevice).toHaveBeenCalledTimes(2);
  });

  it("dispose clears the pending park and all live resources", async () => {
    const service = await streamingService();
    vi.useFakeTimers();
    service.noteViewerClosed();
    expect(vi.getTimerCount()).toBe(1);

    await service.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(service.currentDevice()).toBeNull();
    expect(service.address()).toBeNull();
    expect(mocks.state.handle.stop).toHaveBeenCalledTimes(1);
    expect(mocks.FakeHidSocket.instances.at(-1)?.closed).toBe(true);
  });
});

describe("the crash count", () => {
  it("decays: yesterday's crashes are not today's sentence", async () => {
    const service = await streamingService();
    mocks.state.exitHandler!({ code: null, signal: "SIGSEGV", expected: false });
    expect(service.state().crashes).toBe(1);

    now += 61_000;
    expect(service.state().crashes).toBe(0);
  });
});

describe("a dead control socket", () => {
  it("is worked on, not announced — the video plane is a different connection", async () => {
    const service = await streamingService();
    mocks.FakeHidSocket.instances.at(-1)!.simulateClose("boom");

    // No "stalled" claim: frames may be arriving fine, and only the panel can
    // know whether they are.
    expect(service.state().kind).toBe("streaming");

    // The device is alive and someone is watching, so the socket re-opens.
    await vi.waitFor(() => expect(mocks.FakeHidSocket.instances).toHaveLength(2));
  });
});

describe("a stall", () => {
  it("is reported by the panel and taken back by the panel", async () => {
    const service = await streamingService();
    await service.reportStall();
    expect(service.state().kind).toBe("stalled");

    await service.clearStall();
    expect(service.state().kind).toBe("streaming");
  });

  it("cannot be raised against nothing", async () => {
    const service = new LiveService(makeDeps(new Set()));
    await service.reportStall();
    expect(service.state().kind).toBe("idle");
  });

  it("a clear does not resurrect the dead", async () => {
    const booted = new Set([DEVICE.udid]);
    const service = await streamingService(booted);

    // The device dies; the panel's watchdog reports the stall, and the
    // recheck finds the truth.
    booted.delete(DEVICE.udid);
    await service.reportStall();
    expect(service.state().kind).toBe("dead");

    await service.clearStall();
    expect(service.state().kind).toBe("dead");
  });
});
