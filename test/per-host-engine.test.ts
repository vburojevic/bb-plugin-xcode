/**
 * The engine and store with more than one Mac's process table folded in.
 *
 * Each Mac's snapshot is complete for that Mac only. Keyed by pid alone, the
 * MacBook's snapshot — which never lists the server's builds — would end
 * every one of them after three ticks, and two Macs handing out the same pid
 * would share one run. These pin the per-host fold, the migration that keys
 * DerivedData roots by Mac, and the choice of which Macs to watch.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { Collector } from "../src/collector";
import { Engine, MISSES_BEFORE_FINISHING, observedRunId } from "../src/engine";
import type { MachineIO } from "../src/machine";
import { RANK, type Run } from "../src/model";
import { selectHostsToWatch } from "../src/remote-watch";
import { ScopeSync } from "../src/scope-sync";
import { SCOPE_IDLE_TTL_MS, ThreadScopes } from "../src/scopes";
import {
  bundleScannedKey,
  MIGRATIONS,
  Store,
  V4_MIGRATIONS_START,
  type Db,
} from "../src/store";
import type { LiveActivity } from "../src/types";

const NOW = 1_800_000_000_000;
const MBP = "host_mbp";
const AIR = "host_air";

function migrated(): Store {
  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  return new Store(db);
}

function activity(overrides: Partial<LiveActivity> = {}): LiveActivity {
  return {
    pid: 4242,
    comm: "xcodebuild",
    args: "/usr/bin/xcodebuild -scheme App build",
    startedAt: NOW,
    roots: [],
    workerCount: 1,
    phase: "compiling",
    currentFile: null,
    isDaemon: false,
    kind: "build",
    scheme: "App",
    container: null,
    configuration: null,
    destination: null,
    derivedDataPath: null,
    resultBundlePath: null,
    cwd: "/Users/me/App",
    ...overrides,
  };
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    status: "running",
    statusRank: RANK.observed,
    kind: "build",
    scheme: "App",
    container: null,
    configuration: null,
    destination: null,
    projectId: null,
    root: null,
    cwd: "/Users/me/App",
    pid: 4242,
    cmdline: null,
    startedAt: NOW,
    endedAt: null,
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
    hostId: null,
    ...overrides,
  };
}

/** Scopes as hooks, so attribution goes through the real per-host matching. */
function engineWith(store: Store, scopes = new ThreadScopes()): Engine {
  return new Engine(store, {
    projectFor: () => null,
    threadFor: (signals, hostId) => scopes.threadFor(signals, hostId),
    log: () => undefined,
  });
}

