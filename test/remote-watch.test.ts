/**
 * An Xcode.app build on another Mac, from the process table to the thread.
 *
 * The case this exists for: a thread whose checkout is on a MacBook builds
 * and tests through Xcode's own agent tools (`BuildProject`, `RunSomeTests`),
 * which build inside Xcode.app there. No tool call of this plugin is
 * involved; the only evidence is on the MacBook — its build service and
 * compilers in `ps`, its DerivedData log store and test bundles.
 *
 * `RemoteWatch` against a real store and engine, its host calls answered by
 * the real host entry (SDK host harness) over a temp DerivedData, with the
 * MacBook's `ps` scripted. Then the whole server in the fake plugin host, for
 * the wiring the live row actually reads.
 */

import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";

import { createHostEntry } from "../host";
import plugin from "../server";
import { Engine } from "../src/engine";
import type { HostCaller } from "../src/remote";
import { RemoteWatch } from "../src/remote-watch";
import { runMatchesScope, ThreadScopes, type ThreadScope } from "../src/scopes";
import { MIGRATIONS, Store, type Db } from "../src/store";
import { makeDerivedRoot, makeTestBundle, writeBuildManifest, xcodeAppPs } from "./support/derived-data";
import { fakeXcresult, until } from "./support/fake-xcodebuild";
import { createFakePluginHost } from "./sim/fake-plugin-host";

const MINI = { id: "host_mini", name: "MacMini" };
const MBP = { id: "host_mbp", name: "MacBook Pro" };
const THREAD = "thr_amion";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The MacBook: a home with DerivedData, a checkout, and a scripted `ps`. */
function macBook() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xcode-remote-watch-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const derivedData = join(base, "Library/Developer/Xcode/DerivedData");
  const checkout = join(base, "Development/ios-amion-v2");
  const workspace = join(checkout, "Amion.xcworkspace");
  mkdirSync(workspace, { recursive: true });
  const root = makeDerivedRoot(join(derivedData, "Amion-bkfmqyxwjbnhmfahbwgcrtlvkhzo"), { workspace });
  const machine = { ps: xcodeAppPs({ servicePid: 812 }), offline: false };
  const worker = experimental_createHostEntryHarness(
    createHostEntry({
      findTool: async () => "/usr/bin/xcresulttool",
      xcresult: fakeXcresult,
      watch: {
        derivedDataDir: derivedData,
        observer: { ps: async () => machine.ps, cwdOf: async () => "/" },
      },
    }),
    { experimental_paths: { dataDir: join(base, "host-data"), tempDir: join(base, "temp") } },
  );
  cleanups.push(() => worker.experimental_dispose());
  return { base, derivedData, checkout, workspace, root, machine, worker };
}

function watcher(mac: ReturnType<typeof macBook>) {
  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  const store = new Store(db);
  const scopes = new ThreadScopes();
  const engine = new Engine(store, {
    projectFor: () => null,
    threadFor: (signals, hostId) => scopes.threadFor(signals, hostId),
    log: () => undefined,
  });
  const calls: string[] = [];
  const host = {
    call: async (method: string, input: unknown, options: { hostId: string }) => {
      calls.push(method);
      if (options.hostId !== MBP.id || mac.machine.offline) {
        throw new Error(`host ${options.hostId} is offline`);
      }
      return mac.worker.experimental_call(method as never, input as never);
    },
  } as unknown as HostCaller;
  const watch = new RemoteWatch({
    store,
    engine,
    host,
    scopeHosts: (now) => scopes.watchedHosts(now),
    scopePaths: (hostId) => scopes.pathsOn(hostId),
    optInHosts: () => [],
    serverHostId: () => MINI.id,
    projects: () => [],
    settings: () => ({ scanIntervalMs: 20, scanProjects: true, retentionDays: 30 }),
    publishSoon: () => undefined,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    isDisposed: () => false,
    timing: { sweepPendingMs: 50, sweepIdleMs: 50, failureBaseMs: 20 },
  });
  const controller = new AbortController();
  cleanups.push(async () => {
    controller.abort();
    await watch.stop();
  });
  const scope: ThreadScope = {
    threadId: THREAD,
    projectId: null,
    environmentId: "env_amion",
    path: mac.checkout,
    hostId: MBP.id,
    branch: null,
    active: true,
    updatedAt: Date.now(),
  };
  return { store, scopes, scope, watch, calls, signal: controller.signal };
}

