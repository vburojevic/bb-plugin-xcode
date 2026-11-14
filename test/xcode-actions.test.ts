/**
 * Xcode.app's actions, read from DerivedData, and what the engine makes of
 * them: the evidence that keeps a build service's run alive and attributed
 * while the service has no children to show for it.
 */

import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Engine, MISSES_BEFORE_FINISHING, observedRunId, ownedBy } from "../src/engine";
import { RANK, type Run } from "../src/model";
import { ProcessObserver } from "../src/observe";
import { argv0 } from "../src/proc";
import { MIGRATIONS, Store, type Db } from "../src/store";
import type { LiveActivity } from "../src/types";
import { DerivedDataActions, MAX_ACTION_AGE_MS, parseTestBundleName } from "../src/xcode-actions";
import { makeDerivedRoot } from "./support/derived-data";

const MBP = "host_mbp";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function derivedData() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xcode-actions-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, "DerivedData");
  const root = makeDerivedRoot(join(dir, "Amion-endstfoehlpvssasdpemoqxcvbwv"), {
    workspace: join(base, "ios-amion-v2-2/Amion.xcworkspace"),
  });
  return { base, dir, root };
}

function testBundle(root: string, name: string, finalized: boolean): string {
  const bundle = join(root, "Logs", "Test", name);
  mkdirSync(join(bundle, "Data"), { recursive: true });
  if (finalized) writeFileSync(join(bundle, "Info.plist"), "");
  return bundle;
}

describe("test bundle names", () => {
  it("read as Xcode writes them: local time and its offset", () => {
    // The user's run: 08:19:19 at UTC-10 is 18:19:19Z.
    expect(parseTestBundleName("Test-Amion-2026.11.11_08-19-19--1000.xcresult")).toEqual({
      scheme: "Amion",
      startedAt: Date.UTC(2026, 10, 11, 18, 19, 19),
    });
    expect(parseTestBundleName("Test-SurfTracker Watch-2026.11.05_06-42-26-+0130.xcresult")).toEqual({
      scheme: "SurfTracker Watch",
      startedAt: Date.UTC(2026, 10, 5, 5, 12, 26),
    });
    expect(parseTestBundleName("Run-App-2026.xcresult")).toBeNull();
  });
});

describe("actions in progress", () => {
  const NOW = Date.UTC(2026, 10, 11, 18, 44, 0);

  it("finds a test action from its unfinalized bundle, from its first second", async () => {
    const { dir, root } = derivedData();
    testBundle(root, "Test-Amion-2026.11.11_08-19-19--1000.xcresult", true);
    const running = testBundle(root, "Test-Amion-2026.11.11_08-43-05--1000.xcresult", false);
    expect(await new DerivedDataActions(dir).inProgress(NOW, [])).toEqual([
      {
        root,
        kind: "test",
        startedAt: Date.UTC(2026, 10, 11, 18, 43, 5),
        bundlePath: running,
        scheme: "Amion",
      },
    ]);
  });

  it("ignores a bundle that is finalized, superseded, or too old to be running", async () => {
    const { dir, root } = derivedData();
    // Left unfinalized by an older action, then a newer one finished.
    testBundle(root, "Test-Amion-2026.11.11_08-10-00--1000.xcresult", false);
    testBundle(root, "Test-Amion-2026.11.11_08-20-00--1000.xcresult", true);
    const actions = new DerivedDataActions(dir);
    expect(await actions.inProgress(NOW, [])).toEqual([]);

    const other = derivedData();
    testBundle(other.root, "Test-Amion-2026.11.11_08-43-05--1000.xcresult", false);
    expect(
      await new DerivedDataActions(other.dir).inProgress(
        Date.UTC(2026, 10, 11, 18, 43, 5) + MAX_ACTION_AGE_MS + 1,
        [],
      ),
    ).toEqual([]);
  });

  it("finds a build holding its build database open", async () => {
    const { dir, root } = derivedData();
    const data = join(root, "Build/Intermediates.noindex/XCBuildData");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "build.db"), "");
    expect(await new DerivedDataActions(dir).inProgress(Date.now(), [])).toEqual([]);
    writeFileSync(join(data, "build.db-journal"), "");
    expect(await new DerivedDataActions(dir).inProgress(Date.now(), [])).toMatchObject([
      { root, kind: "build", bundlePath: null },
    ]);
  });
});

