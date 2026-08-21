/**
 * The picker's ordering, proven: booted first, recent by evidence, everything
 * else shelved by runtime — and a search that finds one branch-named device in
 * a herd of fifty.
 */
import { describe, expect, it } from "vitest";
import {
  ago,
  compareDeviceNames,
  deviceClause,
  lastUsedAt,
  matchesQuery,
  RECENT_LIMIT,
  RECENT_WINDOW_MS,
  sectionDevices,
  usedClause,
  type PickerDevice,
} from "../../app/sim/picker-model.js";
import { latestBuildPerDevice } from "../../src/sim/rpc.js";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const HOUR = 3_600_000;

function device(over: Partial<PickerDevice> & { udid: string; name: string }): PickerDevice {
  return {
    state: "Shutdown",
    osVersion: "26.5",
    platform: "iOS",
    family: "iphone",
    isAvailable: true,
    lastBootedAt: null,
    lastBuiltAt: null,
    ...over,
  };
}

describe("sectioning", () => {
  it("shelves booted, then recent, then everything by runtime", () => {
    const sections = sectionDevices(
      [
        device({ udid: "a", name: "iPhone 17 Pro" }),
        device({ udid: "b", name: "iPhone 16", lastBootedAt: NOW - 2 * HOUR }),
        device({ udid: "c", name: "iPad Pro 13-inch", platform: "iPadOS", family: "ipad" }),
        device({ udid: "d", name: "iPhone 17", osVersion: "18.4" }),
      ],
      { bootedUdids: ["a"], query: "", now: NOW },
    );
    expect(sections.booted.map((entry) => entry.udid)).toEqual(["a"]);
    expect(sections.recent.map((entry) => entry.udid)).toEqual(["b"]);
    // A device already on the Booted or Recent shelf does not repeat below —
    // so no iOS 26.5 group remains, and platforms order before versions.
    expect(sections.groups.map((group) => group.label)).toEqual(["iOS 18.4", "iPadOS 26.5"]);
  });

  it("counts a tracked build as recent use — a build names the device out loud", () => {
    const sections = sectionDevices(
      [device({ udid: "a", name: "iPhone 17 Pro", lastBuiltAt: NOW - HOUR })],
      { bootedUdids: [], query: "", now: NOW },
    );
    expect(sections.recent.map((entry) => entry.udid)).toEqual(["a"]);
  });

  it("does not call last month recent", () => {
    const sections = sectionDevices(
      [device({ udid: "a", name: "iPhone 17 Pro", lastBootedAt: NOW - RECENT_WINDOW_MS - 1 })],
      { bootedUdids: [], query: "", now: NOW },
    );
    expect(sections.recent).toEqual([]);
    expect(sections.groups[0]?.devices.map((entry) => entry.udid)).toEqual(["a"]);
  });

  it("caps Recent before it becomes a second list", () => {
    const herd = Array.from({ length: RECENT_LIMIT + 3 }, (_, i) =>
      device({ udid: `u${i}`, name: `iPhone ${i}`, lastBootedAt: NOW - i * HOUR }),
    );
    const sections = sectionDevices(herd, { bootedUdids: [], query: "", now: NOW });
    expect(sections.recent).toHaveLength(RECENT_LIMIT);
    // Newest first, overflow onto the shelves rather than dropped.
    expect(sections.recent[0]?.udid).toBe("u0");
    expect(sections.total).toBe(herd.length);
  });

  it("shelves a device mid-boot with the booted ones, and says so", () => {
    // `bootedUdids` is the authority for Booted, but a Booting device is about
    // to be the most interesting one on the machine — burying it under a
    // runtime group while it boots reads as the picker not noticing.
    const booting = device({ udid: "a", name: "iPhone 17 Pro", state: "Booting" });
    const sections = sectionDevices([booting], { bootedUdids: [], query: "", now: NOW });
    expect(sections.booted.map((entry) => entry.udid)).toEqual(["a"]);
    expect(deviceClause(booting, NOW)).toBe("booting…");
  });

  it("hides unavailable devices — a runtime that is gone is not a choice", () => {
    const sections = sectionDevices(
      [device({ udid: "a", name: "Broken", isAvailable: false })],
      { bootedUdids: [], query: "", now: NOW },
    );
    expect(sections.total).toBe(0);
  });

  it("filters every shelf by the query", () => {
    const sections = sectionDevices(
      [
        device({ udid: "a", name: "iPhone 17 Pro" }),
        device({ udid: "b", name: "iPad Pro 13-inch", platform: "iPadOS", family: "ipad" }),
      ],
      { bootedUdids: ["a"], query: "ipad", now: NOW },
    );
    expect(sections.booted).toEqual([]);
    expect(sections.groups.flatMap((group) => group.devices).map((entry) => entry.udid)).toEqual(["b"]);
  });
});