const onlyRun = (store: Store) => store.listRuns({ limit: 10, includeNoise: true });

describe("an Xcode.app build on the thread's Mac", () => {
  it("shows live on the thread, then takes its verdict from that Mac's log store", async () => {
    const mac = macBook();
    const { store, scopes, scope, watch, signal } = watcher(mac);
    scopes.upsert(scope, Date.now());
    watch.reconcile(signal);
    expect(watch.hosts()).toEqual([MBP.id]);

    // BuildProject: Xcode.app's build service picks up work.
    mac.machine.ps = xcodeAppPs({ servicePid: 812, root: mac.root, workers: 3 });
    const live = await until(() => store.listUnresolved()[0]);
    expect(live).toMatchObject({
      status: "running",
      hostId: MBP.id,
      threadId: THREAD,
      container: mac.workspace,
      root: mac.root,
      pid: 812,
    });
    // What the live row reads for phase, worker count and file.
    expect(watch.activitiesOn(MBP.id)[0]).toMatchObject({ phase: "compiling", workerCount: 3 });
    expect(runMatchesScope(live, scope)).toBe(true);

    // The build ends: the service goes quiet, Xcode writes its log entry.
    const startedAt = live.startedAt;
    mac.machine.ps = xcodeAppPs({ servicePid: 812 });
    await until(() => store.getRun(live.id)?.status === "finishing");
    writeBuildManifest(mac.root, [
      {
        id: "8D2C0E7A-5B1F-4F6B-9E77-2C1D3B4A5F60",
        title: "Building workspace Amion with scheme Amion",
        startedAt: startedAt - 500,
        endedAt: Date.now(),
        status: "E",
        errors: 2,
      },
    ]);
    const settled = await until(() => {
      const row = store.getRun(live.id);
      return row?.status === "failed" ? row : null;
    });
    expect(settled).toMatchObject({ errorCount: 2, scheme: "Amion", threadId: THREAD, hostId: MBP.id });
    // One build, one row: the log entry enriched the live run.
    expect(onlyRun(store).map((row) => row.id)).toEqual([live.id]);
  });

  it("reads a RunSomeTests bundle from that Mac's DerivedData", async () => {
    const mac = macBook();
    const { store, scopes, scope, watch, signal } = watcher(mac);
    scopes.upsert(scope, Date.now());
    watch.reconcile(signal);
    mac.machine.ps = xcodeAppPs({ servicePid: 812, root: mac.root, workers: 1 });
    const live = await until(() => store.listUnresolved()[0]);
    // The normal order: Xcode finalizes the bundle while the probe still sees
    // the build, so the sweep reads it before the run has ended.
    makeTestBundle(mac.root, "Test-Amion-2026.11.11_12-00-00-+0000");
    await until(() => store.getRun(live.id)?.detailed);
    expect(store.getRun(live.id)?.status).toBe("running");
    mac.machine.ps = xcodeAppPs({ servicePid: 812 });
    const settled = await until(() => {
      const row = store.getRun(live.id);
      return row?.status === "passed" ? row : null;
    });
    expect(settled).toMatchObject({ status: "passed", statusRank: 2, hostId: MBP.id, threadId: THREAD });
  });

  it("keeps a build running while its Mac cannot be reached, and ends it once it answers", async () => {
    const mac = macBook();
    const { store, scopes, scope, watch, signal, calls } = watcher(mac);
    scopes.upsert(scope, Date.now());
    watch.reconcile(signal);
    mac.machine.ps = xcodeAppPs({ servicePid: 812, root: mac.root, workers: 1 });
    const live = await until(() => store.listUnresolved()[0]);

    mac.machine.offline = true;
    const asked = calls.length;
    await until(() => calls.length > asked + 3);
    // No answer is not "no builds".
    expect(store.getRun(live.id)?.status).toBe("running");

    mac.machine.offline = false;
    mac.machine.ps = xcodeAppPs({ servicePid: 812 });
    await until(() => store.getRun(live.id)?.status === "finishing", 15_000);
  }, 20_000);

  it("stops watching a Mac once no thread there is recent and nothing is open", async () => {
    const mac = macBook();
    const { store, scopes, scope, watch, signal } = watcher(mac);
    scopes.upsert(scope, Date.now());
    watch.reconcile(signal);
    mac.machine.ps = xcodeAppPs({ servicePid: 812, root: mac.root, workers: 1 });
    const live = await until(() => store.listUnresolved()[0]);

    // The thread goes away while the build is still running: keep watching.
    scopes.remove(THREAD);
    watch.reconcile(signal);
    expect(watch.hosts()).toEqual([MBP.id]);

    mac.machine.ps = xcodeAppPs({ servicePid: 812 });
    await until(() => store.getRun(live.id)?.status === "finishing");
    store.updateRun({ ...store.getRun(live.id)!, status: "ended" });
    watch.reconcile(signal);
    expect(watch.hosts()).toEqual([]);
    expect(watch.activitiesOn(MBP.id)).toEqual([]);
  });

  it("never files a build on that Mac under a thread on this one", async () => {
    const mac = macBook();
    const { store, scopes, scope, watch, signal } = watcher(mac);
    scopes.upsert(scope, Date.now());
    // Same checkout path, on the server.
    scopes.upsert({ ...scope, threadId: "thr_local", hostId: null }, Date.now());
    watch.reconcile(signal);
    mac.machine.ps = xcodeAppPs({ servicePid: 812, root: mac.root, workers: 1 });
    const live = await until(() => store.listUnresolved()[0]);
    expect(live.threadId).toBe(THREAD);
    expect(runMatchesScope(live, { ...scope, threadId: "thr_local", hostId: null })).toBe(false);
  });
});

