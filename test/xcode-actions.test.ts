/**
 * Xcode.app's actions, read from DerivedData, and what the engine makes of
 * them: the evidence that keeps a build service's run alive and attributed
 * while the service has no children to show for it.
 */

import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { Engine, MISSES_BEFORE_FINISHING, observedRunId } from "../src/engine";
import { ProcessObserver } from "../src/observe";
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
});
