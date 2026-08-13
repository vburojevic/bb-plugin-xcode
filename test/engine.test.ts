import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import {
  Engine,
  MISSES_BEFORE_FINISHING,
  RUNNING_MAX_AGE_MS,
  domainCompatible,
} from "../src/engine";
import {
  FINISHING_TIMEOUT_MS,
  RANK,
  VERDICT_STATUSES,
  statusTransitionAllowed,
  type Run,
} from "../src/model";
import { MIGRATIONS, Store, type Db } from "../src/store";
import type { BuildResults, LiveActivity, TestResults } from "../src/types";

function makeStore(): Store {
  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  return new Store(db);
}

function activity(overrides: Partial<LiveActivity> = {}): LiveActivity {
  return {
    pid: 100,
    comm: "xcodebuild",
    args: "/usr/bin/xcodebuild -scheme Demo build",
    startedAt: 1_000_000,
    roots: ["/tmp/dd"],
    workerCount: 2,
    phase: null,
    currentFile: null,
    isDaemon: false,
    kind: "build",
    scheme: "Demo",
    container: null,
    configuration: null,
    destination: "platform=macOS",
    derivedDataPath: "/tmp/dd",
    resultBundlePath: null,
    cwd: "/tmp/proj",
    ...overrides,
  };
}

const hooks = {
  projectFor: () => null,
  threadFor: () => null,
  log: () => undefined,
};

let store: Store;
let engine: Engine;

/**
 * Retire the observed process. A verdict may only land once the process is
 * gone — a live invocation writes a log entry per action (`clean build`), and
 * honoring those early once marked a still-compiling build as passed.
 */
function retire(from: number): number {
  let at = from;
  for (let i = 0; i < MISSES_BEFORE_FINISHING; i++) {
    engine.foldSnapshot([], (at += 2_000));
  }
  return at;
}

beforeEach(() => {
  store = makeStore();
  engine = new Engine(store, hooks);
});

describe("lifecycle: running → finishing → ended", () => {
  it("notifies the host once when a process becomes a tracked run", () => {
    const started: Run[] = [];
    engine = new Engine(store, {
      ...hooks,
      onRunStarted: (run) => started.push(run),
    });

    engine.foldSnapshot([activity()], 1_000_000);
    engine.foldSnapshot([activity()], 1_002_000);

    expect(started.map((run) => run.id)).toEqual(["r:100:1000"]);
  });

  it("creates one run per process and keeps it across ticks", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    engine.foldSnapshot([activity()], 1_002_000);
    engine.foldSnapshot([activity()], 1_004_000);
    const runs = store.listRuns({});
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("running");
  });

  it("needs consecutive misses before finishing (hysteresis)", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    // One missed sample, then it reappears — must stay the same running run.
    engine.foldSnapshot([], 1_002_000);
    engine.foldSnapshot([activity()], 1_004_000);
    expect(store.listRuns({})).toHaveLength(1);
    expect(store.listRuns({})[0]!.status).toBe("running");

    // Gone for good: exactly MISSES_BEFORE_FINISHING absent ticks.
    let at = 1_006_000;
    for (let i = 0; i < MISSES_BEFORE_FINISHING; i++) {
      engine.foldSnapshot([], (at += 2_000));
    }
    const run = store.listRuns({})[0]!;
    expect(run.status).toBe("finishing");
    // Ended when last seen, not when we noticed — grace is never billed.
    expect(run.endedAt).toBe(1_004_000);
  });

  it("expires finishing to the terminal, verdict-less ended", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    let at = 1_002_000;
    for (let i = 0; i < MISSES_BEFORE_FINISHING; i++) {
      engine.foldSnapshot([], (at += 2_000));
    }
    expect(store.listRuns({})[0]!.status).toBe("finishing");

    engine.expireFinishing(at + FINISHING_TIMEOUT_MS + 1);
    expect(store.listRuns({})[0]!.status).toBe("ended");
  });

  it("re-adopts unresolved runs on hydrate instead of killing them", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    const second = new Engine(store, hooks);
    second.hydrate(1_010_000);
    // Process still alive: stays the same single running run.
    second.foldSnapshot([activity()], 1_012_000);
    expect(store.listRuns({})).toHaveLength(1);
    expect(store.listRuns({})[0]!.status).toBe("running");
  });

  it("tolerates etime jitter in a re-adopted run's reported start", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    const second = new Engine(store, hooks);
    second.hydrate(1_010_000);
    // `startedAt` is `now - etime` at whole-second resolution, so the same
    // process legitimately reports a start a second or two either way.
    second.foldSnapshot([activity({ startedAt: 1_002_000 })], 1_012_000);
    expect(store.listRuns({})).toHaveLength(1);
    expect(store.listRuns({})[0]!.status).toBe("running");
  });

  it("does not let a recycled pid keep a dead run alive forever", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    const orphan = store.listRuns({ limit: 1 })[0]!.id;

    // bb restarts. The build is long gone, but the row still says `running`
    // and still names pid 100 — which the OS has since handed to a new build.
    const second = new Engine(store, hooks);
    second.hydrate(9_000_000);
    second.foldSnapshot([activity({ startedAt: 8_900_000 })], 9_000_000);

    const runs = store.listRuns({});
    expect(runs).toHaveLength(2);
    // The orphan is retired rather than pinned at `running`…
    expect(store.getRun(orphan)!.status).toBe("finishing");
    // …and the build that is genuinely there gets its own row.
    const fresh = runs.find((run) => run.id !== orphan)!;
    expect(fresh.status).toBe("running");
    expect(fresh.startedAt).toBe(8_900_000);
  });

  it("retires the orphan without billing it the downtime", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    const orphan = store.listRuns({ limit: 1 })[0]!.id;
    const second = new Engine(store, hooks);
    second.hydrate(9_000_000);
    second.foldSnapshot([activity({ startedAt: 8_900_000 })], 9_000_000);
    // Boot is the latest moment anything can honestly vouch for; never "now"
    // if that is later still.
    expect(store.getRun(orphan)!.endedAt).toBe(9_000_000);
  });

  it("abandons a running run too old to be believed", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    const id = store.listRuns({ limit: 1 })[0]!.id;

    expect(engine.expireFinishing(1_000_000 + RUNNING_MAX_AGE_MS - 1)).toBe(
      false,
    );
    expect(store.getRun(id)!.status).toBe("running");

    expect(engine.expireFinishing(1_000_000 + RUNNING_MAX_AGE_MS + 1)).toBe(
      true,
    );
    expect(store.getRun(id)!.status).toBe("ended");
  });
});