describe("the live row, end to end", () => {
  it("shows the thread's Xcode.app build on its Mac, and will not stop it from here", async () => {
    const mac = macBook();
    const { bb, harness } = createFakePluginHost({
      pluginId: "xcode",
      settings: { scanIntervalSeconds: "1" },
      hostRpc: async (call) => {
        if (call.hostId !== MBP.id) throw new Error(`host ${call.hostId} is offline`);
        return mac.worker.experimental_call(call.method as never, call.input as never);
      },
      sdk: {
        subscribe: () => () => undefined,
        projects: { list: async () => [] },
        threads: {
          get: async () => ({ id: THREAD, environmentId: "env_amion" }),
          events: { list: async () => ({ events: [] }) },
        },
        environments: {
          get: async () => ({ path: mac.checkout, hostId: MBP.id, branchName: "main" }),
        },
        hosts: { list: async () => [MINI, MBP] },
        system: { config: async () => ({ primaryHostId: MINI.id }) },
      },
    });
    cleanups.push(() => harness.cleanup());
    cleanups.push(() => harness.dispose());
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      await plugin(bb as never);
    } finally {
      Object.defineProperty(process, "platform", original);
    }

    mac.machine.ps = xcodeAppPs({ servicePid: 812, root: mac.root, workers: 2 });
    harness.emitThreadEvent("thread.active", { thread: { id: THREAD } });
    const service = harness.runService("remote-watch");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
    });

    type Status = { run: { id: string; status: string; hostId: string | null; hostName: string | null; phase: string | null; workerCount: number | null; threadId: string | null } | null };
    const status = await until(async () => {
      const answer = (await harness.callRpc("chatStatus", { threadId: THREAD })) as Status;
      return answer.run?.status === "running" ? answer : null;
    }, 15_000);
    expect(status.run).toMatchObject({
      hostId: MBP.id,
      hostName: "MacBook Pro",
      threadId: THREAD,
      phase: "compiling",
      workerCount: 2,
    });
    expect(harness.hostRpcCalls.map((call) => call.method)).toContain("probe");

    const stop = await harness.runCli(["stop", status.run!.id], { threadId: THREAD, cwd: mac.checkout });
    expect(stop.exitCode).toBe(1);
    expect(stop.stderr).toContain("only watches on MacBook Pro");
  }, 20_000);
});

