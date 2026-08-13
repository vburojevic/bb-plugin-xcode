/**
 * `simctl`, and the small amount of judgement around it.
 *
 * Two rules run through this file. A failed `simctl list` is **never** read as
 * "no devices exist" — it is its own state with its own sentence, because
 * silently reporting an empty device list to someone with twelve simulators is
 * how a tool loses trust in one screen. And the booted set is cached for one
 * second, because every `/helper/…` request has to be preceded by a fresh
 * `Booted` confirmation and a UDID from our own cache is untrusted input: the
 * user can shut the device down between our poll and our request.
 */
import { run } from "./exec.js";

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  /** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` */
  runtimeId: string;
  /** `26.5`, parsed from the runtime identifier — never from a display string. */
  osVersion: string;
  platform: Platform;
  isAvailable: boolean;
}

export type Platform = "iOS" | "iPadOS" | "tvOS" | "watchOS" | "visionOS" | "unknown";

/** Families Live can drive. watchOS and visionOS are excluded deliberately. */
export const DRIVABLE_PLATFORMS: readonly Platform[] = ["iOS", "iPadOS", "tvOS"];

interface SimctlDeviceRow {
  udid?: unknown;
  name?: unknown;
  state?: unknown;
  isAvailable?: unknown;
  availabilityError?: unknown;
}

interface SimctlListDevices {
  devices?: Record<string, SimctlDeviceRow[]>;
}

interface SimctlRuntimeRow {
  identifier?: unknown;
  version?: unknown;
  name?: unknown;
  isAvailable?: unknown;
  platform?: unknown;
}

interface SimctlListRuntimes {
  runtimes?: SimctlRuntimeRow[];
}

export interface Runtime {
  identifier: string;
  version: string;
  name: string;
  platform: Platform;
  isAvailable: boolean;
}

export function platformOfRuntime(identifier: string): Platform {
  if (identifier.includes(".iOS-")) return "iOS";
  if (identifier.includes(".tvOS-")) return "tvOS";
  if (identifier.includes(".watchOS-")) return "watchOS";
  if (identifier.includes(".xrOS-") || identifier.includes(".visionOS-")) return "visionOS";
  return "unknown";
}

/**
 * `com.apple.CoreSimulator.SimRuntime.iOS-26-5` → `26.5`.
 *
 * Parsed from the identifier rather than the display name because the name is
 * localized and the identifier is not.
 */
export function versionOfRuntime(identifier: string): string {
  const match = /-(\d+(?:-\d+)*)$/.exec(identifier);
  if (!match) return "";
  return match[1]!.split("-").join(".");
}

/** Compare two dotted versions numerically. `26.10` sorts above `26.5`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function parseDeviceList(json: SimctlListDevices): SimDevice[] {
  const out: SimDevice[] = [];
  for (const [runtimeId, rows] of Object.entries(json.devices ?? {})) {
    if (!Array.isArray(rows)) continue;
    const platformFromRuntime = platformOfRuntime(runtimeId);
    for (const row of rows) {
      if (typeof row.udid !== "string" || typeof row.name !== "string") continue;
      out.push({
        udid: row.udid,
        name: row.name,
        state: typeof row.state === "string" ? row.state : "Unknown",
        runtimeId,
        osVersion: versionOfRuntime(runtimeId),
        // iPads report an iOS runtime; the family lives in the device name.
        platform:
          platformFromRuntime === "iOS" && /ipad/i.test(row.name) ? "iPadOS" : platformFromRuntime,
        isAvailable: row.isAvailable !== false && row.availabilityError === undefined,
      });
    }
  }
  return out;
}

export function parseRuntimeList(json: SimctlListRuntimes): Runtime[] {
  const out: Runtime[] = [];
  for (const row of json.runtimes ?? []) {
    if (typeof row.identifier !== "string") continue;
    out.push({
      identifier: row.identifier,
      version: typeof row.version === "string" ? row.version : versionOfRuntime(row.identifier),
      name: typeof row.name === "string" ? row.name : row.identifier,
      platform: platformOfRuntime(row.identifier),
      isAvailable: row.isAvailable !== false,
    });
  }
  return out;
}

/**
 * The model number in a device name: `iPhone 17 Pro Max` → 17.
 *
 * `0` for a name that carries no number, which is how `iPhone Air` and
 * `iPhone SE` end up below the numbered line-up rather than above it —
 * alphabetical order puts "Air" ahead of "17", which is the opposite of what
 * "newest" means to anyone.
 */
export function modelNumber(name: string): number {
  const match = /\b(\d{1,2})\b/.exec(name);
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
}

/** `Pro Max` over `Pro` over `Plus` over the base model. */
export function modelTier(name: string): number {
  if (/pro\s*max/i.test(name)) return 3;
  if (/\bpro\b/i.test(name)) return 2;
  if (/\bplus\b/i.test(name)) return 1;
  return 0;
}

