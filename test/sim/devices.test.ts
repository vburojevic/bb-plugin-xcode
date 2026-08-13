import { describe, expect, it, vi } from "vitest";
import {
  compareVersions,
  DeviceDriver,
  explainBootFailure,
  findDeviceByNameOrUdid,
  parseDeviceList,
  parseRuntimeList,
  pickDefaultDevice,
  platformOfRuntime,
  SimctlError,
  versionOfRuntime,
} from "../../src/sim/devices.js";
import type { RunResult } from "../../src/sim/exec.js";

const IOS_26_5 = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
const IOS_26_0 = "com.apple.CoreSimulator.SimRuntime.iOS-26-0";
const WATCH = "com.apple.CoreSimulator.SimRuntime.watchOS-12-0";

function udid(n: number): string {
  return `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
}

const SAMPLE = {
  devices: {
    [IOS_26_5]: [
      { udid: udid(1), name: "iPhone 17", state: "Shutdown", isAvailable: true },
      { udid: udid(2), name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
      { udid: udid(3), name: "iPad Pro 13-inch (M5)", state: "Shutdown", isAvailable: true },
    ],
    [IOS_26_0]: [{ udid: udid(4), name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true }],
    [WATCH]: [{ udid: udid(5), name: "Apple Watch Series 11", state: "Shutdown", isAvailable: true }],
  },
};

describe("runtime identifiers", () => {
  it("reads the version from the identifier, not from a display name", () => {
    // The display name is localized; the identifier is not.
    expect(versionOfRuntime(IOS_26_5)).toBe("26.5");
    expect(versionOfRuntime(IOS_26_0)).toBe("26.0");
    expect(versionOfRuntime("nonsense")).toBe("");
  });

  it("recognises each platform", () => {
    expect(platformOfRuntime(IOS_26_5)).toBe("iOS");
    expect(platformOfRuntime(WATCH)).toBe("watchOS");
    expect(platformOfRuntime("com.apple.CoreSimulator.SimRuntime.xrOS-3-0")).toBe("visionOS");
    expect(platformOfRuntime("com.apple.CoreSimulator.SimRuntime.tvOS-19-0")).toBe("tvOS");
  });

  it("compares versions numerically", () => {
    // "26.10" sorts above "26.5", which string comparison gets backwards.
    expect(compareVersions("26.10", "26.5")).toBeGreaterThan(0);
    expect(compareVersions("26.5", "26.5")).toBe(0);
  });
});

describe("parsing", () => {
  it("puts iPads in their own family even on an iOS runtime", () => {
    const devices = parseDeviceList(SAMPLE);
    expect(devices.find((device) => device.udid === udid(3))?.platform).toBe("iPadOS");
    expect(devices.find((device) => device.udid === udid(2))?.platform).toBe("iOS");
  });

  it("treats an availabilityError as unavailable", () => {
    const devices = parseDeviceList({
      devices: {
        [IOS_26_5]: [
          { udid: udid(9), name: "Broken", state: "Shutdown", availabilityError: "runtime missing" },
        ],
      },
    });
    expect(devices[0]?.isAvailable).toBe(false);
  });

  it("skips rows with no identity rather than inventing one", () => {
    const devices = parseDeviceList({ devices: { [IOS_26_5]: [{ state: "Booted" }] } });
    expect(devices).toEqual([]);
  });

  it("parses runtimes", () => {
    const runtimes = parseRuntimeList({
      runtimes: [{ identifier: IOS_26_5, version: "26.5", name: "iOS 26.5", isAvailable: true }],
    });
    expect(runtimes[0]).toMatchObject({ platform: "iOS", version: "26.5", isAvailable: true });
  });
});

describe("picking the default device", () => {
  it("prefers the newest iPhone on the newest runtime", () => {
    // The Boot button names the device it would actually pick, so this choice
    // is user-visible and has to be the obvious one.
    const picked = pickDefaultDevice(parseDeviceList(SAMPLE));
    expect(picked?.name).toBe("iPhone 17 Pro");
    expect(picked?.osVersion).toBe("26.5");
  });

  it("ranks by model number rather than alphabetically", () => {
    // Measured on a real Mac: alphabetical order picked "iPhone Air" over
    // "iPhone 17 Pro", because "A" sorts above "1". That is the opposite of
    // what "newest" means to anyone.
    const devices = parseDeviceList({
      devices: {
        [IOS_26_5]: [
          { udid: udid(1), name: "iPhone Air", state: "Shutdown", isAvailable: true },
          { udid: udid(2), name: "iPhone 17 Pro", state: "Shutdown", isAvailable: true },
          { udid: udid(3), name: "iPhone 17 Pro Max", state: "Shutdown", isAvailable: true },
          { udid: udid(4), name: "iPhone 16", state: "Shutdown", isAvailable: true },
        ],
      },
    });
    expect(pickDefaultDevice(devices)?.name).toBe("iPhone 17 Pro Max");
  });

  it("ignores simulators someone renamed for a branch", () => {
    // A Mac used for agent work accumulates dozens of these. None of them is
    // the device the user means.
    const devices = parseDeviceList({
      devices: {
        [IOS_26_5]: [
          { udid: udid(1), name: "zzz-feature-branch-test", state: "Shutdown", isAvailable: true },
          { udid: udid(2), name: "iPhone 17", state: "Shutdown", isAvailable: true },
        ],
      },
    });
    expect(pickDefaultDevice(devices)?.name).toBe("iPhone 17");
  });

  it("falls back to the newest device of any drivable family", () => {
    const iPadsOnly = parseDeviceList({
      devices: { [IOS_26_5]: [{ udid: udid(3), name: "iPad Pro 13-inch (M5)", state: "Shutdown", isAvailable: true }] },
    });
    expect(pickDefaultDevice(iPadsOnly)?.name).toBe("iPad Pro 13-inch (M5)");
  });

  it("returns nothing when only non-drivable families are installed", () => {
    // watchOS gets its own sentence rather than a button that cannot work.
    const watchOnly = parseDeviceList({ devices: { [WATCH]: SAMPLE.devices[WATCH]! } });
    expect(pickDefaultDevice(watchOnly)).toBeNull();
  });
});

describe("finding a device by name", () => {
  const devices = parseDeviceList(SAMPLE);

  it("matches a UDID exactly and case-insensitively", () => {
    expect(findDeviceByNameOrUdid(devices, udid(2).toUpperCase())?.name).toBe("iPhone 17 Pro");
  });

  it("prefers the newest runtime when a name is ambiguous", () => {
    expect(findDeviceByNameOrUdid(devices, "iPhone 17 Pro")?.osVersion).toBe("26.5");
  });

  it("falls back to a partial match", () => {
    expect(findDeviceByNameOrUdid(devices, "ipad")?.name).toBe("iPad Pro 13-inch (M5)");
  });

  it("answers null rather than guessing", () => {
    expect(findDeviceByNameOrUdid(devices, "Pixel")).toBeNull();
    expect(findDeviceByNameOrUdid(devices, "")).toBeNull();
  });
});

describe("boot failures", () => {
  it("names the fix when the runtime is not downloaded", () => {
    expect(explainBootFailure("The runtime 26.5 is not downloaded")).toBe(
      "iOS 26.5 is not downloaded. Get it in Xcode → Settings → Components.",
    );
  });

  it("recognises a device that is already on its way up", () => {
    expect(explainBootFailure("Unable to boot device in current state: Booting")).toBe(
      "That simulator is already booting.",
    );
  });

  it("keeps the raw message rather than losing it", () => {
    // An unrecognized failure named exactly is more useful than a friendly
    // sentence about the wrong thing.
    expect(explainBootFailure("something nobody anticipated")).toBe("something nobody anticipated");
  });

  it("says something even when simctl said nothing", () => {
    expect(explainBootFailure("")).toBe(
      "The simulator did not boot, and simctl said nothing about why.",
    );
  });
});

describe("the driver", () => {
  function fakeRunner(result: Partial<RunResult>) {
    return vi.fn(
      async () =>
        ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...result }) as RunResult,
    );
  }

  it("throws rather than reporting an empty device list", async () => {
    // A failed `simctl list` is not "no devices exist". Saying so to someone
    // with twelve simulators is how a tool loses trust in one screen.
    const driver = new DeviceDriver({ runner: fakeRunner({ code: 1, stderr: "xcrun: error" }) });
    await expect(driver.list()).rejects.toBeInstanceOf(SimctlError);
  });

  it("throws when simctl answers with something that is not JSON", async () => {
    const driver = new DeviceDriver({ runner: fakeRunner({ stdout: "<html>" }) });
    await expect(driver.list()).rejects.toThrow(/did not return JSON/);
  });

  it("caches the booted set for one second, and no longer", async () => {
    // Every `/helper/…` request is gated on a fresh `Booted` confirmation,
    // because a UDID from our own cache is untrusted input: the user can shut
    // the device down between our poll and our request.
    let now = 1000;
    const runner = fakeRunner({ stdout: JSON.stringify(SAMPLE) });
    const driver = new DeviceDriver({ runner, now: () => now });

    await driver.bootedUdids();
    await driver.bootedUdids();
    expect(runner).toHaveBeenCalledTimes(1);

    now += 1001;
    await driver.bootedUdids();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("drops the cache the moment we change the world ourselves", async () => {
    const runner = fakeRunner({ stdout: JSON.stringify(SAMPLE) });
    const driver = new DeviceDriver({ runner, now: () => 1000 });
    await driver.bootedUdids();
    driver.invalidateBooted();
    await driver.bootedUdids();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("treats an already-booted device as a successful boot", async () => {
    const runner = vi.fn(
      async (_cmd: string, args: readonly string[]) =>
        ({
          code: args[1] === "boot" ? 1 : 0,
          signal: null,
          stdout: "",
          stderr: args[1] === "boot" ? "Unable to boot device in current state: Booted" : "",
          timedOut: false,
        }) as RunResult,
    );
    const driver = new DeviceDriver({ runner });
    await expect(driver.boot(udid(2))).resolves.toBeUndefined();
    // It returned before running bootstatus: we asked for a booted device and
    // there is one.
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("believes the device rather than bootstatus's exit code", async () => {
    // bootstatus exits non-zero even when the device is actually ready.
    const runner = vi.fn(
      async (_cmd: string, args: readonly string[]) =>
        ({
          code: args[1] === "bootstatus" ? 1 : 0,
          signal: null,
          stdout: args[2] === "devices" || args[1] === "list" ? JSON.stringify(SAMPLE) : "",
          stderr: "",
          timedOut: false,
        }) as RunResult,
    );
    const driver = new DeviceDriver({ runner });
    await expect(driver.boot(udid(2))).resolves.toBeUndefined();
  });
});
