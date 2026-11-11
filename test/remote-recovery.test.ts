/**
 * Builds on another Mac when the network is not kind.
 *
 * `RemoteBuilds` against a real store and engine, with its host calls going
 * through a switchable "network" to the real host entry (SDK host harness,
 * real wrapper, fake xcodebuild). The server's clock is a fake one, so a
 * night's sleep or a backoff window passes in a line; the Mac's is real.
 * Signals are deliberately not delivered: everything here must be recovered
 * by asking.
 */

import Database from "better-sqlite3";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";

import { createHostEntry } from "../host";
import { Engine, RUNNING_MAX_AGE_MS } from "../src/engine";
import {
  RemoteBuilds,
  UNCONFIRMED_START_GRACE_MS,
  type HostCaller,
  type RemoteTarget,
} from "../src/remote";
import type { ThreadScope } from "../src/scopes";
import { MIGRATIONS, Store, type Db } from "../src/store";
import { fakeXcresult, makeWorkspace, until } from "./support/fake-xcodebuild";

const MBP: RemoteTarget = { hostId: "host_mbp", machineName: "MacBook Pro" };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  const ws = makeWorkspace("xcode-recovery-");
  cleanups.push(() => ws.cleanup());
  const mbp = experimental_createHostEntryHarness(
    createHostEntry({
      xcodebuildBinary: ws.fake,
      pollMs: 20,
      progressIntervalMs: 0,
      livenessMs: 50,
      findTool: async () => "/usr/bin/xcresulttool",
      xcresult: fakeXcresult,
    }),
    { experimental_paths: { dataDir: ws.dataDir, tempDir: join(ws.base, "temp") } },
  );
  cleanups.push(async () => {
    // Never leave a gated build behind.
    ws.release();
    await mbp.experimental_dispose();
  });

  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  const store = new Store(db);
  const engine = new Engine(store, {
    projectFor: () => null,
    threadFor: () => null,
    log: () => undefined,
  });

  const clock = { now: Date.now() };
  const net = { offline: false, dropStartRequest: false, dropStartReply: false };
  const calls: string[] = [];
  const host = {
    call: async (method: string, input: unknown) => {
      calls.push(method);
      if (net.offline) throw new Error("host host_mbp is offline");
      if (method === "startBuild" && net.dropStartRequest) throw new Error("connection reset");
      const output = await mbp.experimental_call(method as never, input as never);
      if (method === "startBuild" && net.dropStartReply) throw new Error("connection reset");
      return output;
    },
  } as unknown as HostCaller;

  /** A server instance. A second one on the same store is a server restart. */
  const server = () =>
    new RemoteBuilds({
      store,
      engine,
      host,
      publishLive: () => undefined,
      publishSoon: () => undefined,
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
      isDisposed: () => false,
      now: () => clock.now,
    });

  const scope: ThreadScope = {
    threadId: "thr_mbp",
    projectId: "proj_app",
    environmentId: "env_mbp",
    path: ws.checkout,
    hostId: MBP.hostId,
    branch: "main",
    active: true,
    updatedAt: clock.now,
  };
  const request = (scheme: string) => ({
    argv: ["/usr/bin/xcodebuild", "-scheme", scheme, "build"],
    root: ws.checkout,
    workingDir: ws.checkout,
  });
  const buildDirs = () =>
    existsSync(join(ws.dataDir, "builds")) ? readdirSync(join(ws.dataDir, "builds")) : [];

  return { ws, mbp, store, engine, clock, net, calls, server, scope, request, buildDirs };
}

function runIdIn(message: string): string {
  const id = /tracked as (w:\S+);/.exec(message)?.[1];
  if (!id) throw new Error(`no run id in: ${message}`);
  return id;
}