describe("a quiet build service with an action in progress", () => {
  const SERVICE =
    "/Applications/Xcode-27.2.0.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService";
  const ps = `    1     0 10-00:00:00 /sbin/launchd\n11699     1 01:30:00 ${SERVICE}\n`;

  it("is reported, with the action's root, start and bundle", async () => {
    const { dir, root } = derivedData();
    const bundle = testBundle(root, "Test-Amion-2026.11.11_08-43-05--1000.xcresult", false);
    const observer = new ProcessObserver({
      ps: async () => ps,
      cwdOf: async () => null,
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });
    const now = Date.UTC(2026, 10, 11, 18, 44, 16);
    expect(await observer.snapshot(now)).toMatchObject([
      {
        pid: 11699,
        isDaemon: true,
        roots: [root],
        kind: "test",
        scheme: "Amion",
        resultBundlePath: bundle,
        actionStartedAt: Date.UTC(2026, 10, 11, 18, 43, 5),
      },
    ]);
  });

  it("is not reported without one, nor when no build service is running", async () => {
    const { dir, root } = derivedData();
    const idle = new ProcessObserver({
      ps: async () => ps,
      cwdOf: async () => null,
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });
    expect(await idle.snapshot(Date.now())).toEqual([]);

    testBundle(root, "Test-Amion-2026.11.11_08-43-05--1000.xcresult", false);
    const noXcode = new ProcessObserver({
      ps: async () => `    1     0 10-00:00:00 /sbin/launchd\n`,
      cwdOf: async () => null,
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });
    expect(await noXcode.snapshot(Date.UTC(2026, 10, 11, 18, 44, 16))).toEqual([]);
  });

  it("is not given the journal of a terminal build on the same Mac", async () => {
    const { base, dir, root } = derivedData();
    const data = join(root, "Build/Intermediates.noindex/XCBuildData");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "build.db-journal"), "");
    const checkout = join(base, "ios-amion-v2-2");
    const observer = new ProcessObserver({
      ps: async () =>
        `${ps}  950     1 00:20 /usr/bin/xcodebuild -scheme Amion build\n`,
      cwdOf: async (pid) => (pid === 950 ? checkout : null),
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });
    expect((await observer.snapshot(Date.now()))?.map((activity) => activity.pid)).toEqual([950]);
  });

  it("nor that of a terminal build of a Swift package, whose workspace is its directory", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "xcode-actions-")));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const dir = join(base, "DerivedData");
    const checkout = join(base, "Pkg");
    // Xcode 27.2 writes the package directory itself as a package root's WorkspacePath.
    const root = makeDerivedRoot(join(dir, "Pkg-abc"), { workspace: checkout });
    const data = join(root, "Build/Intermediates.noindex/XCBuildData");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "build.db-journal"), "");
    const observer = new ProcessObserver({
      ps: async () => `${ps}  950     1 00:20 /usr/bin/xcodebuild -scheme Pkg build\n`,
      cwdOf: async (pid) => (pid === 950 ? checkout : null),
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });
    expect((await observer.snapshot(Date.now()))?.map((activity) => activity.pid)).toEqual([950]);
  });
});

describe("a Swift package built in its own directory", () => {
  it("owns the artifacts of the root that names that directory as its workspace", () => {
    const pkg = "/Users/me/Pkg";
    expect(ownedBy({ root: null, container: null, cwd: pkg }, { root: null, workspace: pkg })).toBe(true);
    expect(ownedBy({ root: null, container: null, cwd: "/Users/me/Other" }, { root: null, workspace: pkg })).toBe(false);
  });
});