describe("one fold per Mac", () => {
  it("never lets one Mac's snapshot end another Mac's runs", () => {
    const store = migrated();
    const engine = engineWith(store);
    engine.foldSnapshot([activity({ pid: 100 })], NOW);
    engine.foldSnapshot([activity({ pid: 200 })], NOW, MBP);

    // The MacBook keeps answering without the server's build, and the server
    // without the MacBook's: neither is a miss for the other.
    for (let tick = 1; tick <= MISSES_BEFORE_FINISHING + 2; tick += 1) {
      engine.foldSnapshot([activity({ pid: 200 })], NOW + tick * 2_000, MBP);
      engine.foldSnapshot([activity({ pid: 100 })], NOW + tick * 2_000);
    }
    const open = store.listUnresolved();
    expect(
      open
        .map((entry) => [entry.hostId, entry.pid, entry.status])
        .sort((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      [null, 100, "running"],
      [MBP, 200, "running"],
    ]);
  });

  it("ends a Mac's run only from that Mac's own snapshots", () => {
    const store = migrated();
    const engine = engineWith(store);
    engine.foldSnapshot([activity({ pid: 200 })], NOW, MBP);
    for (let tick = 1; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
      engine.foldSnapshot([], NOW + tick * 2_000, MBP);
    }
    expect(store.getRun(observedRunId(MBP, 200, NOW))).toMatchObject({
      status: "finishing",
      hostId: MBP,
      endedAt: NOW,
    });
  });

  it("gives the same pid, started the same second on two Macs, two runs", () => {
    const store = migrated();
    const engine = engineWith(store);
    const same = activity({ pid: 4242, startedAt: NOW });
    engine.foldSnapshot([same], NOW);
    engine.foldSnapshot([{ ...same, scheme: "Mac" }], NOW, MBP);
    engine.foldSnapshot([{ ...same, scheme: "Air" }], NOW, AIR);

    const ids = store.listUnresolved().map((entry) => entry.id).sort();
    expect(ids).toEqual([
      "r:4242:1800000000",
      `r:${AIR}:4242:1800000000`,
      `r:${MBP}:4242:1800000000`,
    ]);
    expect(store.getRun(`r:${MBP}:4242:1800000000`)).toMatchObject({ scheme: "Mac", hostId: MBP });

    // Ending one Mac's leaves the others alone.
    for (let tick = 1; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
      engine.foldSnapshot([same], NOW + tick * 2_000);
      engine.foldSnapshot([], NOW + tick * 2_000, AIR);
      engine.foldSnapshot([same], NOW + tick * 2_000, MBP);
    }
    expect(store.getRun("r:4242:1800000000")?.status).toBe("running");
    expect(store.getRun(`r:${MBP}:4242:1800000000`)?.status).toBe("running");
    expect(store.getRun(`r:${AIR}:4242:1800000000`)?.status).toBe("finishing");
  });

  it("re-adopts a watched run after a restart under its own Mac only", () => {
    const store = migrated();
    const id = observedRunId(MBP, 4242, NOW);
    store.insertRun(run(id, { hostId: MBP, startedAt: NOW }));
    const engine = engineWith(store);
    engine.hydrate(NOW + 10_000);

    // This machine has a process with that pid; it is not the MacBook's build.
    for (let tick = 1; tick <= MISSES_BEFORE_FINISHING + 1; tick += 1) {
      engine.foldSnapshot([activity({ pid: 4242, startedAt: NOW + 5_000 })], NOW + tick * 2_000);
    }
    // The MacBook still reports its build, so the run stays live.
    engine.foldSnapshot([activity({ pid: 4242, startedAt: NOW })], NOW + 20_000, MBP);
    expect(store.getRun(id)?.status).toBe("running");
    // And only the MacBook's silence ends it.
    for (let tick = 1; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
      engine.foldSnapshot([], NOW + 20_000 + tick * 2_000, MBP);
    }
    expect(store.getRun(id)?.status).toBe("finishing");
  });

  it("leaves tracked builds on other Macs to src/remote.ts", () => {
    const store = migrated();
    store.insertRun(run("w:abc-0123456789ab", { hostId: MBP, pid: 4242 }));
    const engine = engineWith(store);
    engine.hydrate(NOW);
    for (let tick = 1; tick <= MISSES_BEFORE_FINISHING + 1; tick += 1) {
      engine.foldSnapshot([], NOW + tick * 2_000, MBP);
    }
    expect(store.getRun("w:abc-0123456789ab")?.status).toBe("running");
  });

  it("attributes a Mac's build only to a thread whose checkout is on that Mac", () => {
    const store = migrated();
    const scopes = new ThreadScopes();
    const scope = { projectId: null, environmentId: "env", branch: null, active: true };
    scopes.upsert({ ...scope, threadId: "thr_local", path: "/Users/me/App", hostId: null }, NOW);
    scopes.upsert({ ...scope, threadId: "thr_mbp", path: "/Users/me/App", hostId: MBP }, NOW);
    const engine = engineWith(store, scopes);
    engine.foldSnapshot([activity({ pid: 1 })], NOW);
    engine.foldSnapshot([activity({ pid: 2 })], NOW, MBP);
    engine.foldSnapshot([activity({ pid: 3 })], NOW, AIR);

    expect(store.getRun(observedRunId(null, 1, NOW))?.threadId).toBe("thr_local");
    expect(store.getRun(observedRunId(MBP, 2, NOW))?.threadId).toBe("thr_mbp");
    expect(store.getRun(observedRunId(AIR, 3, NOW))?.threadId).toBeNull();
  });
});

describe("Xcode.app's resident build service", () => {
  const service = (overrides: Partial<LiveActivity> = {}) =>
    activity({
      pid: 555,
      comm: "SWBBuildService",
      args: "/Applications/Xcode.app/…/SWBBuildService",
      // Xcode was opened an hour and a half before this build.
      startedAt: NOW - 90 * 60_000,
      isDaemon: true,
      kind: "unknown",
      scheme: null,
      cwd: "/",
      ...overrides,
    });

  it("starts each build when it is first seen, not when Xcode was opened", () => {
    const store = migrated();
    const engine = engineWith(store);
    engine.foldSnapshot([service()], NOW, MBP);
    const [first] = store.listUnresolved();
    expect(first).toMatchObject({ startedAt: NOW, hostId: MBP, pid: 555 });
  });

  it("gives the second build in one Xcode session a run of its own", () => {
    const store = migrated();
    const engine = engineWith(store);
    engine.foldSnapshot([service()], NOW, MBP);
    // The build ends: the service goes quiet and drops out of the snapshot.
    for (let tick = 1; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
      engine.foldSnapshot([], NOW + tick * 2_000, MBP);
    }
    // A minute later the same service, same pid, builds again.
    engine.foldSnapshot([service()], NOW + 60_000, MBP);

    const runs = store.listRuns({ limit: 10, includeNoise: true });
    expect(runs.map((entry) => [entry.startedAt, entry.status])).toEqual([
      [NOW + 60_000, "running"],
      [NOW, "finishing"],
    ]);
  });

  it("ends one build and starts another when the service moves to another workspace", () => {
    const store = migrated();
    const scopes = new ThreadScopes();
    const scope = { projectId: null, environmentId: "env", branch: null, active: true, hostId: MBP };
    scopes.upsert({ ...scope, threadId: "thr_a", path: "/w/A" }, NOW);
    scopes.upsert({ ...scope, threadId: "thr_b", path: "/w/B" }, NOW);
    const engine = engineWith(store, scopes);
    engine.foldSnapshot(
      [service({ roots: ["/dd/A"], container: "/w/A/App.xcworkspace" })],
      NOW,
      MBP,
    );
    // The Mac was out of reach while A finished; the next answer is B.
    engine.foldSnapshot(
      [service({ roots: ["/dd/B"], container: "/w/B/App.xcworkspace" })],
      NOW + 300_000,
      MBP,
    );
    const runs = store.listRuns({ limit: 10, includeNoise: true });
    expect(runs.map((row) => [row.threadId, row.root, row.status])).toEqual([
      ["thr_b", "/dd/B", "running"],
      ["thr_a", "/dd/A", "finishing"],
    ]);
    // Still serving B: the same run, not a third.
    engine.foldSnapshot(
      [service({ roots: ["/dd/B"], container: "/w/B/App.xcworkspace" })],
      NOW + 302_000,
      MBP,
    );
    expect(store.listRuns({ limit: 10, includeNoise: true })).toHaveLength(2);
  });

  it("re-adopts a build across a restart, and refuses a recycled pid", () => {
    const store = migrated();
    store.insertRun(run(observedRunId(MBP, 555, NOW), { hostId: MBP, pid: 555, startedAt: NOW }));
    const engine = engineWith(store);
    engine.hydrate(NOW + 30_000);
    // The service predates the build it is serving: the same process.
    engine.foldSnapshot([service()], NOW + 32_000, MBP);
    expect(store.listUnresolved().map((entry) => entry.id)).toEqual([observedRunId(MBP, 555, NOW)]);

    const other = migrated();
    other.insertRun(run(observedRunId(MBP, 555, NOW), { hostId: MBP, pid: 555, startedAt: NOW }));
    const fresh = engineWith(other);
    fresh.hydrate(NOW + 30_000);
    // A service that started after the build did cannot have been serving it.
    fresh.foldSnapshot([service({ startedAt: NOW + 25_000 })], NOW + 32_000, MBP);
    expect(other.getRun(observedRunId(MBP, 555, NOW))?.status).toBe("finishing");
  });
});

describe("log entries and bundles from another Mac", () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({
    uniqueIdentifier: "A1B2C3D4-0000-0000-0000-000000000001",
    title: "Build Amion",
    scheme: "Amion",
    startedAt: NOW,
    endedAt: NOW + 30_000,
    status: "passed" as const,
    errorCount: 0,
    warningCount: 0,
    analyzerCount: 0,
    testFailureCount: 0,
    ...overrides,
  });

  it("files an Xcode.app build under its Mac and the thread its workspace is in", () => {
    const store = migrated();
    const scopes = new ThreadScopes();
    scopes.upsert(
      {
        threadId: "thr_mbp",
        projectId: null,
        environmentId: "env",
        path: "/Users/gustavo/Development/ios-amion-v2",
        hostId: MBP,
        branch: null,
        active: true,
      },
      NOW,
    );
    const engine = engineWith(store, scopes);
    engine.foldManifestEntry("/Users/gustavo/Library/Developer/Xcode/DerivedData/Amion-abc", "build", entry(), NOW, {
      hostId: MBP,
      container: "/Users/gustavo/Development/ios-amion-v2/Amion.xcworkspace",
    });
    expect(store.getRun("m:A1B2C3D4-0000-0000-0000-000000000001")).toMatchObject({
      hostId: MBP,
      threadId: "thr_mbp",
      container: "/Users/gustavo/Development/ios-amion-v2/Amion.xcworkspace",
      status: "passed",
    });
  });

  it("does not let a log entry from one Mac settle a run on another", () => {
    const store = migrated();
    const engine = engineWith(store);
    store.insertRun(run("r:1:1", { status: "finishing", endedAt: NOW + 20_000 }));
    engine.foldManifestEntry("/dd/App-x", "build", entry(), NOW, { hostId: MBP });
    expect(store.getRun("r:1:1")?.status).toBe("finishing");
    expect(store.getRun("m:A1B2C3D4-0000-0000-0000-000000000001")?.hostId).toBe(MBP);
  });

  it("absorbs a tracked build's own log entry instead of filing a second row", () => {
    const store = migrated();
    const engine = engineWith(store);
    store.insertRun(
      run("w:abc-0123456789ab", { hostId: MBP, scheme: "Amion", status: "passed", statusRank: RANK.logged, endedAt: NOW + 30_000 }),
    );
    expect(engine.foldManifestEntry("/dd/Amion-x", "build", entry(), NOW, { hostId: MBP })).toBe(false);
    expect(store.listRuns({ limit: 10, includeNoise: true }).map((row) => row.id)).toEqual([
      "w:abc-0123456789ab",
    ]);
    expect(store.hasSeen("manifest:A1B2C3D4-0000-0000-0000-000000000001")).toBe(true);
  });

  it("absorbs it also once the tracked build's own bundle made it verified", () => {
    const store = migrated();
    const engine = engineWith(store);
    store.insertRun(
      run("w:abc-0123456789ab", {
        hostId: MBP,
        scheme: "Amion",
        status: "passed",
        statusRank: RANK.verified,
        endedAt: NOW + 30_000,
      }),
    );
    engine.foldManifestEntry("/dd/Amion-x", "build", entry(), NOW, { hostId: MBP });
    expect(store.listRuns({ limit: 10, includeNoise: true }).map((row) => row.id)).toEqual([
      "w:abc-0123456789ab",
    ]);
  });

  it("never absorbs another worktree's log entry of the same scheme", () => {
    const store = migrated();
    const engine = engineWith(store);
    // A tracked build in worktree A, on default DerivedData: no root known.
    store.insertRun(
      run("w:abc-0123456789ab", {
        hostId: MBP,
        scheme: "Amion",
        root: null,
        cwd: "/w/A",
        container: "Amion.xcworkspace",
        status: "passed",
        statusRank: RANK.verified,
        endedAt: NOW + 30_000,
      }),
    );
    // Worktree B's Xcode.app build of the same scheme, at the same time.
    engine.foldManifestEntry("/dd/Amion-b", "build", entry(), NOW, {
      hostId: MBP,
      container: "/w/B/Amion.xcworkspace",
    });
    expect(store.getRun("m:A1B2C3D4-0000-0000-0000-000000000001")).toMatchObject({
      container: "/w/B/Amion.xcworkspace",
      hostId: MBP,
    });
    // A's own entry is still absorbed.
    engine.foldManifestEntry(
      "/dd/Amion-a",
      "build",
      entry({ uniqueIdentifier: "A-OWN" }),
      NOW,
      { hostId: MBP, container: "/w/A/Amion.xcworkspace" },
    );
    expect(store.getRun("m:A-OWN")).toBeNull();
    expect(store.hasSeen("manifest:A-OWN")).toBe(true);
  });

  it("never lets a thread command's exit settle an Xcode.app build", () => {
    const store = migrated();
    const engine = engineWith(store);
    const ide = {
      threadId: "thr_mbp",
      status: "finishing" as const,
      startedAt: NOW + 1_000,
      endedAt: NOW + 20_000,
    };
    store.insertRun(
      run(observedRunId(MBP, 812, NOW + 1_000), {
        ...ide,
        hostId: MBP,
        pid: 812,
        cmdline:
          "/Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService",
      }),
    );
    store.insertRun(run("m:IDE-ENTRY", { ...ide, hostId: MBP, pid: null }));
    const folded = engine.foldThreadCommandExit(
      {
        taskId: "task",
        threadId: "thr_mbp",
        command: "xcodebuild -scheme Other build",
        cwd: "",
        startedAt: NOW,
        endedAt: NOW + 30_000,
        exitCode: 0,
        interrupted: false,
      },
      NOW + 31_000,
    );
    expect(folded).toBe(false);
    expect(store.listRuns({ limit: 10, includeNoise: true }).map((row) => row.status)).toEqual([
      "finishing",
      "finishing",
    ]);
  });

  it("lets an Xcode.app build of another scheme beside a tracked one keep its own row", () => {
    const store = migrated();
    const engine = engineWith(store);
    store.insertRun(run("w:abc-0123456789ab", { hostId: MBP, scheme: "Widgets", status: "running" }));
    engine.foldManifestEntry("/dd/Amion-x", "build", entry(), NOW, { hostId: MBP });
    expect(store.getRun("m:A1B2C3D4-0000-0000-0000-000000000001")?.hostId).toBe(MBP);
  });

  it("matches a bundle to a run on the Mac it was read on, never a tracked build", () => {
    const store = migrated();
    const engine = engineWith(store);
    const build = {
      status: "passed" as const,
      startedAt: NOW,
      endedAt: NOW + 10_000,
      errorCount: 0,
      warningCount: 0,
      analyzerCount: 0,
      actionTitle: null,
      destination: null,
      issues: [],
    };
    store.insertRun(run("w:abc-0123456789ab", { hostId: MBP, status: "finishing", endedAt: NOW + 10_000 }));
    store.insertRun(run("r:1:1", { status: "finishing", endedAt: NOW + 10_000 }));
    expect(engine.foldBundle("/dd/App/Logs/Test/Run.xcresult", build, null, [], NOW, MBP)).toBe(false);
    store.insertRun(run(observedRunId(MBP, 7, NOW), { hostId: MBP, pid: 7, status: "finishing", endedAt: NOW + 10_000 }));
    expect(engine.foldBundle("/dd/App/Logs/Test/Run.xcresult", build, null, [], NOW, MBP)).toBe(true);
    expect(store.getRun(observedRunId(MBP, 7, NOW))?.status).toBe("passed");
    expect(store.getRun("r:1:1")?.status).toBe("finishing");
    expect(store.getRun("w:abc-0123456789ab")?.status).toBe("finishing");
  });
});

