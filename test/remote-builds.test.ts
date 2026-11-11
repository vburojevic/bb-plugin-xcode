/**
 * Tracked builds for a thread whose checkout lives on another Mac.
 *
 * The whole server entry is loaded into the fake plugin host, and its host
 * RPC is answered by the real host entry through the SDK's host harness —
 * which runs the worker's `/bin/sh` wrapper over a fake xcodebuild. So these
 * cover the routing end to end: the server picks the Mac from the thread's
 * environment, the Mac validates and builds, and the verdict lands in the
 * same run table the live row, `xcode_status` and `bb xcode wait` read.
 *
 * The host signals are bridged by hand, so a test can drop them and prove the
 * reconcile path recovers on its own.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";

import { createHostEntry } from "../host";
import plugin from "../server";
import { createFakePluginHost, type Harness } from "./sim/fake-plugin-host";

const FAKE_XCODEBUILD = `#!/bin/sh
bundle=""; stream=""; scheme=""
while [ $# -gt 0 ]; do
  case "$1" in
    -resultBundlePath) bundle="$2"; shift ;;
    -resultStreamPath) stream="$2"; shift ;;
    -scheme) scheme="$2"; shift ;;
  esac
  shift
done
printf '%s\\n' '{"name":"logSectionCreated","structuredPayload":{"section":{"title":"Compile App"}}}' >> "$stream"
case "$scheme" in
  slow) sleep 30 ;;
  gated) while [ ! -f "$PWD/go" ]; do sleep 0.05; done ;;
esac
mkdir -p "$bundle"; touch "$bundle/Info.plist"
case "$scheme" in fail) touch "$bundle/failed"; exit 65 ;; esac
exit 0
`;

const MINI = { id: "host_mini", name: "MacMini" };
const MBP = { id: "host_mbp", name: "MacBook Pro" };
const THREAD = "thr_remote";
const PROJECT = "proj_app";

/**
 * What the worker's xcresulttool reports: a failing compile for a bundle the
 * fake `fail` build marked, a clean one otherwise.
 */
async function fakeXcresult(_tool: string, args: readonly string[]): Promise<unknown> {
  const bundle = args[args.indexOf("--path") + 1]!;
  const now = Date.now() / 1000;
  if (args[1] === "build-results" && !existsSync(join(bundle, "failed"))) {
    return { status: "succeeded", startTime: now - 1, endTime: now, errorCount: 0, warningCount: 0 };
  }
  if (args[1] === "build-results") {
    return {
      status: "failed",
      startTime: now - 1,
      endTime: now,
      errorCount: 1,
      warningCount: 0,
      analyzerCount: 0,
      errors: [
        {
          issueType: "Swift Compiler Error",
          message: "cannot find 'frobnicate' in scope",
          // 0-based, as Xcode writes it: line 41 to a person.
          sourceURL: "file:///w/App/Sources/App.swift#StartingLineNumber=40",
        },
      ],
    };
  }
  return null;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(options: { environmentHost?: string } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xcode-remote-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const checkout = join(base, "checkout");
  const hostData = join(base, "mbp-data");
  mkdirSync(checkout, { recursive: true });
  mkdirSync(hostData);
  const fake = join(base, "fake-xcodebuild");
  writeFileSync(fake, FAKE_XCODEBUILD);
  chmodSync(fake, 0o755);

  const mbp = experimental_createHostEntryHarness(
    createHostEntry({
      xcodebuildBinary: fake,
      pollMs: 20,
      progressIntervalMs: 0,
      livenessMs: 50,
      findTool: async () => "/usr/bin/xcresulttool",
      xcresult: fakeXcresult,
    }),
    { experimental_paths: { dataDir: hostData, tempDir: join(base, "mbp-temp") } },
  );
  cleanups.push(() => mbp.experimental_dispose());

  const approvals: unknown[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "xcode",
    hostRpc: async (call) => {
      if (call.hostId !== MBP.id) throw new Error(`host ${call.hostId} is offline`);
      return mbp.experimental_call(call.method as never, call.input as never);
    },
    requestInput: async (request) => {
      approvals.push(request);
      return { outcome: "submitted", value: true };
    },
    sdk: {
      subscribe: () => () => undefined,
      projects: { list: async () => [] },
      threads: {
        get: async () => ({ id: THREAD, environmentId: "env_remote", projectId: PROJECT }),
        events: { list: async () => ({ events: [] }) },
      },
      environments: {
        get: async () => ({
          path: checkout,
          hostId: options.environmentHost ?? MBP.id,
          branchName: "feature/remote",
          projectId: PROJECT,
        }),
      },
      hosts: { list: async () => [MINI, MBP] },
      system: { config: async () => ({ primaryHostId: MINI.id }) },
    },
  });
  cleanups.push(() => harness.cleanup());
  cleanups.push(() => harness.dispose());

  // The Simulators half registers only on a macOS server; this suite is
  // about the tracker, so load it as a Linux server would, everywhere.
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  try {
    await plugin(bb as never);
  } finally {
    Object.defineProperty(process, "platform", original);
  }

  // Signals from the Mac to the server, forwarded unless a test drops them.
  const bridge = { enabled: true, forwarded: 0 };
  const timer = setInterval(() => {
    const pending = mbp.experimental_getSignals().slice(bridge.forwarded);
    bridge.forwarded += pending.length;
    if (!bridge.enabled) return;
    for (const signal of pending) {
      void harness.emitHostSignal(MBP.id, signal.signal, signal.payload);
    }
  }, 10);
  cleanups.push(() => clearInterval(timer));

  return { harness, mbp, checkout, hostData, approvals, bridge, base };
}