describe("the engine and a build service's actions", () => {
  const NOW = 1_800_000_000_000;
  const store = () => {
    const db = new Database(":memory:") as unknown as Db;
    for (const statement of MIGRATIONS) db.prepare(statement).run();
    return new Store(db);
  };
  const service = (overrides: Partial<LiveActivity>): LiveActivity => ({
    pid: 11699,
    comm: "SWBBuildService",
    args: "/Applications/Xcode.app/…/SWBBuildService",
    startedAt: NOW - 3_600_000,
    roots: ["/dd/Amion"],
    workerCount: 0,
    phase: null,
    currentFile: null,
    isDaemon: true,
    kind: "test",
    scheme: "Amion",
    container: "/w/Amion.xcworkspace",
    configuration: null,
    destination: null,
    derivedDataPath: null,
    resultBundlePath: "/dd/Amion/Logs/Test/A.xcresult",
    cwd: null,
    ...overrides,
  });

  it("starts the run when the action began, and claims its bundle", () => {
    const runs = store();
    const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    engine.foldSnapshot([service({ actionStartedAt: NOW - 71_000 })], NOW, MBP);
    expect(runs.getRun(observedRunId(MBP, 11699, NOW - 71_000))).toMatchObject({
      startedAt: NOW - 71_000,
      kind: "test",
      bundlePath: "/dd/Amion/Logs/Test/A.xcresult",
    });
  });

  it("gives a second action in the same workspace, back to back, its own run", () => {
    const runs = store();
    const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    engine.foldSnapshot([service({ actionStartedAt: NOW - 60_000 })], NOW, MBP);
    engine.foldSnapshot(
      [service({ actionStartedAt: NOW + 4_000, resultBundlePath: "/dd/Amion/Logs/Test/B.xcresult" })],
      NOW + 6_000,
      MBP,
    );
    const rows = runs.listRuns({ limit: 10, includeNoise: true });
    expect(rows.map((row) => [row.bundlePath, row.status])).toEqual([
      ["/dd/Amion/Logs/Test/B.xcresult", "running"],
      ["/dd/Amion/Logs/Test/A.xcresult", "finishing"],
    ]);
  });

  it("claims the bundle of an action that began after its run was first seen", () => {
    const runs = store();
    const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    engine.foldSnapshot([service({ kind: "unknown", resultBundlePath: null, scheme: null })], NOW, MBP);
    engine.foldSnapshot([service({})], NOW + 2_000, MBP);
    const [row] = runs.listRuns({ limit: 10, includeNoise: true });
    expect(row).toMatchObject({ kind: "test", scheme: "Amion", bundlePath: "/dd/Amion/Logs/Test/A.xcresult" });
    for (let tick = 1; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
      engine.foldSnapshot([], NOW + 2_000 + tick * 2_000, MBP);
    }
    expect(runs.getRun(row!.id)?.status).toBe("finishing");
  });

  it("keeps an action's identity learned late, so the next action is a run of its own", () => {
    const runs = store();
    const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    const rootless = { roots: [], container: null, kind: "unknown" as const, scheme: null, resultBundlePath: null };
    // First seen compiling SDK modules: nothing names the action yet.
    engine.foldSnapshot([service(rootless)], NOW, MBP);
    // Then its bundle and start, from disk.
    engine.foldSnapshot([service({ actionStartedAt: NOW - 3_000 })], NOW + 2_000, MBP);
    // The next action, back to back in the same workspace.
    engine.foldSnapshot(
      [service({ actionStartedAt: NOW + 30_000, resultBundlePath: "/dd/Amion/Logs/Test/B.xcresult" })],
      NOW + 32_000,
      MBP,
    );
    const rows = runs.listRuns({ limit: 10, includeNoise: true });
    expect(rows.map((row) => [row.bundlePath, row.status])).toEqual([
      ["/dd/Amion/Logs/Test/B.xcresult", "running"],
      ["/dd/Amion/Logs/Test/A.xcresult", "finishing"],
    ]);
  });

  it("tells the next action from the one a run was adopted with after a restart", () => {
    const runs = store();
    const before = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    const a = "/dd/Amion/Logs/Test/Test-Amion-2026.11.11_08-43-05--1000.xcresult";
    const aStart = Date.UTC(2026, 10, 11, 18, 43, 5);
    const at = aStart + 60_000;
    before.foldSnapshot([service({ actionStartedAt: aStart, resultBundlePath: a, startedAt: at - 3_600_000 })], at, MBP);

    // The plugin reloads mid-action; the same action is still the same run.
    const after = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    after.hydrate(at + 1_000);
    after.foldSnapshot([service({ actionStartedAt: aStart, resultBundlePath: a, startedAt: at - 3_600_000 })], at + 2_000, MBP);
    expect(runs.listRuns({ limit: 10, includeNoise: true })).toHaveLength(1);

    // The next one is not.
    const b = "/dd/Amion/Logs/Test/Test-Amion-2026.11.11_08-44-30--1000.xcresult";
    after.foldSnapshot(
      [service({ actionStartedAt: aStart + 85_000, resultBundlePath: b, startedAt: at - 3_600_000 })],
      at + 30_000,
      MBP,
    );
    expect(runs.listRuns({ limit: 10, includeNoise: true }).map((row) => [row.bundlePath, row.status])).toEqual([
      [b, "running"],
      [a, "finishing"],
    ]);
  });

  it("puts a run on its thread the moment its workspace is known", () => {
    const runs = store();
    const engine = new Engine(runs, {
      projectFor: (signals) => (signals.container === "/w/Amion.xcworkspace" ? "proj_amion" : null),
      threadFor: (signals, hostId) =>
        hostId === MBP && signals.container === "/w/Amion.xcworkspace" ? "thr_amion" : null,
      log: () => undefined,
    });
    // SDK modules first: no root, no workspace, no thread.
    engine.foldSnapshot(
      [service({ roots: [], container: null, kind: "unknown", scheme: null, resultBundlePath: null })],
      NOW,
      MBP,
    );
    const [first] = runs.listRuns({ limit: 10, includeNoise: true });
    expect(first).toMatchObject({ root: null, container: null, threadId: null });

    // The action is found on disk: its root, and the root's workspace.
    engine.foldSnapshot([service({ actionStartedAt: NOW - 3_000, branch: "main", worktree: "Amion" })], NOW + 2_000, MBP);
    expect(runs.listRuns({ limit: 10, includeNoise: true })).toEqual([
      expect.objectContaining({
        id: first!.id,
        status: "running",
        root: "/dd/Amion",
        container: "/w/Amion.xcworkspace",
        projectId: "proj_amion",
        threadId: "thr_amion",
        branch: "main",
        bundlePath: "/dd/Amion/Logs/Test/A.xcresult",
      }),
    ]);
  });
});

describe("a root Xcode creates for a workspace's first action", () => {
  it("is looked in on the next probe, not a minute later", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "xcode-actions-")));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const dir = join(base, "DerivedData");
    mkdirSync(dir);
    const actions = new DerivedDataActions(dir);
    const now = Date.UTC(2026, 10, 11, 18, 43, 6);
    // Xcode is open and idle: the service is up, nothing is in progress.
    expect(await actions.inProgress(now, [])).toEqual([]);

    // The first test action of a new workspace: its root and bundle, before
    // the root has a log store at all.
    const root = join(dir, "Fresh-abcdefghijklmnopqrstuvwxyzab");
    const bundle = testBundle(root, "Test-Fresh-2026.11.11_08-43-07--1000.xcresult", false);
    expect(await actions.inProgress(now + 2_000, [])).toMatchObject([
      { root, kind: "test", bundlePath: bundle },
    ]);
  });
});

