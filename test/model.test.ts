import { describe, expect, it } from "vitest";

import { isNoiseRun, isSnapshotRecording } from "../src/model";

describe("isNoiseRun", () => {
  const build = { kind: "build" as const, scheme: "App", root: "/dd" };

  /**
   * `xcodebuild -find node` / `-version`: real processes, tracked correctly,
   * but nothing anyone waits on. They resolve neither a scheme nor a
   * derived-data root, which is what separates them from a build.
   *
   * This rule used to live only in the banner component, and the split caused
   * a real bug: the server picked the newest settled run without it, a `-find`
   * lookup took that slot, and the component then filtered it out — so the
   * genuine result it was standing in front of never rendered at all.
   */
  it("recognises a toolchain lookup", () => {
    expect(isNoiseRun({ kind: "unknown", scheme: null, root: null })).toBe(true);
  });

  it("keeps anything that resolved a scheme or a derived-data root", () => {
    expect(isNoiseRun(build)).toBe(false);
    expect(isNoiseRun({ kind: "unknown", scheme: "App", root: null })).toBe(false);
    expect(isNoiseRun({ kind: "unknown", scheme: null, root: "/dd" })).toBe(false);
  });

  it("treats package resolution and indexing as noise", () => {
    expect(isNoiseRun({ ...build, kind: "package" })).toBe(true);
    expect(isNoiseRun({ ...build, kind: "index" })).toBe(true);
  });
});

describe("isSnapshotRecording", () => {
  /**
   * Verbatim from thr_yivibempsv / r:66968, where the agent reported "build
   * succeeded and all verified" while this plugin showed a red failed run —
   * both faithfully reporting the same xcresult.
   */
  const real =
    'DSComponentSnapshotTests.swift:1723: failed - Record mode is on. ' +
    'Automatically recorded snapshot: …\n\nopen "file:///…/testLocationCard.DSLocationCard-light.png"\n\n' +
    'Turn record mode off and re-run "testLocationCard" to assert against the newly-recorded snapshot';

  it("recognises a recorded baseline", () => {
    expect(isSnapshotRecording(real)).toBe(true);
    expect(isSnapshotRecording("Automatically recorded snapshot: foo.png")).toBe(true);
  });

  it("leaves a genuine assertion failure alone", () => {
    expect(
      isSnapshotRecording("XCTAssertEqual failed: (3) is not equal to (4)"),
    ).toBe(false);
    expect(
      isSnapshotRecording("Snapshot does not match reference. Difference: 4.2%"),
    ).toBe(false);
    expect(isSnapshotRecording(null)).toBe(false);
  });
});