describe("RunAllTests through Xcode's agent tools, as it was reported", () => {
  const SERVICE =
    "/Applications/Xcode-27.2.0.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService";
  const ps = (lines: string[] = []) =>
    [
      `    1     0 10-00:00:00 /sbin/launchd`,
      `  700     1 02:00:00 /Applications/Xcode-27.2.0.app/Contents/MacOS/Xcode`,
      `11699   700 01:30:00 ${SERVICE}`,
      ...lines,
      "",
    ].join("\n");
  /** Xcode's own bundle name: local time, with its offset. */
  const bundleName = (at: number) => {
    const d = new Date(at);
    const two = (n: number) => String(n).padStart(2, "0");
    return `Test-Amion-${d.getUTCFullYear()}.${two(d.getUTCMonth() + 1)}.${two(d.getUTCDate())}_${two(d.getUTCHours())}-${two(d.getUTCMinutes())}-${two(d.getUTCSeconds())}-+0000.xcresult`;
  };

  it("is one run on the thread from its first seconds, through quiet stretches and a blip, to its verdict", async () => {
    const mac = macBook();
    const { store, scopes, scope, watch, signal } = watcher(mac);
    scopes.upsert(scope, Date.now());
    watch.reconcile(signal);

    // RunAllTests begins: Xcode names the test bundle before anything runs.
    // The service has no children yet, and its first ones (explicit module
    // builds) name no DerivedData root of this workspace.
    const began = Math.floor(Date.now() / 1000) * 1000 - 2_000;
    const bundle = join(mac.root, "Logs", "Test", bundleName(began));
    mkdirSync(join(bundle, "Data"), { recursive: true });
    mac.machine.ps = ps();
    const live = await until(() => store.listUnresolved()[0]);
    expect(live).toMatchObject({
      hostId: MBP.id,
      pid: 11699,
      threadId: THREAD,
      container: mac.workspace,
      root: mac.root,
      kind: "test",
      bundlePath: bundle,
      startedAt: began,
    });

    const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
    mac.machine.ps = ps([
      `20001 11699 00:03 /Applications/Xcode-27.2.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -emit-pcm -o ${mac.derivedData}/SDKExplicitPrecompiledModules/Foundation.pcm`,
    ]);
    await pause();
    // "Host is not connected" for a while: nothing is concluded from silence.
    mac.machine.offline = true;
    await pause();
    mac.machine.offline = false;
    mac.machine.ps = xcodeAppPs({ servicePid: 11699, root: mac.root, workers: 2 }).replace(
      /\/Applications\/Xcode\.app\/Contents\/SharedFrameworks\/SwiftBuild\.framework\/Versions\/A\/PlugIns\/SWBBuildService\.bundle\/Contents\/MacOS\/SWBBuildService/,
      SERVICE,
    );
    await pause();
    // The tests run in the simulator, not under the service: minutes with no
    // children at all, which used to end the run within seconds.
    mac.machine.ps = ps();
    await pause();
    expect(store.getRun(live.id)?.status).toBe("running");
    expect(store.listRuns({ limit: 10, includeNoise: true }).map((row) => row.id)).toEqual([live.id]);

    // The action ends: Xcode finalizes its bundle.
    writeFileSync(join(bundle, "Info.plist"), "");
    const settled = await until(() => {
      const row = store.getRun(live.id);
      return row?.status === "passed" ? row : null;
    });
    expect(settled).toMatchObject({ statusRank: 2, threadId: THREAD, bundlePath: bundle });
    expect(store.listRuns({ limit: 10, includeNoise: true }).map((row) => row.id)).toEqual([live.id]);
  });
});