describe("evidence left behind", () => {
  const SERVICE =
    "/Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService";
  const NOW = Date.UTC(2026, 10, 11, 18, 44, 16);
  /** Xcode reopened after a crash: its service has been up 90 minutes. */
  const ps = (etime = "01:30:00") =>
    `    1     0 10-00:00:00 /sbin/launchd\n12000     1 ${etime} ${SERVICE}\n`;
  const store = () => {
    const db = new Database(":memory:") as unknown as Db;
    for (const statement of MIGRATIONS) db.prepare(statement).run();
    return new Store(db);
  };
  const observer = (dir: string, etime?: string) =>
    new ProcessObserver({
      ps: async () => ps(etime),
      cwdOf: async () => null,
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });

  /** Idle probes, folded, until anything still running would be retired. */
  async function idleProbes(runs: Store, engine: Engine, watch: ProcessObserver): Promise<void> {
    for (let tick = 0; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
      const now = NOW + tick * 2_000;
      engine.foldSnapshot((await watch.snapshot(now))!, now, MBP);
    }
    expect(runs.listUnresolved().filter((run) => run.status === "running")).toEqual([]);
  }

  it("a crash's unfinished test bundle is not an action of the reopened Xcode", async () => {
    const { dir, root } = derivedData();
    // Two hours ago, under the service that crashed.
    testBundle(root, "Test-Amion-2026.11.11_06-44-16--1000.xcresult", false);
    const runs = store();
    const orphan = crashed(root);
    runs.insertRun(orphan);
    const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    engine.hydrate(NOW);
    await idleProbes(runs, engine, observer(dir));
    expect(runs.listRuns({ limit: 10, includeNoise: true }).map((run) => [run.id, run.status])).toEqual([
      [orphan.id, "finishing"],
    ]);
  });

  it("nor is a journal its build left open", async () => {
    const { dir, root } = derivedData();
    const data = join(root, "Build/Intermediates.noindex/XCBuildData");
    mkdirSync(data, { recursive: true });
    const journal = join(data, "build.db-journal");
    writeFileSync(journal, "");
    utimesSync(journal, new Date(NOW - 2 * 3_600_000), new Date(NOW - 2 * 3_600_000));
    const runs = store();
    const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    await idleProbes(runs, engine, observer(dir));
    expect(runs.listRuns({ limit: 10, includeNoise: true })).toEqual([]);
  });

  it("with no Xcode.app to credit it to, counts only what began under this service", async () => {
    const { dir, root } = derivedData();
    // Named 26 s before the service started: a crash's, or this session's —
    // with no Xcode.app in sight, there is no telling, so it is a gap.
    testBundle(root, "Test-Amion-2026.11.11_08-43-50--1000.xcresult", false);
    expect(await observer(dir, "00:00:00").snapshot(NOW)).toEqual([]);
    // Named after it started: the service's own.
    const bundle = testBundle(root, "Test-Amion-2026.11.11_08-44-10--1000.xcresult", false);
    expect(await observer(dir, "00:10").snapshot(NOW)).toMatchObject([
      { pid: 12000, roots: [root], resultBundlePath: bundle },
    ]);
  });
});

/** The run the crashed service left running, two hours ago. */
function crashed(root: string): Run {
  const startedAt = Date.UTC(2026, 10, 11, 16, 44, 16);
  return {
    id: observedRunId(MBP, 11699, startedAt),
    status: "running",
    statusRank: RANK.observed,
    kind: "test",
    scheme: "Amion",
    container: null,
    configuration: null,
    destination: null,
    projectId: null,
    root,
    cwd: null,
    pid: 11699,
    cmdline: "/Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService",
    startedAt,
    endedAt: null,
    errorCount: 0,
    warningCount: 0,
    analyzerCount: 0,
    testTotal: null,
    testFailed: null,
    testSkipped: null,
    bundlePath: join(root, "Logs/Test/Test-Amion-2026.11.11_06-44-16--1000.xcresult"),
    detailed: false,
    branch: null,
    worktree: null,
    threadId: null,
    hostId: MBP,
  };
}