describe("status lattice", () => {
  it("never lets a lower rank displace a higher one", () => {
    expect(
      statusTransitionAllowed(
        { status: "failed", rank: RANK.verified },
        { status: "passed", rank: RANK.logged },
      ),
    ).toBe(false);
  });

  it("never resurrects a terminal status at equal rank", () => {
    expect(
      statusTransitionAllowed(
        { status: "passed", rank: RANK.logged },
        { status: "running", rank: RANK.logged },
      ),
    ).toBe(false);
  });

  it("upgrades verdict-less ended to a real verdict at the same rank", () => {
    expect(
      statusTransitionAllowed(
        { status: "ended", rank: RANK.observed },
        { status: "failed", rank: RANK.observed },
      ),
    ).toBe(true);
  });
});

describe("manifest folding", () => {
  const manifestEntry = () => ({
    uniqueIdentifier: "uuid-1",
    title: "Building workspace X with scheme Demo",
    scheme: "Demo",
    startedAt: 1_000_500,
    endedAt: 1_005_000,
    status: "passed" as const,
    errorCount: 0,
    warningCount: 2,
    analyzerCount: 0,
    testFailureCount: 0,
  });

  it("enriches the overlapping run rather than creating a second row", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    retire(1_000_000);
    engine.foldManifestEntry("/tmp/dd", "build", manifestEntry(), 1_010_000);
    const runs = store.listRuns({});
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("passed");
    expect(runs[0]!.warningCount).toBe(2);
  });

  it("is idempotent per manifest uuid once the entry has been applied", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    retire(1_000_000);
    engine.foldManifestEntry("/tmp/dd", "build", manifestEntry(), 1_006_000);
    const changed = engine.foldManifestEntry(
      "/tmp/dd",
      "build",
      manifestEntry(),
      1_007_000,
    );
    expect(changed).toBe(false);
    expect(store.listRuns({})).toHaveLength(1);
  });

  /**
   * The regression that made this the plugin's deadest verdict source.
   *
   * Xcode writes the manifest the moment xcodebuild exits, which routinely
   * lands BEFORE the `ps` hysteresis concedes the process is gone. The entry
   * used to be consumed on that early pass, its verdict suppressed because the
   * run was still `running`, and no later sweep reconsidered it — the run then
   * timed out into a permanent verdict-less `ended`. Measured in production:
   * zero manifest verdicts had ever been recorded.
   */
  it("retries an entry that arrived before the run left running", () => {
    engine.foldSnapshot([activity()], 1_000_000);

    // Early pass: process still alive, so the verdict must wait.
    engine.foldManifestEntry("/tmp/dd", "build", manifestEntry(), 1_001_000);
    expect(store.listRuns({})[0]!.status).toBe("running");
    expect(store.listRuns({})[0]!.warningCount).toBe(2); // counts still adopted

    // The probe catches up, and the same entry must still be available.
    retire(1_002_000);
    engine.foldManifestEntry("/tmp/dd", "build", manifestEntry(), 1_020_000);
    expect(store.listRuns({})[0]!.status).toBe("passed");
    expect(store.listRuns({})).toHaveLength(1);
  });

  it("keeps duration from the run's own start, not the log span", () => {
    engine.foldSnapshot([activity({ startedAt: 1_000_000 })], 1_000_000);
    // Alive across the whole logged window, then gone: end time comes from
    // the last sighting, never from the log's own short span.
    engine.foldSnapshot([activity({ startedAt: 1_000_000 })], 1_004_100);
    retire(1_004_100);
    engine.foldManifestEntry(
      "/tmp/dd",
      "build",
      { ...manifestEntry(), startedAt: 1_004_000, endedAt: 1_004_070 },
      1_010_000,
    );
    const run = store.listRuns({})[0]!;
    // v1 regression: a 70ms log span must not shrink a 4s+ run.
    expect(run.startedAt).toBe(1_000_000);
    expect(run.endedAt).toBeGreaterThanOrEqual(1_004_070);
  });

  it("a build entry never marks a test run passed (compile phase only)", () => {
    engine.foldSnapshot(
      [activity({ kind: "test", args: "xcodebuild -scheme Demo test" })],
      1_000_000,
    );
    engine.foldManifestEntry("/tmp/dd", "build", manifestEntry(), 1_006_000);
    const run = store.listRuns({})[0]!;
    expect(run.status).toBe("running"); // verdict must wait for test results
    expect(run.warningCount).toBe(2); // counts still adopted
  });

  it("a failed compile phase does sink the whole test run", () => {
    engine.foldSnapshot(
      [activity({ kind: "test", args: "xcodebuild -scheme Demo test" })],
      1_000_000,
    );
    engine.foldManifestEntry(
      "/tmp/dd",
      "build",
      { ...manifestEntry(), status: "failed", errorCount: 3 },
      1_006_000,
    );
    expect(store.listRuns({})[0]!.status).toBe("failed");
  });

  it("creates a standalone run only when nothing overlaps", () => {
    engine.foldManifestEntry("/tmp/dd", "build", manifestEntry(), 2_000_000);
    const runs = store.listRuns({});
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe("m:uuid-1");
    expect(runs[0]!.status).toBe("passed");
  });
});