describe("a start whose reply is lost", () => {
  it("is recorded before it is sent, and adopted from the Mac's record", async () => {
    const t = setup();
    t.net.dropStartReply = true;
    const first = t.server();
    const started = await first.start(MBP, t.request("gated"), t.scope);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.message).toContain("Could not confirm the build started on MacBook Pro");
    const runId = runIdIn(started.message);

    // The Mac did start it, and the server already knows it, attributed.
    expect(t.buildDirs()).toEqual([runId.slice(2)]);
    expect(t.store.getRun(runId)).toMatchObject({
      status: "running",
      threadId: "thr_mbp",
      hostId: "host_mbp",
      bundlePath: null,
    });

    // The server restarts before anything else happens.
    t.net.dropStartReply = false;
    const second = t.server();
    expect(second.hasWork()).toBe(true);
    await second.reconcile();
    const adopted = t.store.getRun(runId)!;
    expect(adopted.bundlePath).toBe(join(t.ws.dataDir, "builds", runId.slice(2), "result.xcresult"));
    expect(adopted.pid).toEqual(expect.any(Number));

    t.ws.release();
    await until(async () => {
      await second.reconcile();
      return t.store.getRun(runId)?.status === "passed";
    });
    expect(t.store.getRun(runId)?.detailed).toBe(true);
    // One build on the Mac, ever.
    expect(t.buildDirs()).toHaveLength(1);
  });

  it("writes off a start that never reached the Mac, after a grace", async () => {
    const t = setup();
    t.net.dropStartRequest = true;
    const remote = t.server();
    const started = await remote.start(MBP, t.request("pass"), t.scope);
    if (started.ok) throw new Error("expected an unconfirmed start");
    const runId = runIdIn(started.message);
    expect(t.buildDirs()).toEqual([]);

    // The Mac has not heard of it — yet. It might still be on the way.
    t.net.dropStartRequest = false;
    t.clock.now += 30_000;
    await remote.reconcile();
    expect(t.store.getRun(runId)?.status).toBe("running");

    t.clock.now += UNCONFIRMED_START_GRACE_MS;
    await remote.reconcile();
    expect(t.store.getRun(runId)?.status).toBe("ended");
    expect(remote.hasWork()).toBe(false);
  });

  it("leaves no run at all when the Mac refuses the start", async () => {
    const t = setup();
    const remote = t.server();
    const started = await remote.start(
      MBP,
      { ...t.request("pass"), argv: ["/usr/bin/xcodebuild", "-allowProvisioningUpdates"] },
      t.scope,
    );
    expect(started).toEqual({
      ok: false,
      message: "-allowProvisioningUpdates is not available through the tracked build runner.",
    });
    expect(t.store.listRuns({ limit: 10, includeNoise: true })).toEqual([]);
  });
});