describe("the store, per Mac", () => {
  it("moves every existing root over as this machine's when it upgrades", () => {
    const db = new Database(":memory:") as unknown as Db;
    // A database exactly as v0.5.0 left it, with roots already known.
    for (const statement of MIGRATIONS.slice(0, V4_MIGRATIONS_START)) db.prepare(statement).run();
    db.prepare(
      `INSERT INTO root (path, project_id, discovered_via, first_seen_at, last_seen_at)
       VALUES ('/Users/me/Library/Developer/Xcode/DerivedData/App-abc', 'proj_app', 'default', 1, 2)`,
    ).run();
    for (const statement of MIGRATIONS.slice(V4_MIGRATIONS_START)) db.prepare(statement).run();
    const store = new Store(db);

    expect(store.listRoots()).toEqual([
      {
        path: "/Users/me/Library/Developer/Xcode/DerivedData/App-abc",
        projectId: "proj_app",
        discoveredVia: "default",
        firstSeenAt: 1,
        lastSeenAt: 2,
      },
    ]);
    expect(store.listRoots(MBP)).toEqual([]);
    // Upserting it again is an update of that row, not a second one.
    expect(store.upsertRoot("/Users/me/Library/Developer/Xcode/DerivedData/App-abc", null, "process", 3)).toBe(false);
    expect(store.listRoots()).toHaveLength(1);
  });

  it("keeps the same root path on two Macs apart", () => {
    const store = migrated();
    const path = "/Users/me/Library/Developer/Xcode/DerivedData/App-abc";
    expect(store.upsertRoot(path, null, "default", NOW)).toBe(true);
    expect(store.upsertRoot(path, null, "default", NOW, MBP)).toBe(true);
    expect(store.upsertRoot(path, "proj", "process", NOW + 1, MBP)).toBe(false);
    expect(store.listRoots().map((root) => root.projectId)).toEqual([null]);
    expect(store.listRoots(MBP).map((root) => root.projectId)).toEqual(["proj"]);
    // Retention prunes every Mac's stale roots alike.
    expect(store.pruneRoots(NOW + 10)).toBe(2);
  });

  it("queues each Mac's claimed bundles under that Mac only", () => {
    const store = migrated();
    const path = "/Users/me/out/Run.xcresult";
    // Detailed already, so only the "scanned" key decides: it is per Mac.
    store.insertRun(run("r:1:1", { status: "failed", bundlePath: path, detailed: true }));
    store.insertRun(
      run(observedRunId(MBP, 2, NOW), { hostId: MBP, status: "failed", bundlePath: path, detailed: true }),
    );
    store.insertRun(run("w:abc-0123456789ab", { hostId: MBP, status: "failed", bundlePath: "/mbp/data/builds/x/b.xcresult" }));

    expect(store.listUnscannedBundlePaths()).toEqual([path]);
    expect(store.listUnscannedBundlePaths(500, MBP)).toEqual([path]);
    store.markSeen(bundleScannedKey(MBP, path), NOW);
    expect(store.listUnscannedBundlePaths(500, MBP)).toEqual([]);
    // The local copy of that path is a different bundle, still unread.
    expect(store.listUnscannedBundlePaths()).toEqual([path]);
    expect(store.getRunByBundlePath(path, MBP)?.hostId).toBe(MBP);
    expect(store.getRunByBundlePath(path, null)?.hostId).toBeNull();
  });

  it("keeps watched runs out of the tracked-build bookkeeping", () => {
    const store = migrated();
    store.insertRun(run(observedRunId(MBP, 2, NOW), { hostId: MBP, bundlePath: "/x.xcresult", status: "running" }));
    expect(store.listRemoteRunsAwaitingHost()).toEqual([]);
    expect(store.listUnscannedRemoteBundles()).toEqual([]);
    expect(store.listRemoteHostIds()).toEqual([]);
    expect(store.countRunsOnHost(MBP)).toBe(0);
    // But it is an open run on that Mac, and that Mac is watched until it ends.
    expect(store.hasUnresolved(MBP)).toBe(true);
    expect(store.hasUnresolved()).toBe(false);
    expect(store.listHostsWithOpenWatchedRuns()).toEqual([MBP]);
  });
});

