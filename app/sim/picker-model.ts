/**
 * What the device picker shows, decided away from the DOM.
 *
 * A Mac that has been running agents for a week has fifty simulators, most of
 * them named after a branch. The picker's job is to make the three that matter
 * reachable in one glance and the other forty-seven findable in one search:
 *
 *  - **Booted** first — they have something on screen right now.
 *  - **Recent** next — devices your work actually touched, whether by booting
 *    them or by a tracked build targeting them. `lastBuiltAt` comes from the
 *    tracker half parsing `-destination` off every xcodebuild it sees, which
 *    is evidence Xcode's own picker does not have.
 *  - Everything else grouped by runtime, newest OS first, so "iOS 26.5" reads
 *    as a shelf rather than a lottery.
 *
 * Pure, so the ordering and the labels are testable without a browser.
 */

export interface PickerDevice {
  udid: string;
  name: string;
  state: string;
  osVersion: string;
  platform: string;
  family: string;
  isAvailable: boolean;
  lastBootedAt: number | null;
  lastBuiltAt: number | null;
}

export interface RuntimeGroup {
  /** "iOS 26.5", "tvOS 26.0" — the shelf label. */
  label: string;
  devices: PickerDevice[];
}

export interface PickerSections {
  booted: PickerDevice[];
  recent: PickerDevice[];
  groups: RuntimeGroup[];
  /** Total devices that survived the query, for the empty state. */
  total: number;
}

/** Older than this and a device is not "recent", it is merely not new. */
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** More than this and Recent stops being a shortcut and becomes a second list. */
export const RECENT_LIMIT = 5;

/** When the device was last part of someone's work, by either evidence. */
export function lastUsedAt(device: PickerDevice): number | null {
  if (device.lastBootedAt === null) return device.lastBuiltAt;
  if (device.lastBuiltAt === null) return device.lastBootedAt;
  return Math.max(device.lastBootedAt, device.lastBuiltAt);
}

/**
 * The clause the picker row shows. A device mid-boot says so — it is the one
 * fact more current than any history.
 */
export function deviceClause(device: PickerDevice, now: number): string | null {
  if (device.state === "Booting") return "booting…";
  return usedClause(device, now);
}

/**
 * One clause under the device name: what it was last used *for*.
 *
 * "built against" outranks "booted" when both are recent, because it is the
 * stronger claim — a boot says the device ran; a build says your project ran
 * on it.
 */
export function usedClause(device: PickerDevice, now: number): string | null {
  const at = lastUsedAt(device);
  if (at === null) return null;
  const verb =
    device.lastBuiltAt !== null && device.lastBuiltAt >= (device.lastBootedAt ?? 0)
      ? "built against"
      : "booted";
  return `${verb} ${ago(at, now)}`;
}

/** "just now", "12m ago", "3h ago", "2d ago" — coarse on purpose. */
export function ago(at: number, now: number): string {
  const delta = Math.max(0, now - at);
  if (delta < 90_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}

/** Case-insensitive match on name, OS version, platform, or family. */
export function matchesQuery(device: PickerDevice, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  const haystack = `${device.name} ${device.platform} ${device.osVersion} ${device.family}`.toLowerCase();
  return needle.split(/\s+/).every((word) => haystack.includes(word));
}

/**
 * Newest hardware first inside a shelf: numeric-aware name comparison puts
 * "iPhone 17 Pro" above "iPhone 16 Pro" and "Pro Max" beside "Pro", which is
 * the order a person scans for.
 */
export function compareDeviceNames(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" });
}

const PLATFORM_ORDER = ["iOS", "iPadOS", "tvOS", "watchOS", "visionOS", "unknown"];

function compareGroups(a: RuntimeGroup, b: RuntimeGroup): number {
  const [platformA, versionA = ""] = a.label.split(" ");
  const [platformB, versionB = ""] = b.label.split(" ");
  if (platformA !== platformB) {
    return PLATFORM_ORDER.indexOf(platformA ?? "unknown") - PLATFORM_ORDER.indexOf(platformB ?? "unknown");
  }
  // Numeric, descending: 26.10 above 26.5, both above 18.4.
  return versionB.localeCompare(versionA, undefined, { numeric: true });
}

export function sectionDevices(
  devices: readonly PickerDevice[],
  options: { bootedUdids: readonly string[]; query: string; now: number },
): PickerSections {
  const booted = new Set(options.bootedUdids);
  const usable = devices.filter(
    (device) => device.isAvailable && matchesQuery(device, options.query),
  );

  // A device mid-boot belongs on the Booted shelf: it is about to be the most
  // interesting device on the machine, and burying it under a runtime group
  // while it boots reads as the picker not noticing.
  const bootedRows = usable
    .filter((device) => booted.has(device.udid) || device.state === "Booting")
    .sort(compareByNameWithin);

  const recentRows = usable
    .filter((device) => !booted.has(device.udid))
    .map((device) => ({ device, at: lastUsedAt(device) }))
    .filter((entry): entry is { device: PickerDevice; at: number } => entry.at !== null)
    .filter((entry) => options.now - entry.at < RECENT_WINDOW_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_LIMIT)
    .map((entry) => entry.device);

  const shelved = new Set([...bootedRows, ...recentRows].map((device) => device.udid));
  const byRuntime = new Map<string, PickerDevice[]>();
  for (const device of usable) {
    if (shelved.has(device.udid)) continue;
    const label = `${device.platform} ${device.osVersion}`.trim();
    const shelf = byRuntime.get(label) ?? [];
    shelf.push(device);
    byRuntime.set(label, shelf);
  }
  const groups = [...byRuntime.entries()]
    .map(([label, rows]) => ({ label, devices: rows.sort(compareByNameWithin) }))
    .sort(compareGroups);

  return { booted: bootedRows, recent: recentRows, groups, total: usable.length };
}

function compareByNameWithin(a: PickerDevice, b: PickerDevice): number {
  return compareDeviceNames(a.name, b.name);
}