/**
 * The device the Boot button names.
 *
 * Newest iPhone on the newest runtime; failing that the newest device of any
 * drivable family, so a Mac with only iPads still gets a button that says what
 * it will do. Returns `null` when nothing drivable exists at all, which is a
 * different sentence entirely.
 *
 * The ordering is deliberately explainable rather than clever, because the
 * button names its own consequence: getting it wrong costs one dropdown, and
 * getting it *inconsistently* wrong costs trust.
 */
export function pickDefaultDevice(devices: readonly SimDevice[]): SimDevice | null {
  const available = devices.filter((d) => d.isAvailable && DRIVABLE_PLATFORMS.includes(d.platform));
  if (available.length === 0) return null;

  const family = (device: SimDevice): number => {
    if (/^iPhone/i.test(device.name)) return 0;
    if (/^iPad/i.test(device.name)) return 1;
    if (/^Apple\s*TV/i.test(device.name)) return 2;
    // A simulator someone renamed for a branch is not the one they mean.
    return 3;
  };

  return [...available].sort((a, b) => {
    const byFamily = family(a) - family(b);
    if (byFamily !== 0) return byFamily;
    const byOs = compareVersions(b.osVersion, a.osVersion);
    if (byOs !== 0) return byOs;
    const byModel = modelNumber(b.name) - modelNumber(a.name);
    if (byModel !== 0) return byModel;
    const byTier = modelTier(b.name) - modelTier(a.name);
    if (byTier !== 0) return byTier;
    const byName = a.name.localeCompare(b.name, "en", { numeric: true });
    if (byName !== 0) return byName;
    return a.udid.localeCompare(b.udid);
  })[0]!;
}

export function findDeviceByNameOrUdid(
  devices: readonly SimDevice[],
  query: string,
): SimDevice | null {
  const wanted = query.trim();
  if (wanted === "") return null;
  const byUdid = devices.find((d) => d.udid.toLowerCase() === wanted.toLowerCase());
  if (byUdid) return byUdid;
  const exact = devices.filter((d) => d.name.toLowerCase() === wanted.toLowerCase());
  if (exact.length > 0) {
    return [...exact].sort((a, b) => compareVersions(b.osVersion, a.osVersion))[0]!;
  }
  const partial = devices.filter((d) => d.name.toLowerCase().includes(wanted.toLowerCase()));
  if (partial.length > 0) {
    return [...partial].sort((a, b) => compareVersions(b.osVersion, a.osVersion))[0]!;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export class SimctlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimctlError";
  }
}

const BOOTED_CACHE_MS = 1000;

export interface DeviceDriverOptions {
  /** Test seam: a fake `simctl` for the Linux suite. */
  runner?: typeof run;
  now?: () => number;
}

export class DeviceDriver {
  private readonly runner: typeof run;
  private readonly now: () => number;
  private bootedCache: { at: number; udids: Set<string> } | null = null;

  constructor(options: DeviceDriverOptions = {}) {
    this.runner = options.runner ?? run;
    this.now = options.now ?? Date.now;
  }

  async list(signal?: AbortSignal): Promise<SimDevice[]> {
    const result = await this.runner("xcrun", ["simctl", "list", "devices", "-j"], {
      timeoutMs: 20_000,
      signal,
    });
    if (result.code !== 0) {
      throw new SimctlError(
        result.stderr.trim() || `xcrun simctl list exited ${result.code ?? "with a signal"}`,
      );
    }
    try {
      return parseDeviceList(JSON.parse(result.stdout) as SimctlListDevices);
    } catch {
      throw new SimctlError("xcrun simctl list did not return JSON");
    }
  }

  async runtimes(signal?: AbortSignal): Promise<Runtime[]> {
    const result = await this.runner("xcrun", ["simctl", "list", "runtimes", "-j"], {
      timeoutMs: 20_000,
      signal,
    });
    if (result.code !== 0) {
      throw new SimctlError(
        result.stderr.trim() || `xcrun simctl list runtimes exited ${result.code ?? "with a signal"}`,
      );
    }
    try {
      return parseRuntimeList(JSON.parse(result.stdout) as SimctlListRuntimes);
    } catch {
      throw new SimctlError("xcrun simctl list runtimes did not return JSON");
    }
  }

