/**
 * Friendly rendering of xcodebuild `-destination` specifiers.
 *
 * Raw specifiers (`platform=iOS Simulator,name=iPhone 16,OS=26.0` or
 * `id=B3C7738C-…`) are accurate but unreadable in a list. This turns them into
 * what a developer would say: "iPhone 16 · iOS 26.0" or the simulator's actual
 * name when only a UDID is given.
 */

export interface SimulatorRef {
  udid: string;
  name: string;
  os: string;
  state: string;
}

/** Parse the comma-separated k=v pairs of a destination specifier. */
export function parseDestination(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/**
 * Human label for a destination. `simulators` (booted or known devices) lets a
 * bare `id=UDID` specifier resolve to a device name.
 */
export function destinationLabel(
  spec: string | null,
  simulators: readonly SimulatorRef[] = [],
): string | null {
  if (!spec) return null;
  const fields = parseDestination(spec);

  // A bare UDID: resolve through the simulator list when possible.
  const id = fields["id"];
  if (id) {
    const simulator = simulators.find(
      (candidate) => candidate.udid.toLowerCase() === id.toLowerCase(),
    );
    if (simulator) return `${simulator.name} · ${simulator.os}`;
    return `device ${id.slice(0, 8)}`;
  }

  const platform = fields["platform"];
  const name = fields["name"];
  const os = fields["os"];

  if (name) {
    const osPart = os ? ` · ${platformOsPrefix(platform)}${os}` : "";
    return `${name}${osPart}`;
  }
  if (platform === "macOS") return fields["arch"] ? `macOS (${fields["arch"]})` : "macOS";
  if (platform) return platform;
  // Not a k=v spec at all (e.g. already a friendly label from an xcresult).
  return spec;
}

function platformOsPrefix(platform: string | undefined): string {
  if (!platform) return "";
  if (platform.startsWith("iOS")) return "iOS ";
  if (platform.startsWith("watchOS")) return "watchOS ";
  if (platform.startsWith("tvOS")) return "tvOS ";
  if (platform.startsWith("visionOS")) return "visionOS ";
  return "";
}

/**
 * Parse `xcrun simctl list devices --json` output into a flat list.
 *
 * Runtime keys look like `com.apple.CoreSimulator.SimRuntime.iOS-26-5`; the
 * trailing segment becomes "iOS 26.5".
 */
export function parseSimctlList(json: unknown): SimulatorRef[] {
  if (typeof json !== "object" || json === null) return [];
  const devices = (json as { devices?: Record<string, unknown> }).devices;
  if (!devices || typeof devices !== "object") return [];

  const out: SimulatorRef[] = [];
  for (const [runtime, list] of Object.entries(devices)) {
    if (!Array.isArray(list)) continue;
    const osName = runtime
      .split(".")
      .pop()!
      .replace(/^([a-zA-Z]+)-(\d+)-(\d+)$/, "$1 $2.$3")
      .replace(/^([a-zA-Z]+)-(\d+)$/, "$1 $2");
    for (const device of list) {
      if (typeof device !== "object" || device === null) continue;
      const record = device as Record<string, unknown>;
      const udid = typeof record["udid"] === "string" ? record["udid"] : null;
      const name = typeof record["name"] === "string" ? record["name"] : null;
      if (!udid || !name) continue;
      out.push({
        udid,
        name,
        os: osName,
        state: typeof record["state"] === "string" ? record["state"] : "unknown",
      });
    }
  }
  return out;
}