function runRow(harness: Harness, id?: string) {
  const row = (
    id
      ? harness.db.prepare(`SELECT * FROM run WHERE id = ?`).get(id)
      : harness.db.prepare(`SELECT * FROM run ORDER BY started_at DESC LIMIT 1`).get()
  ) as Record<string, unknown> | undefined;
  return row ?? null;
}

async function until<T>(read: () => T | Promise<T>, timeoutMs = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const toolContext = () => ({ threadId: THREAD, signal: new AbortController().signal });

describe("xcode_build for a checkout on another Mac", () => {
  it("builds on that Mac and answers with its verdict", async () => {
    const { harness, hostData } = await setup();
    const answer = (await harness.callAgentTool(
      "xcode_build",
      { args: ["-scheme", "pass", "build"] },
      toolContext(),
    )) as string;

    expect(answer).toMatch(/^PASSED/m);
    expect(answer).toContain("on MacBook Pro");
    const methods = harness.hostRpcCalls.map((call) => `${call.hostId}:${call.method}`);
    expect(methods.slice(0, 2)).toEqual(["host_mbp:validateBuild", "host_mbp:startBuild"]);
    // Validated on the Mac with the thread's checkout as the boundary.
    expect(harness.hostRpcCalls[0]!.input).toMatchObject({ root: expect.stringContaining("checkout") });

    const row = runRow(harness)!;
    expect(row).toMatchObject({
      status: "passed",
      host_id: "host_mbp",
      thread_id: THREAD,
      project_id: PROJECT,
      branch: "feature/remote",
      scheme: "pass",
      kind: "build",
    });
    // The bundle is on the Mac's disk, under its own data dir.
    expect(String(row.bundle_path).startsWith(join(hostData, "builds"))).toBe(true);
  });

  it("returns the errors read from the bundle on that Mac", async () => {
    const { harness } = await setup();
    const answer = (await harness.callAgentTool(
      "xcode_build",
      { args: ["-scheme", "fail", "build"] },
      toolContext(),
    )) as string;
    expect(answer).toMatch(/^FAILED/m);
    expect(answer).toContain("cannot find 'frobnicate' in scope");
    expect(answer).toContain("App.swift:41");
    const row = runRow(harness)!;
    // The bundle's verdict (verified) superseded the exit code's (logged).
    expect(row).toMatchObject({ status: "failed", status_rank: 2, detailed: 1, error_count: 1 });
    expect(harness.hostRpcCalls.some((call) => call.method === "summarize")).toBe(true);
  });

  it("refuses with the Mac's own sentence when the checkout boundary is crossed", async () => {
    const { harness } = await setup();
    const answer = await harness.callAgentTool(
      "xcode_build",
      { args: ["-scheme", "pass", "-derivedDataPath", "/tmp/elsewhere", "build"] },
      toolContext(),
    );
    expect(answer).toBe("-derivedDataPath must stay inside this thread's checkout.");
    expect(harness.hostRpcCalls.map((call) => call.method)).toEqual(["validateBuild"]);
    expect(runRow(harness)).toBeNull();
  });

  it("says which Mac it could not reach", async () => {
    const { harness } = await setup({ environmentHost: "host_asleep" });
    const answer = await harness.callAgentTool(
      "xcode_build",
      { args: ["-scheme", "pass", "build"] },
      toolContext(),
    );
    expect(answer).toBe(
      "Could not reach host_asleep to run the build there: host host_asleep is offline",
    );
    expect(runRow(harness)).toBeNull();
  });
});

describe("bb xcode run / wait / stop for a checkout on another Mac", () => {
  it("names the machine on the confirmation, then tracks the run by id", async () => {
    const { harness, checkout, approvals } = await setup();
    const ctx = { threadId: THREAD, projectId: PROJECT, cwd: checkout };
    const started = await harness.runCli(["run", "--", "xcodebuild", "-scheme", "gated", "build"], ctx);
    expect(started.exitCode).toBe(0);
    const runId = /as (w:\S+)\./.exec(started.stdout ?? "")?.[1];
    expect(runId).toBeDefined();
    expect(started.stdout).toContain("Build started on MacBook Pro");

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      title: "Run xcodebuild on MacBook Pro?",
      payload: { facts: expect.arrayContaining(["Machine: MacBook Pro"]) },
    });

    const status = await harness.runCli(["status"], ctx);
    expect(status.stdout).toContain(runId);
    expect(status.stdout).toContain("on MacBook Pro");

    writeFileSync(join(checkout, "go"), "");
    const waited = await harness.runCli(["wait", runId!, "--timeout", "20"], ctx);
    expect(waited.exitCode).toBe(0);
    expect(waited.stdout).toContain("status       passed");
    expect(waited.stdout).toContain("machine      MacBook Pro");
  });

  it("stops the build on its Mac after a person confirms", async () => {
    const { harness, checkout, approvals } = await setup();
    const ctx = { threadId: THREAD, projectId: PROJECT, cwd: checkout };
    const started = await harness.runCli(["run", "--", "xcodebuild", "-scheme", "slow", "build"], ctx);
    const runId = /as (w:\S+)\./.exec(started.stdout ?? "")![1]!;

    const stopped = await harness.runCli(["stop", runId], ctx);
    expect(stopped.exitCode).toBe(0);
    expect(stopped.stdout).toContain("Sent SIGTERM");
    expect(approvals[1]).toMatchObject({ title: "Stop this Xcode build on MacBook Pro?" });
    expect(harness.hostRpcCalls.some((call) => call.method === "stop")).toBe(true);

    await until(() => runRow(harness, runId)?.status === "cancelled");
  });
});