describe("bundle folding (verified rank)", () => {
  const build: BuildResults = {
    status: "warnings",
    startedAt: 1_001_000,
    endedAt: 1_005_000,
    errorCount: 0,
    warningCount: 1,
    analyzerCount: 0,
    actionTitle: null,
    destination: "macOS · My Mac",
    issues: [
      {
        severity: "warning",
        message: "unused variable",
        filePath: "/tmp/proj/A.swift",
        line: 3,
        column: 5,
        target: "Demo",
      },
    ],
  };

  const tests: TestResults = {
    status: "failed",
    startedAt: 1_001_000,
    endedAt: 1_009_000,
    total: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    expectedFailures: 0,
    destination: "macOS · My Mac",
    tests: [],
  };

  it("sets the verdict, findings and destination on the overlapping run", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    retire(1_000_000);
    engine.foldBundle("/b/r.xcresult", build, null, [], 1_010_000);
    const run = store.listRuns({})[0]!;
    expect(run.status).toBe("warnings");
    expect(run.destination).toBe("platform=macOS"); // observed wins; already set
    expect(store.listFindings(run.id)).toHaveLength(1);
  });

  /**
   * thr_yivibempsv / r:66968: the agent reported "build succeeded and all
   * verified"; the plugin showed a red failed run. Both were reporting the
   * same xcresult truthfully — swift-snapshot-testing fails every test it
   * records, because record mode has nothing to assert against yet.
   */
  it("does not call a snapshot recording run failed", () => {
    engine.foldSnapshot(
      [activity({ kind: "test", args: "xcodebuild -scheme Demo test" })],
      1_000_000,
    );
    retire(1_000_000);
    engine.foldBundle(
      "/b/rec.xcresult",
      { ...build, status: "passed" },
      { ...tests, total: 1, passed: 0, failed: 1 },
      [
        {
          suite: "DSComponentSnapshotTests",
          name: "testLocationCard()",
          status: "failed",
          durationMs: 840,
          failureMessage:
            "Record mode is on. Automatically recorded snapshot: … Turn record mode off and re-run to assert against the newly-recorded snapshot",
          target: "OttoDesignSystemTests",
        },
      ],
      1_010_000,
    );
    const run = store.listRuns({})[0]!;
    // `warnings` is a SUCCESS state here — the compile phase carried warnings.
    // The invariant is that a recording run is never presented as failed.
    expect(["passed", "warnings"]).toContain(run.status);
    expect(run.testFailed).toBe(0);
    expect(store.listTests(run.id)[0]!.status).toBe("recorded");
  });

  it("still fails when a real assertion failed alongside a recording", () => {
    engine.foldSnapshot(
      [activity({ kind: "test", args: "xcodebuild -scheme Demo test" })],
      1_000_000,
    );
    retire(1_000_000);
    engine.foldBundle(
      "/b/mixed.xcresult",
      { ...build, status: "passed" },
      { ...tests, total: 2, passed: 0, failed: 2 },
      [
        {
          suite: "DSComponentSnapshotTests",
          name: "testLocationCard()",
          status: "failed",
          durationMs: 840,
          failureMessage: "Record mode is on. Automatically recorded snapshot: …",
          target: "OttoDesignSystemTests",
        },
        {
          suite: "DemoTests",
          name: "testReal()",
          status: "failed",
          durationMs: 12,
          failureMessage: "XCTAssertEqual failed: (3) is not equal to (4)",
          target: "DemoTests",
        },
      ],
      1_010_000,
    );
    const run = store.listRuns({})[0]!;
    expect(run.status).toBe("failed");
    expect(run.testFailed).toBe(1); // the recording is not counted against it
  });

  /**
   * The lattice refuses same-rank terminal flips so sources cannot fight over
   * a run — but that also froze verdicts this plugin had derived WRONGLY, so
   * fixing the interpretation could never repair the rows the bug produced.
   * A recording run stayed red on screen as its thread's latest result.
   * Re-reading the SAME artifact is the same authority speaking again.
   */
  it("lets a re-read of the same bundle correct its own earlier verdict", () => {
    engine.foldSnapshot(
      [activity({ kind: "test", args: "xcodebuild -scheme Demo test" })],
      1_000_000,
    );
    retire(1_000_000);
    const recording = [
      {
        suite: "DSComponentSnapshotTests",
        name: "testLocationCard()",
        status: "failed" as const,
        durationMs: 840,
        failureMessage: "Record mode is on. Automatically recorded snapshot: …",
        target: "OttoDesignSystemTests",
      },
    ];

    // First read, pre-fix behaviour: the recording counted as a failure.
    engine.foldBundle(
      "/b/same.xcresult",
      { ...build, status: "passed" },
      { ...tests, total: 1, passed: 0, failed: 1 },
      [{ ...recording[0]!, failureMessage: "XCTAssertEqual failed" }],
      1_010_000,
    );
    const runId = store.listRuns({})[0]!.id;
    expect(store.getRun(runId)!.status).toBe("failed");

    // Re-read after the fix — same bundle, same run.
    store.clearSeen(`bundle:/b/same.xcresult:${runId}`);
    engine.foldBundle(
      "/b/same.xcresult",
      { ...build, status: "passed" },
      { ...tests, total: 1, passed: 0, failed: 1 },
      recording,
      1_020_000,
    );
    expect(store.getRun(runId)!.status).not.toBe("failed");
    expect(store.getRun(runId)!.testFailed).toBe(0);
  });

  it("does not let a DIFFERENT bundle overwrite a verified verdict", () => {
    engine.foldSnapshot(
      [activity({ kind: "test", args: "xcodebuild -scheme Demo test" })],
      1_000_000,
    );
    retire(1_000_000);
    engine.foldBundle(
      "/b/first.xcresult",
      { ...build, status: "passed" },
      { ...tests, total: 1, passed: 0, failed: 1 },
      [
        {
          suite: "DemoTests",
          name: "testReal()",
          status: "failed" as const,
          durationMs: 10,
          failureMessage: "XCTAssertEqual failed",
          target: "DemoTests",
        },
      ],
      1_010_000,
    );
    const runId = store.listRuns({})[0]!.id;
    expect(store.getRun(runId)!.status).toBe("failed");

    engine.foldBundle(
      "/b/second.xcresult",
      { ...build, status: "passed" },
      { ...tests, total: 1, passed: 1, failed: 0, status: "passed" },
      [],
      1_020_000,
    );
    expect(store.getRun(runId)!.status).toBe("failed"); // still the real failure
  });

  it("test outcome outranks the compile phase of the same bundle", () => {
    engine.foldSnapshot(
      [activity({ kind: "test", args: "xcodebuild -scheme Demo test" })],
      1_000_000,
    );
    retire(1_000_000);
    engine.foldBundle(
      "/b/t.xcresult",
      { ...build, status: "passed" },
      tests,
      [
        {
          suite: "DemoTests",
          name: "testFail()",
          status: "failed",
          durationMs: 550,
          failureMessage: "boom",
          target: "DemoTests",
        },
      ],
      1_010_000,
    );
    const run = store.listRuns({})[0]!;
    expect(run.status).toBe("failed");
    expect(run.testTotal).toBe(2);
    expect(store.listTests(run.id)).toHaveLength(1);
  });

  it("a verified verdict can overwrite a logged one, never vice versa", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    retire(1_000_000);
    engine.foldManifestEntry(
      "/tmp/dd",
      "build",
      {
        uniqueIdentifier: "u2",
        title: null,
        scheme: "Demo",
        startedAt: 1_000_500,
        endedAt: 1_005_000,
        status: "passed",
        errorCount: 0,
        warningCount: 0,
        analyzerCount: 0,
        testFailureCount: 0,
      },
      1_006_000,
    );
    expect(store.listRuns({})[0]!.status).toBe("passed");

    // Bundle (verified) says warnings — it wins over the logged verdict.
    engine.foldBundle("/b/x.xcresult", build, null, [], 1_007_000);
    expect(store.listRuns({})[0]!.status).toBe("warnings");
  });

  it("resolves a finishing run — the exact flow of a normal CLI build", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    let at = 1_002_000;
    for (let i = 0; i < MISSES_BEFORE_FINISHING; i++) {
      engine.foldSnapshot([], (at += 2_000));
    }
    expect(store.listRuns({})[0]!.status).toBe("finishing");
    engine.foldBundle("/b/r.xcresult", build, null, [], at + 1_000);
    expect(store.listRuns({})[0]!.status).toBe("warnings");
  });
});

