/**
 * A killed build must never rest at the verdict-less "ended".
 *
 * xcodebuild finalizes its result bundle (writing the root `Info.plist`) on
 * every normal exit, including failures — verified on disk. So a run whose
 * process is gone while its declared bundle has no Info.plist was killed or
 * crashed, and "cancelled" is the honest verdict.
 */

import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { Collector } from "../src/collector";
import { Engine } from "../src/engine";
import { RANK, type Run } from "../src/model";
import { MIGRATIONS, Store, type Db } from "../src/store";

const scratch: string[] = [];
afterAll(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xc-abandoned-"));
  scratch.push(dir);
  return dir;
}

/**
 * `findTool: null` on purpose. Detecting an abandoned bundle reads one
 * `Info.plist` off disk and needs no toolchain — but it used to sit behind an
 * `xcresulttool` gate at the top of `sweepBundles`, so a machine with no Xcode
 * selected silently lost the rescue entirely. Pinning the tool to absent here
 * is what keeps that gate from coming back, and is why this file runs in CI.
 */
function harness(): { store: Store; engine: Engine; collector: Collector } {
  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  const store = new Store(db);
  const engine = new Engine(store, {
    projectFor: () => null,
    threadFor: () => null,
    log: () => undefined,
  });
  const collector = new Collector(
    {
      store,
      engine,
      listProjects: async () => [],
      log: { debug: () => undefined, warn: () => undefined },
      dataDir: join(tmpdir(), "xc-abandoned-datadir"),
      findTool: async () => null,
    },
    { scanProjects: false, extraRoots: [] },
  );
  return { store, engine, collector };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "r:1:1",
    status: "finishing",
    statusRank: RANK.observed,
    kind: "build",
    scheme: "Demo",
    container: null,
    configuration: null,
    destination: null,
    projectId: null,
    root: null,
    cwd: null,
    pid: 1,
    cmdline: null,
    startedAt: 1_000_000,
    endedAt: 1_060_000,
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

describe("abandoned bundles", () => {
  it("resolves a dead run with an unfinalized bundle to cancelled", async () => {
    const dir = await workspace();
    const bundle = join(dir, "result.xcresult");
    await mkdir(join(bundle, "Data"), { recursive: true }); // no Info.plist

    const { store, collector } = harness();
    store.insertRun(run({ bundlePath: bundle, status: "finishing" }));

    await collector.sweepBundles(1_060_000 + 25_000);
    expect(store.getRun("r:1:1")?.status).toBe("cancelled");
  });

  it("also rescues a run that already expired into ended", async () => {
    const dir = await workspace();
    const bundle = join(dir, "result.xcresult");
    await mkdir(join(bundle, "Data"), { recursive: true });

    const { store, collector } = harness();
    store.insertRun(run({ bundlePath: bundle, status: "ended" }));

    await collector.sweepBundles(1_060_000 + 25_000);
    expect(store.getRun("r:1:1")?.status).toBe("cancelled");
  });

  it("leaves a still-writing bundle alone during the grace window", async () => {
    const dir = await workspace();
    const bundle = join(dir, "result.xcresult");
    await mkdir(join(bundle, "Data"), { recursive: true });

    const { store, collector } = harness();
    store.insertRun(run({ bundlePath: bundle, status: "finishing" }));

    await collector.sweepBundles(1_060_000 + 5_000);
    expect(store.getRun("r:1:1")?.status).toBe("finishing");
  });

  it("never touches a run whose process is still alive", async () => {
    const dir = await workspace();
    const bundle = join(dir, "result.xcresult");
    await mkdir(join(bundle, "Data"), { recursive: true });

    const { store, collector } = harness();
    store.insertRun(
      run({ bundlePath: bundle, status: "running", endedAt: null }),
    );

    await collector.sweepBundles(1_060_000 + 600_000);
    expect(store.getRun("r:1:1")?.status).toBe("running");
  });

  it("leaves a finalized bundle to the normal parse path", async () => {
    const dir = await workspace();
    const bundle = join(dir, "result.xcresult");
    await mkdir(join(bundle, "Data"), { recursive: true });
    await writeFile(join(bundle, "Info.plist"), "<plist/>");

    const { store, collector } = harness();
    store.insertRun(run({ bundlePath: bundle, status: "finishing" }));

    await collector.sweepBundles(1_060_000 + 25_000);
    // Not cancelled: a finalized bundle is parsed, and an unparseable one
    // stays pending rather than being declared killed.
    expect(store.getRun("r:1:1")?.status).not.toBe("cancelled");
  });
});