describe("review of 4a750ba", () => {
  const APP = "/Applications/Xcode.app/Contents/MacOS/Xcode";
  const SERVICE =
    "/Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService";
  const NOW = Date.UTC(2026, 10, 11, 18, 44, 16);
  const store = () => {
    const db = new Database(":memory:") as unknown as Db;
    for (const statement of MIGRATIONS) db.prepare(statement).run();
    return new Store(db);
  };
  /** Xcode.app and its service, up this long, plus any other processes. */
  const ps = (xcode: string, service: string, extra: string[] = []) =>
    [
      `    1     0 10-00:00:00 /sbin/launchd`,
      `  700     1 ${xcode} ${APP}`,
      `12000   700 ${service} ${SERVICE}`,
      ...extra,
      "",
    ].join("\n");

  describe("a build-only action adopted after a restart", () => {
    const service = (actionStartedAt: number): LiveActivity => ({
      pid: 12000,
      comm: "SWBBuildService",
      args: SERVICE,
      startedAt: NOW - 3_600_000,
      roots: ["/dd/Amion"],
      workerCount: 0,
      phase: null,
      currentFile: null,
      isDaemon: true,
      kind: "unknown",
      scheme: null,
      container: "/w/Amion.xcworkspace",
      configuration: null,
      destination: null,
      derivedDataPath: null,
      resultBundlePath: null,
      cwd: null,
      actionStartedAt,
    });
    const a = NOW - 60_000;

    function adopted() {
      const runs = store();
      new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined }).foldSnapshot(
        [service(a)],
        NOW,
        MBP,
      );
      const after = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
      after.hydrate(NOW + 1_000);
      return { runs, after };
    }

    it("is not the next build, when that is what the first probe after it shows", () => {
      const { runs, after } = adopted();
      after.foldSnapshot([service(a + 90_000)], NOW + 40_000, MBP);
      expect(
        runs.listRuns({ limit: 10, includeNoise: true }).map((row) => [row.startedAt, row.status]),
      ).toEqual([
        [a + 90_000, "running"],
        [a, "finishing"],
      ]);
    });

    it("is still its own build when that is what the first probe shows", () => {
      const { runs, after } = adopted();
      after.foldSnapshot([service(a)], NOW + 2_000, MBP);
      expect(
        runs.listRuns({ limit: 10, includeNoise: true }).map((row) => [row.startedAt, row.status]),
      ).toEqual([[a, "running"]]);
    });
  });

  describe("Xcode reopened right after a crash", () => {
    async function idle(dir: string, table: string) {
      const watch = new ProcessObserver({
        ps: async () => table,
        cwdOf: async () => null,
        gitOf: async () => null,
        actions: new DerivedDataActions(dir),
      });
      const runs = store();
      const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
      const seen = [];
      for (let tick = 0; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
        const snapshot = (await watch.snapshot(NOW + tick * 2_000))!;
        seen.push(snapshot.length);
        engine.foldSnapshot(snapshot, NOW + tick * 2_000, MBP);
      }
      return { seen, runs: runs.listRuns({ limit: 10, includeNoise: true }) };
    }

    it("does not take the crashed session's unfinished bundle for an action", async () => {
      const { dir, root } = derivedData();
      // The test began at 18:43:46Z; Xcode crashed, was reopened ten seconds
      // later, and its new service started ten seconds after that.
      testBundle(root, "Test-Amion-2026.11.11_08-43-46--1000.xcresult", false);
      expect(await idle(dir, ps("00:20", "00:10"))).toEqual({ seen: [0, 0, 0, 0], runs: [] });
    });

    it("nor its build's journal", async () => {
      const { dir, root } = derivedData();
      const data = join(root, "Build/Intermediates.noindex/XCBuildData");
      mkdirSync(data, { recursive: true });
      const journal = join(data, "build.db-journal");
      writeFileSync(journal, "");
      utimesSync(journal, new Date(NOW - 30_000), new Date(NOW - 30_000));
      expect(await idle(dir, ps("00:20", "00:10"))).toEqual({ seen: [0, 0, 0, 0], runs: [] });
    });

    it("while this session's action, named before its service started, is one", async () => {
      const { dir, root } = derivedData();
      const bundle = testBundle(root, "Test-Amion-2026.11.11_08-43-46--1000.xcresult", false);
      const { seen, runs } = await idle(dir, ps("01:00:00", "00:10"));
      expect(seen).toEqual([1, 1, 1, 1]);
      expect(runs).toMatchObject([{ status: "running", bundlePath: bundle }]);
    });
  });

  describe("Xcode.app testing while a terminal builds the same workspace elsewhere", () => {
    it("keeps the IDE's action, which is in a root the terminal build does not use", async () => {
      const { base, dir, root } = derivedData();
      const bundle = testBundle(root, "Test-Amion-2026.11.11_08-43-46--1000.xcresult", false);
      const checkout = join(base, "ios-amion-v2-2");
      const own = join(checkout, ".build-cli");
      const terminals = [
        // Its own DerivedData, by argument...
        `  950     1 00:20 /usr/bin/xcodebuild -workspace Amion.xcworkspace -scheme Amion -derivedDataPath .build-cli build`,
        // ...or as its compilers name it.
        `  960     1 00:20 /usr/bin/xcodebuild -workspace Amion.xcworkspace -scheme Amion build`,
        `  961   960 00:02 /usr/bin/clang -c /src/App/main.m -o ${own}/Build/Intermediates.noindex/App.build/main.o`,
      ];
      for (const lines of [terminals.slice(0, 1), terminals.slice(1)]) {
        const watch = new ProcessObserver({
          ps: async () => ps("01:00:00", "00:50:00", lines),
          cwdOf: async (pid) => (pid === 12000 ? "/" : checkout),
          gitOf: async () => null,
          actions: new DerivedDataActions(dir),
        });
        const runs = store();
        const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
        // Minutes of the simulator running the tests: the service has no
        // children, and the terminal build goes on beside it.
        for (let tick = 0; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
          const snapshot = (await watch.snapshot(NOW + tick * 2_000))!;
          expect(snapshot.find((activity) => activity.pid === 12000)).toMatchObject({
            roots: [root],
            resultBundlePath: bundle,
          });
          engine.foldSnapshot(snapshot, NOW + tick * 2_000, MBP);
        }
        const ide = runs.listRuns({ limit: 10, includeNoise: true }).filter((run) => run.pid === 12000);
        expect(ide).toMatchObject([{ status: "running", root, bundlePath: bundle }]);
      }
    });
  });
});

