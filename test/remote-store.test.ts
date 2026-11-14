/**
 * `run.host_id`: the store migration, and the wall it puts between this
 * machine's runs and builds on other Macs.
 *
 * Everything that discovers or settles a LOCAL run — the process probe, the
 * log-store and bundle sweeps — reads this machine's process table and disk.
 * Pointed at a remote run, each one would do something confidently wrong: the
 * probe would retire it as a vanished pid, the sweep would stat a path that
 * is not here and call a finished build cancelled. These pin that none of
 * them can see one.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { Engine, MISSES_BEFORE_FINISHING } from "../src/engine";
import { RANK, type Run } from "../src/model";
import { MIGRATIONS, Store, V3_MIGRATIONS_START, type Db } from "../src/store";
import type { LiveActivity } from "../src/types";

const NOW = 1_800_000_000_000;

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
    projectId: "proj_app",
    root: null,
    cwd: "/Users/me/App",
    pid: 4242,
    cmdline: "/usr/bin/xcodebuild -scheme App build",
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
    branch: "main",
    worktree: "App",
    threadId: "thr_app",
    hostId: null,
    ...overrides,
  };
}

function migrated(): { db: Db; store: Store } {
  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  return { db, store: new Store(db) };
}

function activity(overrides: Partial<LiveActivity> = {}): LiveActivity {
  return {
    pid: 4242,
    comm: "xcodebuild",
    args: "/usr/bin/xcodebuild -scheme Local build",
    startedAt: NOW + 60_000,
    roots: [],
    workerCount: 1,
    phase: null,
    currentFile: null,
    isDaemon: false,
    kind: "build",
    scheme: "Local",
    container: null,
    configuration: null,
    destination: null,
    derivedDataPath: null,
    resultBundlePath: null,
    cwd: "/Users/me/Local",
    ...overrides,
  };
}

describe("the run.host_id migration", () => {
  it("upgrades an installed v2 database in place, existing runs read as local", () => {
    const db = new Database(":memory:") as unknown as Db;
    // A database exactly as v0.4.0 left it.
    for (const statement of MIGRATIONS.slice(0, V3_MIGRATIONS_START)) db.prepare(statement).run();
    db.prepare(
      `INSERT INTO run (id, status, kind, started_at, pid, thread_id) VALUES ('r:1:1', 'passed', 'build', 1, 1, 'thr_old')`,
    ).run();

    // What `bb.storage.migrate` does on the next load: the statements it has
    // not applied yet, by index.
    for (const statement of MIGRATIONS.slice(V3_MIGRATIONS_START)) db.prepare(statement).run();
    const store = new Store(db);

    expect(store.getRun("r:1:1")).toMatchObject({ status: "passed", threadId: "thr_old", hostId: null });
    store.insertRun(run("w:abc-0123456789ab", { hostId: "host_mbp" }));
    expect(store.getRun("w:abc-0123456789ab")?.hostId).toBe("host_mbp");
  });

  it("keeps host_id across updates, which never move a run between Macs", () => {
    const { store } = migrated();
    const remote = run("w:abc-0123456789ab", { hostId: "host_mbp" });
    store.insertRun(remote);
    store.updateRun({ ...remote, status: "passed", hostId: null });
    expect(store.getRun(remote.id)).toMatchObject({ status: "passed", hostId: "host_mbp" });
  });
});

describe("local discovery cannot see a remote run", () => {
  it("leaves remote bundles out of the local sweep and in the remote queue", () => {
    const { store } = migrated();
    store.insertRun(run("r:1:1", { status: "failed", bundlePath: "/local/b.xcresult" }));
    store.insertRun(
      run("w:a-0123456789ab", { status: "failed", hostId: "host_mbp", bundlePath: "/mbp/a.xcresult" }),
    );
    store.insertRun(
      run("w:b-0123456789ab", { status: "running", hostId: "host_mbp", bundlePath: "/mbp/b.xcresult" }),
    );

    expect(store.listUnscannedBundlePaths()).toEqual(["/local/b.xcresult"]);
    // Settled only: a running build's bundle is never complete.
    expect(store.listUnscannedRemoteBundles()).toEqual([
      { runId: "w:a-0123456789ab", hostId: "host_mbp", bundlePath: "/mbp/a.xcresult" },
    ]);
    store.markSeen("bundle-scanned:/mbp/a.xcresult", NOW);
    expect(store.listUnscannedRemoteBundles()).toEqual([]);
  });

  it("never offers a remote run to a local manifest or bundle", () => {
    const { store } = migrated();
    store.insertRun(run("w:a-0123456789ab", { hostId: "host_mbp", status: "finishing", endedAt: NOW + 5_000 }));
    expect(store.findVerdictCandidates(NOW + 1_000, 90_000)).toEqual([]);
    store.insertRun(run("r:1:1", { status: "finishing", endedAt: NOW + 5_000 }));
    expect(store.findVerdictCandidates(NOW + 1_000, 90_000).map((entry) => entry.id)).toEqual(["r:1:1"]);
  });

  it("does not speed up the local sweep for a build on another Mac", () => {
    const { store } = migrated();
    store.insertRun(run("w:a-0123456789ab", { hostId: "host_mbp" }));
    expect(store.hasUnresolved()).toBe(false);
    expect(store.listRemoteRunsAwaitingHost().map((entry) => entry.id)).toEqual(["w:a-0123456789ab"]);
    expect(store.listRemoteHostIds()).toEqual(["host_mbp"]);
  });
});

describe("the probe and a remote run with the same pid", () => {
  const hooks = { projectFor: () => null, threadFor: () => null, log: () => undefined };

  it("is not adopted at hydrate, so this machine's ps cannot retire it", () => {
    const { store } = migrated();
    store.insertRun(run("w:a-0123456789ab", { hostId: "host_mbp", pid: 4242 }));
    const engine = new Engine(store, hooks);
    engine.hydrate(NOW + 1_000);
    for (let miss = 0; miss <= MISSES_BEFORE_FINISHING; miss += 1) {
      engine.foldSnapshot([], NOW + 2_000 * (miss + 1));
    }
    expect(store.getRun("w:a-0123456789ab")?.status).toBe("running");
  });

  it("gives a local process that holds the same pid a run of its own", () => {
    const { store } = migrated();
    store.insertRun(run("w:a-0123456789ab", { hostId: "host_mbp", pid: 4242 }));
    const engine = new Engine(store, hooks);
    engine.hydrate(NOW + 1_000);
    engine.foldSnapshot([activity()], NOW + 61_000);

    const local = store.listUnresolved().filter((entry) => entry.hostId === null);
    expect(local.map((entry) => entry.scheme)).toEqual(["Local"]);
    expect(store.getRun("w:a-0123456789ab")).toMatchObject({ status: "running", scheme: "App" });
  });
});