describe("which Macs are watched", () => {
  const base = { projectId: null, environmentId: "env", branch: null };

  it("watches a Mac while a thread there runs a turn, and for the idle TTL after it", () => {
    const scopes = new ThreadScopes();
    scopes.upsert({ ...base, threadId: "thr_a", path: "/a", hostId: MBP, active: true }, NOW);
    // A turn on the Air ended at NOW.
    scopes.upsert({ ...base, threadId: "thr_b", path: "/b", hostId: AIR, active: true }, NOW - 600_000);
    scopes.deactivate("thr_b", NOW);
    scopes.upsert({ ...base, threadId: "thr_c", path: "/c", hostId: null, active: true }, NOW);

    expect(scopes.watchedHosts(NOW + 60_000).sort()).toEqual([AIR, MBP]);
    // Idle past the TTL: no longer worth a process scan every few seconds.
    expect(scopes.watchedHosts(NOW + SCOPE_IDLE_TTL_MS + 1)).toEqual([MBP]);
    scopes.deactivate("thr_a", NOW + SCOPE_IDLE_TTL_MS);
    expect(scopes.watchedHosts(NOW + 2 * SCOPE_IDLE_TTL_MS + 1)).toEqual([]);
  });

  it("does not start watching a Mac because an old thread's scope was resolved", async () => {
    const store = migrated();
    let clock = NOW;
    const sync = new ScopeSync({
      store,
      getThread: async () => ({ environmentId: "env_old" }),
      getEnvironment: async () => ({ path: "/Users/me/Old", hostId: MBP }),
      serverHostId: async () => "host_server",
      log: () => undefined,
      isDisposed: () => false,
      onChanged: () => undefined,
      now: () => clock,
    });
    // Opening the thread in the UI: chatStatus resolves its scope cold.
    await sync.refresh("thr_old", false);
    expect(sync.get("thr_old")?.hostId).toBe(MBP);
    expect(sync.scopes.watchedHosts(clock)).toEqual([]);

    // A real turn starts and ends: watched through it and the TTL after.
    clock += 60_000;
    await sync.refresh("thr_new", true);
    sync.deactivate("thr_new");
    clock += SCOPE_IDLE_TTL_MS - 1;
    expect(sync.scopes.watchedHosts(clock)).toEqual([MBP]);
    // Resolving it again later (TTL-expired cache) does not extend the window.
    await sync.refresh("thr_new", false);
    clock += 2;
    expect(sync.scopes.watchedHosts(clock)).toEqual([]);
  });

  it("adds Macs the person opted in and Macs with a build still open, never this one", () => {
    expect(
      selectHostsToWatch({
        scopeHosts: [MBP],
        optIn: [AIR, "host_server"],
        openRunHosts: ["host_studio", MBP],
        serverHostId: "host_server",
      }),
    ).toEqual([AIR, MBP, "host_studio"]);
  });

  it("watches nothing remote while it cannot tell which machine it is on", () => {
    expect(
      selectHostsToWatch({ scopeHosts: [], optIn: [MBP], openRunHosts: [AIR], serverHostId: null }),
    ).toEqual([]);
  });
});

