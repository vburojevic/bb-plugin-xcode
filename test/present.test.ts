/**
 * What a model reads.
 *
 * `verdictSentence` is the first line `xcode_build` returns, and it is the
 * whole reason the tool exists: an agent that gets "PASSED" or "FAILED — 3 of
 * 41 test(s) failed" in one call has no reason to write a poll loop. So the
 * wording is a contract, not a detail — in particular that a build with no
 * recorded outcome says so plainly rather than reading as a pass.
 */

import { describe, expect, it } from "vitest";

import { RANK, type Run } from "../src/model";
import { describeRun, runName, shortName, verdictSentence } from "../src/present";

const NOW = 1_700_000_000_000;

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "r:100:1",
    status: "passed",
    statusRank: RANK.verified,
    kind: "build",
    scheme: "App",
    container: null,
    configuration: null,
    destination: null,
    projectId: null,
    root: null,
    cwd: null,
    pid: 100,
    cmdline: null,
    startedAt: NOW,
    endedAt: NOW + 5_000,
    errorCount: 0,
    warningCount: 0,
    analyzerCount: 0,
    testTotal: null,
    testFailed: null,
    testSkipped: null,
    bundlePath: null,
    detailed: false,
    branch: null,
    worktree: null,
    threadId: null,
    ...overrides,
  };
}

describe("shortName / runName", () => {
  it("takes the last segment, trailing slash or not", () => {
    expect(shortName("/a/b/c")).toBe("c");
    expect(shortName("/a/b/c/")).toBe("c");
    expect(shortName(null)).toBeNull();
  });

  it("falls back from scheme to container to root", () => {
    expect(runName(run())).toBe("App");
    expect(
      runName(run({ scheme: null, container: "/w/Thing.xcworkspace" })),
    ).toBe("Thing.xcworkspace");
    expect(runName(run({ scheme: null, root: "/dd/Thing-abc" }))).toBe(
      "Thing-abc",
    );
    expect(runName(run({ scheme: null }))).toBe("—");
  });
});

describe("describeRun", () => {
  it("puts the verdict first and the id last", () => {
    const line = describeRun(run(), { now: NOW });
    expect(line.startsWith("passed")).toBe(true);
    expect(line.endsWith("r:100:1")).toBe(true);
  });

  it("counts errors, warnings and failed tests only when non-zero", () => {
    expect(describeRun(run(), { now: NOW })).not.toContain("[");
    expect(
      describeRun(run({ errorCount: 2, testFailed: 1 }), { now: NOW }),
    ).toContain("[2E 1 failed]");
  });

  it("times a live run against the injected clock, not the wall", () => {
    const line = describeRun(run({ status: "running", endedAt: null }), {
      now: NOW + 12_000,
    });
    expect(line).toContain("running 12s");
  });

  it("resolves a project id through the supplied lookup", () => {
    const line = describeRun(run({ projectId: "proj_1" }), {
      now: NOW,
      projectName: (id) => (id === "proj_1" ? "Almanac" : null),
    });
    expect(line).toContain("Almanac");
  });
});

describe("verdictSentence", () => {
  const empty = { errorCount: 0, testFailed: null, testTotal: null };

  it("leads with the verdict in caps", () => {
    expect(verdictSentence("passed", empty)).toMatch(/^PASSED/);
    expect(verdictSentence("failed", { ...empty, errorCount: 3 })).toMatch(
      /^FAILED/,
    );
    expect(verdictSentence("cancelled", empty)).toMatch(/^CANCELLED/);
  });

  it("prefers the test tally when there is one", () => {
    expect(
      verdictSentence("failed", { errorCount: 0, testFailed: 3, testTotal: 41 }),
    ).toBe("FAILED — 3 of 41 test(s) failed.");
    expect(
      verdictSentence("passed", { errorCount: 0, testFailed: 0, testTotal: 41 }),
    ).toBe("PASSED — 41 test(s), none failed.");
  });

  it("treats warnings as a success state, because they are one", () => {
    expect(verdictSentence("warnings", empty)).toMatch(/^PASSED with warnings/);
  });

  /**
   * The one that matters most. `ended` means no source ever stated an outcome,
   * and a model reading anything hedged there will report the build as fine.
   */
  it("never lets a verdict-less run read as a pass", () => {
    const sentence = verdictSentence("ended", empty);
    expect(sentence).toMatch(/^NO VERDICT/);
    expect(sentence.toLowerCase()).not.toContain("pass");
  });

  it("says a run is still going rather than guessing", () => {
    expect(verdictSentence("running", empty)).toMatch(/^STILL RUNNING/);
    expect(verdictSentence("finishing", empty)).toMatch(/^STILL RUNNING/);
  });
});
