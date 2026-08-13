/**
 * The log store, checked against output Xcode actually wrote.
 *
 * Both fixtures are verbatim `LogStoreManifest.plist` files captured from a
 * real DerivedData root on Xcode 26.6 — not hand-written samples, because the
 * traps this file exists to catch are all things Xcode does that no reasonable
 * person would invent: Apple-epoch seconds, the literal string `<nil>` for an
 * absent document type, single-letter status codes, and a Package domain whose
 * "Resolve Packages" entries look exactly like build entries until you read the
 * title.
 *
 * They live in `test/fixtures/` rather than being read from
 * `~/Library/Developer/Xcode/DerivedData`, which is where this test used to
 * point. An absolute path into one developer's home directory meant the test
 * passed for exactly one person on exactly one machine, until Xcode cleaned
 * that root — and could never run in CI at all.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  appleTimeToEpochMs,
  parseManifest,
  schemeFromTitle,
} from "../src/manifest";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("plist/manifest against real Xcode output", () => {
  it("parses a real populated manifest", () => {
    const entries = parseManifest(fixture("package-manifest.plist"));
    expect(entries.length).toBeGreaterThan(0);
    const first = entries[0]!;
    expect(first.uniqueIdentifier).toMatch(/^[0-9A-F-]{36}$/);
    expect(first.className).toBe("IDECommandLineBuildLog");
    expect(first.title).toBe("Resolve Packages");
    expect(first.status).toBe("warnings");
    expect(first.warningCount).toBeGreaterThan(0);
    // Sanity that the Apple-epoch conversion ran: raw values are ~8×10^8, so
    // an unconverted timestamp lands in 1995 and fails this.
    expect(first.startedAt).toBeGreaterThan(1_700_000_000_000);
  });

  /**
   * The trap that gives this domain its own constant in `LOG_DOMAINS`: a
   * "Resolve Packages" entry carries the BuildLog domain type, overlaps the
   * build it belongs to, and shares its DerivedData root. Correlating on those
   * alone is how v1 reported a 5s build as 1.5s.
   */
  it("records the Package domain's build-shaped domainType", () => {
    const entries = parseManifest(fixture("package-manifest.plist"));
    expect(entries[0]!.domainType).toBe(
      "Xcode.IDEActivityLogDomainType.BuildLog",
    );
    expect(entries[0]!.signature).toBe("Resolve Packages");
  });

  it("converts Apple epoch correctly", () => {
    // 807713927.591237 was measured as 2026-08-06T12:58:47Z
    expect(new Date(appleTimeToEpochMs(807713927.591237)!).toISOString()).toBe(
      "2026-08-06T12:58:47.591Z",
    );
  });

  it("extracts scheme from a real title", () => {
    expect(schemeFromTitle("Building workspace xctrack with scheme Demo")).toBe(
      "Demo",
    );
  });

  it("returns [] for an empty manifest", () => {
    // The normal state for a project that has not been built — and, for the
    // Build domain of a CLI-only workflow, its permanent state.
    expect(parseManifest(fixture("empty-build-manifest.plist"))).toEqual([]);
  });

  it("returns [] rather than throwing on junk", () => {
    expect(parseManifest("not a plist at all")).toEqual([]);
    expect(parseManifest("")).toEqual([]);
  });
});
