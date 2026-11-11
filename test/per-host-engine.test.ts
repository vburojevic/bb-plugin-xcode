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

import { Engine, MISSES_BEFORE_FINISHING, observedRunId } from "../src/engine";
import { RANK, type Run } from "../src/model";
import { selectHostsToWatch } from "../src/remote-watch";
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

  it("watches a Mac while a thread there is active or idle within the TTL", () => {
    const scopes = new ThreadScopes();
    scopes.upsert({ ...base, threadId: "thr_a", path: "/a", hostId: MBP, active: true }, NOW);
    scopes.upsert({ ...base, threadId: "thr_b", path: "/b", hostId: AIR, active: false }, NOW);
    scopes.upsert({ ...base, threadId: "thr_c", path: "/c", hostId: null, active: true }, NOW);

    expect(scopes.watchedHosts(NOW + 60_000).sort()).toEqual([AIR, MBP]);
    // Idle past the TTL: no longer worth a process scan every few seconds.
    expect(scopes.watchedHosts(NOW + SCOPE_IDLE_TTL_MS + 1)).toEqual([MBP]);
    scopes.deactivate("thr_a", NOW + SCOPE_IDLE_TTL_MS);
    expect(scopes.watchedHosts(NOW + 2 * SCOPE_IDLE_TTL_MS + 1)).toEqual([]);
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