  /**
   * The booted set, cached for one second.
   *
   * Every `/helper/…` request is gated on this. serve-sim's device session
   * assumes a booted device and its failure modes are not graceful, so the
   * confirmation is cheap insurance against a UDID that was true a moment ago.
   */
  async bootedUdids(signal?: AbortSignal): Promise<Set<string>> {
    const at = this.now();
    if (this.bootedCache !== null && at - this.bootedCache.at < BOOTED_CACHE_MS) {
      return this.bootedCache.udids;
    }
    const result = await this.runner("xcrun", ["simctl", "list", "devices", "booted", "-j"], {
      timeoutMs: 10_000,
      signal,
    });
    if (result.code !== 0) {
      throw new SimctlError(result.stderr.trim() || "xcrun simctl list devices booted failed");
    }
    let udids: Set<string>;
    try {
      const parsed = parseDeviceList(JSON.parse(result.stdout) as SimctlListDevices);
      udids = new Set(parsed.filter((d) => d.state === "Booted").map((d) => d.udid));
    } catch {
      throw new SimctlError("xcrun simctl list devices booted did not return JSON");
    }
    this.bootedCache = { at, udids };
    return udids;
  }

  /** Force the next `bootedUdids` to ask, after we changed the world ourselves. */
  invalidateBooted(): void {
    this.bootedCache = null;
  }

  async isBooted(udid: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.bootedUdids(signal)).has(udid);
  }

  /**
   * Boot, and translate simctl's failures into sentences with a fix in them.
   *
   * `bootstatus -b` blocks until the device is usable — up to three minutes on
   * a first boot after an Xcode update — so this is never awaited inside an RPC
   * handler.
   */
  async boot(udid: string, signal?: AbortSignal): Promise<void> {
    this.invalidateBooted();
    const boot = await this.runner("xcrun", ["simctl", "boot", udid], {
      timeoutMs: 120_000,
      signal,
    });
    if (boot.code !== 0) {
      const stderr = boot.stderr.trim();
      // Already booted is success — we asked for a booted device and there is one.
      if (/Unable to boot device in current state: Booted/i.test(stderr)) return;
      throw new SimctlError(explainBootFailure(stderr));
    }
    const status = await this.runner("xcrun", ["simctl", "bootstatus", udid, "-b"], {
      timeoutMs: 300_000,
      signal,
    });
    if (status.code !== 0) {
      // bootstatus exits non-zero even when the device is fine; believe the
      // device, not the exit code.
      this.invalidateBooted();
      if (await this.isBooted(udid, signal)) return;
      throw new SimctlError(explainBootFailure(status.stderr.trim() || status.stdout.trim()));
    }
    this.invalidateBooted();
  }

  async shutdown(udid: string, signal?: AbortSignal): Promise<void> {
    this.invalidateBooted();
    const result = await this.runner("xcrun", ["simctl", "shutdown", udid], {
      timeoutMs: 60_000,
      signal,
    });
    this.invalidateBooted();
    if (result.code !== 0 && !/current state: Shutdown/i.test(result.stderr)) {
      throw new SimctlError(result.stderr.trim() || "Could not shut the simulator down.");
    }
  }

  async erase(udid: string, signal?: AbortSignal): Promise<void> {
    this.invalidateBooted();
    const result = await this.runner("xcrun", ["simctl", "erase", udid], {
      timeoutMs: 120_000,
      signal,
    });
    this.invalidateBooted();
    if (result.code !== 0) {
      throw new SimctlError(result.stderr.trim() || "Could not erase the simulator.");
    }
  }

  /** Create the dedicated stills device, so a render never fights the one you are watching. */
  async create(name: string, deviceTypeId: string, runtimeId: string, signal?: AbortSignal): Promise<string> {
    const result = await this.runner("xcrun", ["simctl", "create", name, deviceTypeId, runtimeId], {
      timeoutMs: 120_000,
      signal,
    });
    if (result.code !== 0) {
      throw new SimctlError(result.stderr.trim() || "Could not create a simulator.");
    }
    const udid = result.stdout.trim();
    if (!/^[0-9A-Fa-f-]{36}$/.test(udid)) {
      throw new SimctlError("xcrun simctl create did not return a device identifier.");
    }
    return udid;
  }
}

/**
 * Translate simctl's boot failures into something with a next step in it.
 *
 * Falls through to the raw message rather than losing it: an unrecognized
 * failure named exactly is more useful than a friendly sentence about the wrong
 * thing.
 */
export function explainBootFailure(stderr: string): string {
  const text = stderr.trim();
  const runtime = /runtime.*?(\b\d+\.\d+\b).*?(?:not|isn't|is not)\s+(?:downloaded|available|installed)/i.exec(text);
  if (runtime) {
    return `iOS ${runtime[1]} is not downloaded. Get it in Xcode → Settings → Components.`;
  }
  if (/current state: Booting/i.test(text)) {
    return "That simulator is already booting.";
  }
  if (/Invalid device/i.test(text)) {
    return "That simulator no longer exists. Refresh the device list.";
  }
  if (/failed to (?:install|open) the runtime|Failed to load CoreSimulator/i.test(text)) {
    return "The simulator runtime failed to load. Restarting the Mac usually clears this.";
  }
  return text === "" ? "The simulator did not boot, and simctl said nothing about why." : text;
}