describe("domainCompatible", () => {
  it("package activity is never enriched by build/test logs", () => {
    expect(domainCompatible("build", "package")).toBe(false);
    expect(domainCompatible("test", "package")).toBe(false);
  });
  it("a build log covers builds, tests, archives", () => {
    expect(domainCompatible("build", "build")).toBe(true);
    expect(domainCompatible("build", "test")).toBe(true);
    expect(domainCompatible("build", "archive")).toBe(true);
  });
});

describe("shim-wrapped runs (regression)", () => {
  /**
   * Measured live: a shim-wrapped run knows its bundle path from argv the
   * moment it starts. The old candidate filter (`bundle_path IS NULL`)
   * excluded it from manifest matching, so the log-store entry created a
   * duplicate standalone row beside the real run.
   */
  it("a run with a bundle path is still enriched by its manifest entry", () => {
    engine.foldSnapshot(
      [activity({ resultBundlePath: "/bundles/x.xcresult" })],
      1_000_000,
    );
    retire(1_000_000);
    engine.foldManifestEntry(
      "/tmp/dd",
      "build",
      {
        uniqueIdentifier: "u9",
        title: null,
        scheme: "Demo",
        startedAt: 1_000_500,
        endedAt: 1_005_000,
        status: "warnings",
        errorCount: 0,
        warningCount: 60,
        analyzerCount: 0,
        testFailureCount: 0,
      },
      1_006_000,
    );
    const runs = store.listRuns({});
    expect(runs).toHaveLength(1); // no duplicate
    expect(runs[0]!.status).toBe("warnings");
    expect(runs[0]!.bundlePath).toBe("/bundles/x.xcresult");
  });
});