describe("the query", () => {
  const target = device({ udid: "a", name: "iPhone 17 Pro Max" });

  it("matches words independently, case-insensitively", () => {
    expect(matchesQuery(target, "pro max")).toBe(true);
    expect(matchesQuery(target, "17 IPHONE")).toBe(true);
    expect(matchesQuery(target, "26.5")).toBe(true);
    expect(matchesQuery(target, "ipad")).toBe(false);
  });
});

describe("recency", () => {
  it("takes the newer of booted and built", () => {
    expect(lastUsedAt(device({ udid: "a", name: "x", lastBootedAt: 5, lastBuiltAt: 9 }))).toBe(9);
    expect(lastUsedAt(device({ udid: "a", name: "x", lastBootedAt: 9 }))).toBe(9);
    expect(lastUsedAt(device({ udid: "a", name: "x" }))).toBeNull();
  });

  it("says what the device was last used for, preferring the build", () => {
    expect(usedClause(device({ udid: "a", name: "x", lastBootedAt: NOW - HOUR, lastBuiltAt: NOW - HOUR / 2 }), NOW)).toBe(
      "built against 30m ago",
    );
    expect(usedClause(device({ udid: "a", name: "x", lastBootedAt: NOW - 2 * HOUR }), NOW)).toBe("booted 2h ago");
    expect(usedClause(device({ udid: "a", name: "x" }), NOW)).toBeNull();
  });

  it("speaks coarsely", () => {
    expect(ago(NOW - 30_000, NOW)).toBe("just now");
    expect(ago(NOW - 12 * 60_000, NOW)).toBe("12m ago");
    expect(ago(NOW - 3 * HOUR, NOW)).toBe("3h ago");
    expect(ago(NOW - 49 * HOUR, NOW)).toBe("2d ago");
  });
});

describe("name order", () => {
  it("is numeric-aware and newest-first", () => {
    const names = ["iPhone 9", "iPhone 17 Pro", "iPhone 17", "iPhone 16 Pro Max"];
    expect([...names].sort(compareDeviceNames)).toEqual([
      "iPhone 17 Pro",
      "iPhone 17",
      "iPhone 16 Pro Max",
      "iPhone 9",
    ]);
  });
});

describe("build evidence", () => {
  it("keeps the newest build per device, matching on id= only", () => {
    const udid = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const map = latestBuildPerDevice([
      { destination: `platform=iOS Simulator,id=${udid}`, startedAt: 100, threadId: null, projectId: null },
      { destination: `platform=iOS Simulator,id=${udid.toLowerCase()}`, startedAt: 300, threadId: null, projectId: null },
      { destination: "platform=iOS Simulator,name=iPhone 17 Pro", startedAt: 900, threadId: null, projectId: null },
      { destination: null, startedAt: 900, threadId: null, projectId: null },
    ]);
    expect(map.get(udid)).toBe(300);
    expect(map.size).toBe(1);
  });
});