describe("review of eb9291b", () => {
  const NOW = Date.UTC(2026, 10, 11, 18, 44, 16);
  const service = (app: string) =>
    `${app}/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService`;
  const store = () => {
    const db = new Database(":memory:") as unknown as Db;
    for (const statement of MIGRATIONS) db.prepare(statement).run();
    return new Store(db);
  };

  /** Idle probes of a process table, folded: what showed, and what runs. */
  async function idle(dir: string, table: string, cwds: Record<number, string> = {}) {
    const watch = new ProcessObserver({
      ps: async () => table,
      cwdOf: async (pid) => cwds[pid] ?? "/",
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });
    const runs = store();
    const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    const seen: number[][] = [];
    for (let tick = 0; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
      const snapshot = (await watch.snapshot(NOW + tick * 2_000))!;
      seen.push(snapshot.map((activity) => activity.pid));
      engine.foldSnapshot(snapshot, NOW + tick * 2_000, MBP);
    }
    return { seen, runs: runs.listRuns({ limit: 10, includeNoise: true }) };
  }

  function leftovers() {
    const { base, dir, root } = derivedData();
    // A test began at 18:43:56Z and its Xcode crashed; the build of another
    // action had its journal open since 18:43:50Z.
    testBundle(root, "Test-Amion-2026.11.11_08-43-56--1000.xcresult", false);
    const data = join(root, "Build/Intermediates.noindex/XCBuildData");
    mkdirSync(data, { recursive: true });
    const journal = join(data, "build.db-journal");
    writeFileSync(journal, "");
    utimesSync(journal, new Date(NOW - 26_000), new Date(NOW - 26_000));
    return { base, dir, root };
  }

  describe("an Xcode session that cannot be told", () => {
    it("does not make a crash's leftovers live: two Xcodes open, the service under launchd", async () => {
      const { dir } = leftovers();
      // Reopened; its new service came up 20 s after the abandoned bundle.
      const table = [
        `    1     0 10-00:00:00 /sbin/launchd`,
        `  700     1 05:00:00 /Applications/Xcode.app/Contents/MacOS/Xcode`,
        `  710     1 00:05 /Applications/Xcode-beta.app/Contents/MacOS/Xcode`,
        `12000     1 00:00 ${service("/Applications/Xcode-beta.app")}`,
        "",
      ].join("\n");
      expect(await idle(dir, table)).toEqual({ seen: [[], [], [], []], runs: [] });
    });

    it("still follows what began under the service itself", async () => {
      const { dir, root } = derivedData();
      const bundle = testBundle(root, "Test-Amion-2026.11.11_08-44-10--1000.xcresult", false);
      const table = [
        `    1     0 10-00:00:00 /sbin/launchd`,
        `  700     1 05:00:00 /Applications/Xcode.app/Contents/MacOS/Xcode`,
        `  710     1 01:00 /Applications/Xcode-beta.app/Contents/MacOS/Xcode`,
        `12000     1 00:30 ${service("/Applications/Xcode-beta.app")}`,
        "",
      ].join("\n");
      const { seen, runs } = await idle(dir, table);
      expect(seen).toEqual([[12000], [12000], [12000], [12000]]);
      expect(runs).toMatchObject([{ status: "running", bundlePath: bundle }]);
    });
  });

  describe("an Xcode whose path has a space in it", () => {
    const APP = "/Applications/Xcode 27.app";

    it("is read as the whole path", () => {
      expect(argv0(`${APP}/Contents/MacOS/Xcode -NSDocumentRevisionsDebugMode YES`)).toBe(
        `${APP}/Contents/MacOS/Xcode`,
      );
      expect(argv0(`/usr/bin/open ${APP}/Contents/MacOS/Xcode`)).toBe("/usr/bin/open");
    });

    it("is the session its service's actions are credited to, so a crash's leftovers are not", async () => {
      const { dir } = leftovers();
      const table = [
        `    1     0 10-00:00:00 /sbin/launchd`,
        `  700     1 00:10 ${APP}/Contents/MacOS/Xcode`,
        // Started after its Xcode, but within the service's allowance of
        // the abandoned bundle: only the session tells them apart.
        `12000   700 00:00 ${service(APP)}`,
        "",
      ].join("\n");
      expect(await idle(dir, table)).toEqual({ seen: [[], [], [], []], runs: [] });
    });

    it("while an action of that session, named before its service started, is one", async () => {
      const { dir, root } = derivedData();
      const bundle = testBundle(root, "Test-Amion-2026.11.11_08-43-56--1000.xcresult", false);
      const table = [
        `    1     0 10-00:00:00 /sbin/launchd`,
        `  700     1 01:00:00 ${APP}/Contents/MacOS/Xcode`,
        `12000   700 00:00 ${service(APP)}`,
        "",
      ].join("\n");
      const { seen, runs } = await idle(dir, table);
      expect(seen).toEqual([[12000], [12000], [12000], [12000]]);
      expect(runs).toMatchObject([{ status: "running", bundlePath: bundle }]);
    });
  });

  describe("a terminal build naming its DerivedData by a relative path", () => {
    const APP = "/Applications/Xcode.app";
    const table = (derivedDataPath: string) =>
      [
        `    1     0 10-00:00:00 /sbin/launchd`,
        `  700     1 05:00:00 ${APP}/Contents/MacOS/Xcode`,
        `12000   700 04:00:00 ${service(APP)}`,
        `  950     1 00:30 /usr/bin/xcodebuild -workspace Amion.xcworkspace -scheme Amion -derivedDataPath ${derivedDataPath} build`,
        "",
      ].join("\n");

    it("owns that root when it is the shared one, however it is spelled", async () => {
      const { base, dir, root } = derivedData();
      const data = join(root, "Build/Intermediates.noindex/XCBuildData");
      mkdirSync(data, { recursive: true });
      writeFileSync(join(data, "build.db-journal"), "");
      const checkout = join(base, "ios-amion-v2-2");
      const name = root.slice(dir.length + 1);
      for (const spelling of [`../DerivedData/${name}`, `${dir}/./${name}/`, `${base}/./DerivedData/../DerivedData/${name}`]) {
        const { seen, runs } = await idle(dir, table(spelling), { 950: checkout });
        expect(seen).toEqual([[950], [950], [950], [950]]);
        expect(runs.map((run) => run.pid)).toEqual([950]);
      }
    });

    it("does not own the shared root when it names another", async () => {
      const { base, dir, root } = derivedData();
      const bundle = testBundle(root, "Test-Amion-2026.11.11_08-43-56--1000.xcresult", false);
      const checkout = join(base, "ios-amion-v2-2");
      const { seen, runs } = await idle(dir, table("../DerivedData-cli/Amion"), { 950: checkout });
      expect(seen).toEqual([[950, 12000], [950, 12000], [950, 12000], [950, 12000]]);
      expect(runs.find((run) => run.pid === 12000)).toMatchObject({ status: "running", bundlePath: bundle });
    });
  });
});