describe("foldWrappedExit", () => {
  const BUNDLE = "/tmp/wrap/result.xcresult";

  function startWrapped(): string {
    engine.foldSnapshot([activity({ resultBundlePath: BUNDLE })], 1_000_500);
    return store.listRuns({ limit: 1 })[0]!.id;
  }

  it("maps a clean exit to passed", () => {
    const id = startWrapped();
    engine.foldWrappedExit(
      BUNDLE,
      { exitCode: 0, signal: null, errors: 0, warnings: 0 },
      1_060_000,
    );
    const run = store.getRun(id)!;
    expect(run.status).toBe("passed");
    expect(run.endedAt).toBe(1_060_000);
  });

  it("maps a signaled death to cancelled, never passed", () => {
    const id = startWrapped();
    engine.foldWrappedExit(
      BUNDLE,
      { exitCode: null, signal: "SIGTERM", errors: 0, warnings: 3 },
      1_060_000,
    );
    const run = store.getRun(id)!;
    expect(run.status).toBe("cancelled");
    expect(run.warningCount).toBe(3);
  });

  it("maps a nonzero exit to failed and keeps stream counts", () => {
    const id = startWrapped();
    engine.foldWrappedExit(
      BUNDLE,
      { exitCode: 65, signal: null, errors: 2, warnings: 1 },
      1_060_000,
    );
    const run = store.getRun(id)!;
    expect(run.status).toBe("failed");
    expect(run.errorCount).toBe(2);
  });

  it("never downgrades a verified verdict", () => {
    const id = startWrapped();
    const run = store.getRun(id)!;
    run.status = "passed";
    run.statusRank = RANK.verified;
    store.updateRun(run);
    engine.foldWrappedExit(
      BUNDLE,
      { exitCode: null, signal: "SIGTERM", errors: 0, warnings: 0 },
      1_060_000,
    );
    expect(store.getRun(id)!.status).toBe("passed");
  });

  /**
   * A long build on a busy machine is not an edge case: agents build in
   * parallel, and a 20-minute test suite can easily have a hundred shorter
   * runs start and finish inside it. Looking the bundle's owner up by scanning
   * the newest 50 rows lost exactly those runs — the ones that took longest.
   */
  it("finds its run however far it has fallen down the recent list", () => {
    const id = startWrapped();
    retire(1_002_000);
    for (let i = 0; i < 120; i++) {
      engine.foldSnapshot(
        [activity({ pid: 5_000 + i, startedAt: 2_000_000 + i * 1_000 })],
        2_000_000 + i * 1_000,
      );
    }
    expect(store.listRuns({ limit: 50 }).some((run) => run.id === id)).toBe(
      false,
    );

    expect(
      engine.foldWrappedExit(
        BUNDLE,
        { exitCode: 0, signal: null, errors: 0, warnings: 0 },
        2_200_000,
      ),
    ).toBe(true);
    expect(store.getRun(id)!.status).toBe("passed");
  });
});

