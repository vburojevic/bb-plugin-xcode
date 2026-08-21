import { describe, expect, it } from "vitest";

import { isEphemeralRun, isNoiseRun, isSnapshotRecording } from "../src/model";

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

  /**
   * Package resolution is NOT noise, and calling it that cost a real user a
   * real answer: a thread spent 7m37s in `xcodebuild
   * -resolvePackageDependencies` while its banner showed nothing at all,
   * because the whole invocation had been classified as junk.
   *
   * Noise is "nobody is waiting on this". Somebody is very much waiting on a
   * dependency fetch — they just do not want it in their build history
   * afterwards, which is a different rule with a different name.
   */
  it("does not call package resolution or indexing noise", () => {
    expect(isNoiseRun({ ...build, kind: "package" })).toBe(false);
    expect(isNoiseRun({ ...build, kind: "index" })).toBe(false);
  });
});

describe("isEphemeralRun", () => {
  const build = { kind: "build" as const };

  it("covers exactly the kinds that are watched live and dropped after", () => {
    expect(isEphemeralRun({ kind: "package" })).toBe(true);
    expect(isEphemeralRun({ kind: "index" })).toBe(true);
  });

  it("leaves real work in history", () => {
    expect(isEphemeralRun(build)).toBe(false);
    expect(isEphemeralRun({ kind: "test" })).toBe(false);
    expect(isEphemeralRun({ kind: "archive" })).toBe(false);
  });

  /**
   * The two predicates answer different questions and must not be collapsed
   * back together — a settled package resolve has to be excluded from "how did
   * the last thing go" by `isEphemeralRun`, while a running one has to survive
   * `isNoiseRun` to reach the banner.
   */
  it("is independent of noise", () => {
    const lookup = { kind: "unknown" as const, scheme: null, root: null };
    expect(isNoiseRun(lookup)).toBe(true);
    expect(isEphemeralRun(lookup)).toBe(false);
  });
});

describe("isSnapshotRecording", () => {
  /**
   * Verbatim from a production run, where the agent reported "build
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