describe("the bundle sweep's view of a finished build", () => {
  it("looks again before calling a build killed, since the listing may be minutes old", async () => {
    const store = migrated();
    const engine = engineWith(store);
    const bundle = "/Users/me/out/Run.xcresult";
    store.insertRun(
      run("r:1:1", { status: "finishing", bundlePath: bundle, endedAt: NOW - 60_000 }),
    );
    let listings = 0;
    const io: MachineIO = {
      snapshot: async () => [],
      discoverRoots: async () => [],
      readManifests: async () => [],
      // The sweep's own listing predates the bundle being finalized; by the
      // time it gets to this bundle, it is.
      listBundles: async () => {
        listings += 1;
        return { candidates: [bundle], finalized: new Set(listings === 1 ? [] : [bundle]) };
      },
      parseBundle: async () => ({ status: "empty" }),
    };
    const collector = new Collector(
      { store, engine, listProjects: async () => [], log: { debug: () => undefined, warn: () => undefined }, dataDir: "", io },
      { scanProjects: false, extraRoots: [] },
    );
    await collector.sweepBundles(NOW);
    expect(listings).toBe(2);
    expect(store.getRun("r:1:1")?.status).toBe("finishing");
  });
});

describe("an Xcode.app test bundle on a Mac with two checkouts", () => {
  const summary = {
    status: "passed" as const,
    startedAt: NOW + 1_000,
    endedAt: NOW + 20_000,
    total: 12,
    passed: 12,
    failed: 0,
    skipped: 0,
    expectedFailures: 0,
    destination: null,
  };

  function sweeper(store: Store, engine: Engine, bundles: string[]) {
    const io: MachineIO = {
      snapshot: async () => [],
      discoverRoots: async () => [],
      readManifests: async () => [],
      listBundles: async () => ({ candidates: bundles, finalized: new Set(bundles) }),
      parseBundle: async () => ({ status: "ok", build: null, summary, tests: [] }),
    };
    return new Collector(
      { store, engine, listProjects: async () => [], log: { debug: () => undefined, warn: () => undefined }, dataDir: "", io, hostId: MBP },
      { scanProjects: false, extraRoots: [] },
    );
  }

  const ide = (pid: number, root: string, threadId: string, startedAt: number) =>
    run(observedRunId(MBP, pid, startedAt), {
      hostId: MBP,
      pid,
      root,
      threadId,
      kind: "unknown",
      startedAt,
      status: "finishing",
      endedAt: NOW + 25_000,
    });

  it("goes to the run of the checkout whose DerivedData holds it", async () => {
    const store = migrated();
    const engine = engineWith(store);
    store.upsertRoot("/dd/A", null, "process", NOW, MBP);
    store.upsertRoot("/dd/B", null, "process", NOW, MBP);
    store.insertRun(ide(1, "/dd/A", "thr_a", NOW));
    // B started a little later, so it is the newest overlapping run.
    store.insertRun(ide(2, "/dd/B", "thr_b", NOW + 2_000));

    await sweeper(store, engine, ["/dd/A/Logs/Test/Test-App.xcresult"]).sweepBundles(NOW + 60_000);
    expect(store.getRun(observedRunId(MBP, 1, NOW))).toMatchObject({ status: "passed", testTotal: 12 });
    expect(store.getRun(observedRunId(MBP, 2, NOW + 2_000))).toMatchObject({
      status: "finishing",
      testTotal: null,
      detailed: false,
    });
  });

  it("is applied once its run ends, when it was finalized while the run still ran", async () => {
    const store = migrated();
    const engine = engineWith(store);
    store.upsertRoot("/dd/A", null, "process", NOW, MBP);
    const service = activity({
      pid: 812,
      comm: "SWBBuildService",
      isDaemon: true,
      roots: ["/dd/A"],
      startedAt: NOW - 3_600_000,
      kind: "unknown",
      scheme: null,
    });
    engine.foldSnapshot([service], NOW, MBP);
    const id = observedRunId(MBP, 812, NOW);
    const bundle = "/dd/A/Logs/Test/Test-App.xcresult";
    const collector = sweeper(store, engine, [bundle]);

    // Xcode finalizes the bundle before the probe has missed the service
    // three times: the run is still `running` when the sweep reads it.
    await collector.sweepBundles(NOW + 2_000);
    expect(store.getRun(id)).toMatchObject({ status: "running", bundlePath: bundle });
    expect(store.hasSeen(bundleScannedKey(MBP, bundle))).toBe(false);
    // A sweep while it still runs leaves it alone.
    await collector.sweepBundles(NOW + 3_000);
    expect(store.getRun(id)?.status).toBe("running");

    for (let tick = 1; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
      engine.foldSnapshot([], NOW + 4_000 + tick * 2_000, MBP);
    }
    expect(store.getRun(id)?.status).toBe("finishing");
    await collector.sweepBundles(NOW + 12_000);
    expect(store.getRun(id)).toMatchObject({ status: "passed", statusRank: RANK.verified, testTotal: 12 });
    expect(store.hasSeen(bundleScannedKey(MBP, bundle))).toBe(true);
  });
});