describe("foldThreadCommandExit", () => {
  function startThreadRun(): string {
    engine = new Engine(store, {
      ...hooks,
      threadFor: () => "thr_build",
    });
    engine.foldSnapshot([activity()], 1_000_000);
    return store.listRuns({ limit: 1 })[0]!.id;
  }

  it("promotes the one Xcode child inside a successful background command", () => {
    const id = startThreadRun();
    retire(1_002_000);

    expect(
      engine.foldThreadCommandExit(
        {
          taskId: "task_build",
          threadId: "thr_build",
          command: "cd /tmp/proj && ./scripts/build_app.sh build",
          cwd: "",
          startedAt: 990_000,
          endedAt: 1_060_000,
          exitCode: 0,
          interrupted: false,
        },
        1_060_000,
      ),
    ).toBe(true);
    expect(store.getRun(id)!.status).toBe("passed");
  });

  it("maps a nonzero parent exit to failed", () => {
    const id = startThreadRun();
    retire(1_002_000);
    engine.foldThreadCommandExit(
      {
        taskId: "task_build",
        threadId: "thr_build",
        command: "xcodebuildmcp simulator build --scheme Demo",
        cwd: "/tmp/proj",
        startedAt: 990_000,
        endedAt: 1_060_000,
        exitCode: 65,
        interrupted: false,
      },
      1_060_000,
    );
    expect(store.getRun(id)!.status).toBe("failed");
  });

  // Production, 2026-08-10: bb reports `cwd: ""` on every commandExecution
  // item and the agent wrote a RELATIVE script path, so the old path-matching
  // arm had no absolute path to find and the build sat at "ended" forever.
  // The same build resolved fine when the agent happened to write
  // `cd /abs && ./scripts/build_app.sh` — a verdict decided by shell style.
  it("resolves a relative build command with no cwd reported", () => {
    const id = startThreadRun();
    retire(1_002_000);

    expect(
      engine.foldThreadCommandExit(
        {
          taskId: "task_build",
          threadId: "thr_build",
          command:
            './scripts/build_app.sh build --env dev --sim local > /tmp/b.log 2>&1; echo "EXIT=$?"',
          cwd: "",
          startedAt: 990_000,
          endedAt: 1_060_000,
          exitCode: 0,
          interrupted: false,
        },
        1_060_000,
      ),
    ).toBe(true);
    expect(store.getRun(id)!.status).toBe("passed");
  });

  // The hazard the old `xcodebuild`-anywhere arm opened: this poller names
  // xcodebuild, exits 0, and overlaps the build — so it skipped every path
  // check and was one single-candidate window away from calling a failed
  // build green.
  it("never lets a watcher's exit 0 become a build's verdict", () => {
    const id = startThreadRun();
    retire(1_002_000);

    expect(
      engine.foldThreadCommandExit(
        {
          taskId: "task_build",
          threadId: "thr_build",
          command:
            'until ! pgrep -f xcodebuild > /dev/null; do sleep 5; done; echo "build finished"',
          cwd: "",
          startedAt: 990_000,
          endedAt: 1_060_000,
          exitCode: 0,
          interrupted: false,
        },
        1_060_000,
      ),
    ).toBe(false);
    expect(VERDICT_STATUSES.has(store.getRun(id)!.status)).toBe(false);
  });

  it("ignores a bb xcode status poll loop", () => {
    const id = startThreadRun();
    retire(1_002_000);

    engine.foldThreadCommandExit(
      {
        taskId: "task_build",
        threadId: "thr_build",
        command:
          'until ! bb xcode status 2>/dev/null | grep -q "^Active (1)"; do sleep 5; done',
        cwd: "",
        startedAt: 990_000,
        endedAt: 1_060_000,
        exitCode: 0,
        interrupted: false,
      },
      1_060_000,
    );
    expect(VERDICT_STATUSES.has(store.getRun(id)!.status)).toBe(false);
  });

  // A build cannot have been launched by a command that started after it.
  it("will not adopt a run that predates the command", () => {
    const id = startThreadRun();
    retire(1_002_000);

    expect(
      engine.foldThreadCommandExit(
        {
          taskId: "task_build",
          threadId: "thr_build",
          command: "./scripts/build_app.sh build",
          cwd: "",
          // Well clear of LAUNCH_SLACK_MS, which exists only to absorb the
          // second-resolution start times `ps` reports.
          startedAt: 1_010_000,
          endedAt: 1_060_000,
          exitCode: 0,
          interrupted: false,
        },
        1_060_000,
      ),
    ).toBe(false);
    expect(VERDICT_STATUSES.has(store.getRun(id)!.status)).toBe(false);
  });

  // `foo &` inside the command: the launcher returns 0 while the build is
  // still compiling. Calling that passed would be a lie.
  it("will not vouch for a build still running when the command exited", () => {
    const id = startThreadRun();

    expect(
      engine.foldThreadCommandExit(
        {
          taskId: "task_build",
          threadId: "thr_build",
          command: "./scripts/build_app.sh build &",
          cwd: "",
          startedAt: 990_000,
          endedAt: 1_001_000,
          exitCode: 0,
          interrupted: false,
        },
        1_001_000,
      ),
    ).toBe(false);
    expect(store.getRun(id)!.status).toBe("running");
  });

  // One script, several sequential xcodebuild invocations. A zero exit vouches
  // for all of them; a failure only for the one it died on.
  it("passes every child of a successful multi-build script", () => {
    const first = startThreadRun();
    retire(1_002_000);
    engine.foldSnapshot([activity({ pid: 101, startedAt: 1_010_000 })], 1_010_000);
    const second = store.listRuns({ limit: 5 }).find((run) => run.id !== first)!.id;
    engine.foldSnapshot([], 1_020_000);
    engine.foldSnapshot([], 1_030_000);
    engine.foldSnapshot([], 1_040_000);

    engine.foldThreadCommandExit(
      {
        taskId: "task_build",
        threadId: "thr_build",
        command: "./scripts/build_app.sh build-all",
        cwd: "",
        startedAt: 990_000,
        endedAt: 1_060_000,
        exitCode: 0,
        interrupted: false,
      },
      1_060_000,
    );
    expect(store.getRun(first)!.status).toBe("passed");
    expect(store.getRun(second)!.status).toBe("passed");
  });

  it("blames only the last child when the script fails", () => {
    const first = startThreadRun();
    retire(1_002_000);
    engine.foldSnapshot([activity({ pid: 101, startedAt: 1_010_000 })], 1_010_000);
    const second = store.listRuns({ limit: 5 }).find((run) => run.id !== first)!.id;
    engine.foldSnapshot([], 1_020_000);
    engine.foldSnapshot([], 1_030_000);
    engine.foldSnapshot([], 1_040_000);

    engine.foldThreadCommandExit(
      {
        taskId: "task_build",
        threadId: "thr_build",
        command: "./scripts/build_app.sh build-all",
        cwd: "",
        startedAt: 990_000,
        endedAt: 1_060_000,
        exitCode: 65,
        interrupted: false,
      },
      1_060_000,
    );
    expect(store.getRun(second)!.status).toBe("failed");
    expect(store.getRun(first)!.status).not.toBe("failed");
  });

  // The real r:89323 shape: the agent stopped the background task mid-build.
  it("maps an interrupted launcher to cancelled", () => {
    const id = startThreadRun();
    retire(1_002_000);

    engine.foldThreadCommandExit(
      {
        taskId: "task_build",
        threadId: "thr_build",
        command: "./scripts/build_app.sh build --env dev --sim local",
        cwd: "",
        startedAt: 990_000,
        endedAt: 1_060_000,
        exitCode: null,
        interrupted: true,
      },
      1_060_000,
    );
    expect(store.getRun(id)!.status).toBe("cancelled");
  });

  it("does not guess when two Xcode children fit the same command", () => {
    startThreadRun();
    engine.foldSnapshot(
      [activity({ pid: 101, startedAt: 1_010_000 })],
      1_010_000,
    );

    expect(
      engine.foldThreadCommandExit(
        {
          taskId: "task_build",
          threadId: "thr_build",
          command: "xcodebuildmcp simulator build --scheme Demo",
          cwd: "/tmp/proj",
          startedAt: 990_000,
          endedAt: 1_060_000,
          exitCode: 0,
          interrupted: false,
        },
        1_060_000,
      ),
    ).toBe(false);
    expect(store.listRuns({}).every((run) => run.status === "running")).toBe(true);
  });
});