describe("recovering what a dropped signal would have said", () => {
  it("folds the exit when a worker exit prompts a reconcile", async () => {
    const { harness, checkout, bridge } = await setup();
    const ctx = { threadId: THREAD, projectId: PROJECT, cwd: checkout };
    const started = await harness.runCli(["run", "--", "xcodebuild", "-scheme", "gated", "build"], ctx);
    const runId = /as (w:\S+)\./.exec(started.stdout ?? "")![1]!;

    // A reload on either side: nothing the worker says reaches the server.
    bridge.enabled = false;
    writeFileSync(join(checkout, "go"), "");
    await until(() => existsSync(join(String(runRow(harness, runId)!.bundle_path), "Info.plist")));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(runRow(harness, runId)!.status).toBe("running");

    await harness.emitHostWorkerExit(MBP.id);
    await until(() => runRow(harness, runId)?.status === "passed");
  });

  it("folds it from the background reconcile with no prompt at all", async () => {
    const { harness, checkout, bridge } = await setup();
    const ctx = { threadId: THREAD, projectId: PROJECT, cwd: checkout };
    const started = await harness.runCli(["run", "--", "xcodebuild", "-scheme", "fail", "build"], ctx);
    const runId = /as (w:\S+)\./.exec(started.stdout ?? "")![1]!;
    bridge.enabled = false;

    const service = harness.runService("remote-builds");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
    });
    await until(() => runRow(harness, runId)?.status === "failed");
    // And its bundle was read on the Mac, through the same reconcile.
    await until(() => runRow(harness, runId)?.detailed === 1);
  });
});

describe("xcode_status for a thread on another Mac", () => {
  it("names the Mac in its scope line", async () => {
    const { harness } = await setup();
    const answer = (await harness.callAgentTool("xcode_status", {}, toolContext())) as string;
    expect(answer).toMatch(/^Scope: this thread's checkout .* on MacBook Pro\.$/m);
  });
});
