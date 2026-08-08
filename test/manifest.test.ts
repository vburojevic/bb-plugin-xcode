import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseManifest, appleTimeToEpochMs, schemeFromTitle } from "../src/manifest";
import { parsePlist, isRecord } from "../src/plist";

const REAL = "/Users/vedranburojevic/Library/Developer/Xcode/DerivedData/Index-cptixobkxrobavfiogplkqvxpfif/Logs/Package/LogStoreManifest.plist";

describe("plist/manifest against real Xcode output", () => {
  it("parses a real populated manifest", () => {
    const xml = readFileSync(REAL, "utf8");
    const entries = parseManifest(xml);
    expect(entries.length).toBeGreaterThan(0);
    const e = entries[0]!;
    expect(e.uniqueIdentifier).toMatch(/^[0-9A-F-]{36}$/);
    expect(e.className).toBe("IDECommandLineBuildLog");
    expect(e.title).toBe("Resolve Packages");
    expect(e.status).toBe("warnings");
    expect(e.warningCount).toBeGreaterThan(0);
    expect(e.startedAt).toBeGreaterThan(1_700_000_000_000);
    console.log("  parsed:", entries.length, "entries; first:", new Date(e.startedAt!).toISOString());
  });
  it("converts Apple epoch correctly", () => {
    // 807713927.591237 was measured as 2026-08-06T12:58:47Z
    expect(new Date(appleTimeToEpochMs(807713927.591237)!).toISOString()).toBe("2026-08-06T12:58:47.591Z");
  });
  it("extracts scheme from a real title", () => {
    expect(schemeFromTitle("Building workspace xctrack with scheme Demo")).toBe("Demo");
  });
  it("returns [] for an empty manifest", () => {
    const empty = readFileSync("/Users/vedranburojevic/Library/Developer/Xcode/DerivedData/Index-cptixobkxrobavfiogplkqvxpfif/Logs/Build/LogStoreManifest.plist","utf8");
    expect(parseManifest(empty)).toEqual([]);
  });
});
