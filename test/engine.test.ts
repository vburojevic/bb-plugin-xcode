import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import { Engine, MISSES_BEFORE_FINISHING, domainCompatible } from "../src/engine";
import { FINISHING_TIMEOUT_MS, RANK, statusTransitionAllowed } from "../src/model";
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

const hooks = { projectFor: () => null, log: () => undefined };

let store: Store;
let engine: Engine;

beforeEach(() => {
  store = makeStore();
  engine = new Engine(store, hooks);
});

describe("lifecycle: running → finishing → ended", () => {
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
  const manifestEntry = (overrides = {}) => ({
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
    engine.foldManifestEntry("/tmp/dd", "build", manifestEntry(), 1_006_000);
    const runs = store.listRuns({});
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("passed");
    expect(runs[0]!.warningCount).toBe(2);
  });

  it("is idempotent per manifest uuid", () => {
    engine.foldSnapshot([activity()], 1_000_000);
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

  it("keeps duration from the run's own start, not the log span", () => {
    engine.foldSnapshot([activity({ startedAt: 1_000_000 })], 1_000_000);
    engine.foldManifestEntry(
      "/tmp/dd",
      "build",
      { ...manifestEntry(), startedAt: 1_004_000, endedAt: 1_004_070 },
      1_006_000,
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
    engine.foldBundle("/b/r.xcresult", build, null, [], 1_006_000);
    const run = store.listRuns({})[0]!;
    expect(run.status).toBe("warnings");
    expect(run.destination).toBe("platform=macOS"); // observed wins; already set
    expect(store.listFindings(run.id)).toHaveLength(1);
  });

  it("test outcome outranks the compile phase of the same bundle", () => {
    engine.foldSnapshot(
      [activity({ kind: "test", args: "xcodebuild -scheme Demo test" })],
      1_000_000,
    );
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