describe("review of 85c41cd: a stable and a beta Xcode, each with its own service", () => {
  const NOW = Date.UTC(2026, 10, 11, 18, 44, 16);
  const STABLE = "/Applications/Xcode.app";
  const BETA = "/Applications/Xcode-beta.app";
  const service = (app: string) =>
    `${app}/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService`;
  const compiler = (pid: number, parent: number, root: string) =>
    `${String(pid).padStart(5)} ${String(parent).padStart(5)} 00:02 ${STABLE}/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c -primary-file /src/App/File.swift -o ${root}/Build/Intermediates.noindex/App.build/Debug-iphonesimulator/App.build/Objects-normal/arm64/File.o`;
  /** Beta open for hours; stable reopened 10 s ago, its service up 5 s. */
  const table = (betaFirst: boolean, extra: string[] = []) => {
    const beta = [`  800     1 05:00:00 ${BETA}/Contents/MacOS/Xcode`, `13000   800 04:00:00 ${service(BETA)}`];
    const stable = [`  700     1 00:10 ${STABLE}/Contents/MacOS/Xcode`, `12000   700 00:05 ${service(STABLE)}`];
    return [`    1     0 10-00:00:00 /sbin/launchd`, ...(betaFirst ? [...beta, ...stable] : [...stable, ...beta]), ...extra, ""].join("\n");
  };
  const store = () => {
    const db = new Database(":memory:") as unknown as Db;
    for (const statement of MIGRATIONS) db.prepare(statement).run();
    return new Store(db);
  };
  async function probes(dir: string, ps: string) {
    const watch = new ProcessObserver({
      ps: async () => ps,
      cwdOf: async () => "/",
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });
    const runs = store();
    const engine = new Engine(runs, { projectFor: () => null, threadFor: () => null, log: () => undefined });
    const seen: LiveActivity[][] = [];
    for (let tick = 0; tick <= MISSES_BEFORE_FINISHING; tick += 1) {
      const snapshot = (await watch.snapshot(NOW + tick * 2_000))!;
      seen.push(snapshot);
      engine.foldSnapshot(snapshot, NOW + tick * 2_000, MBP);
    }
    return { seen, runs: runs.listRuns({ limit: 10, includeNoise: true }) };
  }
  /** Stable's test began 20 s ago and stable crashed; so did a build's journal. */
  function crashed() {
    const fixture = derivedData();
    testBundle(fixture.root, "Test-Amion-2026.11.11_08-43-56--1000.xcresult", false);
    const data = join(fixture.root, "Build/Intermediates.noindex/XCBuildData");
    mkdirSync(data, { recursive: true });
    const journal = join(data, "build.db-journal");
    writeFileSync(journal, "");
    utimesSync(journal, new Date(NOW - 20_000), new Date(NOW - 20_000));
    return fixture;
  }

  for (const betaFirst of [true, false]) {
    const order = betaFirst ? "beta listed first" : "stable listed first";

    it(`never makes stable's abandoned bundle or journal beta's build (${order})`, async () => {
      const { dir } = crashed();
      expect(await probes(dir, table(betaFirst))).toEqual({ seen: [[], [], [], []], runs: [] });
    });

    it(`gives beta the action in the root its compilers work in (${order})`, async () => {
      const { dir, root } = derivedData();
      // Beta's own test, begun under it a minute ago, still compiling.
      const bundle = testBundle(root, "Test-Amion-2026.11.11_08-43-16--1000.xcresult", false);
      const { seen, runs } = await probes(dir, table(betaFirst, [compiler(9000, 13000, root)]));
      for (const snapshot of seen) {
        expect(snapshot).toMatchObject([{ pid: 13000, roots: [root], resultBundlePath: bundle, kind: "test" }]);
      }
      expect(runs).toMatchObject([{ pid: 13000, status: "running", bundlePath: bundle }]);
    });

    it(`gives restarted stable its own new action, and beta nothing of stable's crash (${order})`, async () => {
      const { base, dir, root: crashedRoot } = crashed();
      // Stable's new test, in another workspace, begun after it reopened.
      const other = makeDerivedRoot(join(dir, "Other-zyxwvutsrqponmlkjihgfedcbazy"), {
        workspace: join(base, "Other/Other.xcworkspace"),
      });
      const bundle = testBundle(other, "Test-Other-2026.11.11_08-44-14--1000.xcresult", false);
      const { seen, runs } = await probes(dir, table(betaFirst, [compiler(9000, 12000, other)]));
      for (const snapshot of seen) {
        expect(snapshot).toMatchObject([{ pid: 12000, roots: [other], resultBundlePath: bundle }]);
        expect(snapshot.flatMap((activity) => activity.roots)).not.toContain(crashedRoot);
      }
      expect(runs).toMatchObject([{ pid: 12000, status: "running", bundlePath: bundle }]);
    });
  }
});