describe("a Mac that cannot be reached", () => {
  it("recovers a build ended by the age cap while its laptop slept overnight", async () => {
    const t = setup();
    const remote = t.server();
    const started = await remote.start(MBP, t.request("gated"), t.scope);
    if (!started.ok) throw new Error(started.message);

    // The lid closes. Nothing is heard from that Mac all night.
    t.net.offline = true;
    t.clock.now += RUNNING_MAX_AGE_MS + 60_000;
    const cappedAt = t.clock.now;
    t.engine.expireFinishing(t.clock.now);
    expect(t.store.getRun(started.runId)).toMatchObject({ status: "ended", endedAt: cappedAt });

    // Asked, and asked again, as the backoff allows: never taken as an answer.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      t.clock.now += 20 * 60_000;
      await remote.reconcile();
    }
    expect(t.store.getRun(started.runId)?.status).toBe("ended");
    expect(t.store.hasSeen(`bundle-scanned:${started.bundlePath}`)).toBe(false);
    expect(remote.hasWork()).toBe(true);

    // Morning: the build had finished in the night; the Mac is back.
    t.ws.release();
    await until(() => existsSync(join(t.ws.dataDir, "builds", started.runId.slice(2), "exit")));
    t.net.offline = false;
    t.clock.now += 20 * 60_000;
    await remote.reconcile();

    const run = t.store.getRun(started.runId)!;
    expect(run).toMatchObject({ status: "passed", detailed: true });
    // The Mac's end time, not the cap's.
    expect(run.endedAt).toBeLessThan(cappedAt);
    expect(remote.hasWork()).toBe(false);
  });

  it("keeps a bundle queued through an outage right after the exit", async () => {
    const t = setup();
    const remote = t.server();
    const started = await remote.start(MBP, t.request("fail"), t.scope);
    if (!started.ok) throw new Error(started.message);
    const exited = await until(() =>
      t.mbp
        .experimental_getSignals()
        .find((signal) => signal.signal === "exited" && signal.payload.state.buildId === started.runId.slice(2)),
    );

    // The exit signal arrives; the connection drops before the summary.
    t.net.offline = true;
    if (exited.signal !== "exited") return;
    remote.onExited({ hostId: MBP.hostId, payload: exited.payload });
    await until(() => t.store.getRun(started.runId)?.status === "failed");
    // More failures than the old retry budget allowed.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      t.clock.now += 20 * 60_000;
      await remote.reconcile();
    }
    expect(t.store.getRun(started.runId)?.detailed).toBe(false);
    expect(t.store.hasSeen(`bundle-scanned:${started.bundlePath}`)).toBe(false);

    t.net.offline = false;
    t.clock.now += 20 * 60_000;
    await remote.reconcile();
    expect(t.store.getRun(started.runId)).toMatchObject({ detailed: true, errorCount: 1 });
    expect(t.store.listFindings(started.runId).map((finding) => finding.message)).toEqual([
      "cannot find 'frobnicate' in scope",
    ]);
  });

  it("backs off instead of asking a dead Mac every few seconds", async () => {
    const t = setup();
    const remote = t.server();
    const started = await remote.start(MBP, t.request("gated"), t.scope);
    if (!started.ok) throw new Error(started.message);
    t.net.offline = true;
    t.calls.length = 0;
    for (let tick = 0; tick < 20; tick += 1) {
      t.clock.now += 3_000; // the reconcile service's cadence
      await remote.reconcile();
    }
    // 60 s of ticks: attempts at 0, +5, +10(+), +20(+), +40(+)… not twenty.
    expect(t.calls.length).toBeLessThanOrEqual(5);
    expect(t.calls.length).toBeGreaterThan(0);
    // A worker exit says the Mac is up: ask at once.
    t.net.offline = false;
    remote.onWorkerExit(MBP.hostId);
    t.calls.length = 0;
    await remote.reconcile();
    expect(t.calls).toContain("buildStates");
  });
});

describe("the cleanup inventory", () => {
  it("still cleans a Mac whose last run aged out of history while it was offline", async () => {
    const t = setup();
    const remote = t.server();
    const started = await remote.start(MBP, t.request("pass"), t.scope);
    if (!started.ok) throw new Error(started.message);
    await until(async () => {
      await remote.reconcile();
      return t.store.getRun(started.runId)?.status === "passed";
    });
    expect(t.store.listCleanupHosts()).toEqual(["host_mbp"]);
    // Prune spares a build its worker is still watching; let it finish.
    await until(() =>
      t.mbp.experimental_getSignals().some((signal) => signal.signal === "exited"),
    );
    const retention = { maxAgeMs: 0, maxTotalBytes: 0 };

    // Offline at prune time, then history retention drops its last run.
    t.net.offline = true;
    expect(await remote.prune(retention)).toBe(0);
    t.store.prune(Date.now() + 86_400_000);
    expect(t.store.listRemoteHostIds()).toEqual([]);
    expect(t.store.listCleanupHosts()).toEqual(["host_mbp"]);
    expect(t.buildDirs()).toHaveLength(1);

    // Back online: the bundle is cleaned, and the Mac leaves the inventory.
    t.net.offline = false;
    expect(await remote.prune(retention)).toBe(1);
    expect(t.buildDirs()).toEqual([]);
    expect(t.store.listCleanupHosts()).toEqual([]);
  });

  it("keeps a Mac that still holds builds", async () => {
    const t = setup();
    const remote = t.server();
    const started = await remote.start(MBP, t.request("gated"), t.scope);
    if (!started.ok) throw new Error(started.message);
    await remote.prune({ maxAgeMs: 0, maxTotalBytes: 0 });
    expect(t.store.listCleanupHosts()).toEqual(["host_mbp"]);
    rmSync(join(t.ws.checkout, "go"), { force: true });
  });
});