describe("premature verdicts (regression)", () => {
  // Observed live: `xcodebuild clean build` classified as a clean, whose own
  // log entry then marked the whole invocation passed 5.7s in — while the
  // build phase was still compiling.
  const cleanEntry = {
    uniqueIdentifier: "uuid-clean",
    title: "Clean workspace Demo",
    scheme: "Demo",
    startedAt: 1_000_500,
    endedAt: 1_001_000,
    status: "passed" as const,
    errorCount: 0,
    warningCount: 0,
    analyzerCount: 0,
    testFailureCount: 0,
  };

  it("never lets a phase log finalize a run whose process is still alive", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    engine.foldManifestEntry("/tmp/dd", "build", cleanEntry, 1_002_000);
    const run = store.listRuns({})[0]!;
    expect(run.status).toBe("running");
  });

  it("still lets a failed phase sink a live run immediately", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    engine.foldManifestEntry(
      "/tmp/dd",
      "build",
      { ...cleanEntry, status: "failed", errorCount: 2 },
      1_002_000,
    );
    expect(store.listRuns({})[0]!.status).toBe("failed");
  });

  it("applies the verdict once the process is gone", () => {
    engine.foldSnapshot([activity()], 1_000_000);
    let at = 1_002_000;
    for (let i = 0; i < MISSES_BEFORE_FINISHING; i++) {
      engine.foldSnapshot([], (at += 2_000));
    }
    engine.foldManifestEntry("/tmp/dd", "build", cleanEntry, at + 1_000);
    expect(store.listRuns({})[0]!.status).toBe("passed");
  });

  it("does not let a bundle finalize a still-running invocation", () => {
    engine.foldSnapshot([activity({ resultBundlePath: "/tmp/b.xcresult" })], 1_000_000);
    engine.foldBundle(
      "/tmp/b.xcresult",
      {
        status: "passed",
        startedAt: 1_000_500,
        endedAt: 1_001_000,
        errorCount: 0,
        warningCount: 0,
        analyzerCount: 0,
        actionTitle: null,
        destination: null,
        issues: [],
      },
      null,
      [],
      1_002_000,
    );
    expect(store.listRuns({})[0]!.status).toBe("running");
  });
});