describe("review of 5914826: an action a service was seen working on, then quiet", () => {
  const NOW = Date.UTC(2026, 10, 11, 18, 44, 16);
  const STABLE = "/Applications/Xcode.app";
  const BETA = "/Applications/Xcode-beta.app";
  const service = (app: string) =>
    `${app}/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService`;
  /** Beta idle; stable's service up `serviceEtime`, compiling into `root` when busy. */
  const table = (root: string, busy: boolean, serviceEtime = "01:00:00") =>
    [
      `    1     0 10-00:00:00 /sbin/launchd`,
      `  800     1 05:00:00 ${BETA}/Contents/MacOS/Xcode`,
      `13000   800 04:00:00 ${service(BETA)}`,
      `  700     1 02:00:00 ${STABLE}/Contents/MacOS/Xcode`,
      `12000   700 ${serviceEtime} ${service(STABLE)}`,
      ...(busy
        ? [
            ` 9000 12000 00:02 ${STABLE}/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c -primary-file /src/App/File.swift -o ${root}/Build/Intermediates.noindex/App.build/File.o`,
          ]
        : []),
      "",
    ].join("\n");

  it("stays that service's while it is in progress, and only while that process lives", async () => {
    const { dir, root } = derivedData();
    const bundle = testBundle(root, "Test-Amion-2026.11.11_08-43-16--1000.xcresult", false);
    let ps = table(root, true);
    const watch = new ProcessObserver({
      ps: async () => ps,
      cwdOf: async () => "/",
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });
    const credited = async (at: number) =>
      ((await watch.snapshot(at)) ?? []).map((activity) => [activity.pid, activity.resultBundlePath]);

    expect(await credited(NOW)).toEqual([[12000, bundle]]);
    // The tests run in the simulator: no compilers, and beta is there too.
    ps = table(root, false);
    expect(await credited(NOW + 2_000)).toEqual([[12000, bundle]]);
    // Two minutes on, the same process: its elapsed time has grown with it.
    ps = table(root, false, "01:02:00");
    expect(await credited(NOW + 120_000)).toEqual([[12000, bundle]]);
    expect(watch.services()).toEqual([
      { pid: 13000, startedAt: NOW + 120_000 - 4 * 3_600_000 },
      { pid: 12000, startedAt: NOW - 3_600_000 },
    ]);

    // The pid now belongs to a service started since: not the one seen working.
    ps = table(root, false, "00:30");
    expect(await credited(NOW + 124_000)).toEqual([]);
  });

  it("is let go when the action ends", async () => {
    const { dir, root } = derivedData();
    const bundle = testBundle(root, "Test-Amion-2026.11.11_08-43-16--1000.xcresult", false);
    let ps = table(root, true);
    const watch = new ProcessObserver({
      ps: async () => ps,
      cwdOf: async () => "/",
      gitOf: async () => null,
      actions: new DerivedDataActions(dir),
    });
    await watch.snapshot(NOW);
    ps = table(root, false);
    writeFileSync(join(bundle, "Info.plist"), "");
    expect(await watch.snapshot(NOW + 2_000)).toEqual([]);
    // Nor taken up again by a later bundle in that root it was not seen on.
    testBundle(root, "Test-Amion-2026.11.11_08-44-20--1000.xcresult", false);
    expect(await watch.snapshot(NOW + 6_000)).toEqual([]);
  });
});
