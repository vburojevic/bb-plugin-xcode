/**
 * The host worker: tracked builds on the Mac a thread's checkout lives on.
 *
 * Driven through the SDK's own host-entry harness, which applies the real
 * contract schemas and JSON round-trips. The build itself is real: the
 * worker's `/bin/sh` wrapper runs a fake `xcodebuild` script that writes a
 * result stream and a bundle and exits as its `-scheme` says. That keeps the
 * suite runnable on the Linux CI runner — nothing here needs Xcode — while
 * the exit-status file, the process group and the pid + start-time identity
 * are the genuine article.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostEntry } from "../host";
import {
  HostBuilds,
  LOST_AFTER_MISSES,
  decodeExitStatus,
  type BuildRecord,
  type WorkerHooks,
} from "../src/host/builds";
import type { BuildState } from "../src/host/contract";
import { isSameProcess, parseElapsedSeconds, parseIdentity } from "../src/host/identity";

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
printf '%s\\n' '{"name":"invocationStarted","structuredPayload":{}}' >> "$stream"
printf '%s\\n' '{"name":"logSectionCreated","structuredPayload":{"section":{"title":"Compile App"}}}' >> "$stream"
case "$scheme" in
  slow) sleep 30 ;;
  gated) while [ ! -f "$PWD/go" ]; do sleep 0.05; done ;;
esac
case "$scheme" in
  fail) printf '%s\\n' '{"name":"issueEmitted","structuredPayload":{"severity":"error"}}' >> "$stream" ;;
esac
echo "fake xcodebuild done" >&2
mkdir -p "$bundle"
touch "$bundle/Info.plist"
case "$scheme" in
  fail) exit 65 ;;
esac
exit 0
`;

const dirs: string[] = [];
const harnesses: Array<{ experimental_dispose(): Promise<void> }> = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.experimental_dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xcode-host-")));
  dirs.push(base);
  const checkout = join(base, "checkout");
  const dataDir = join(base, "data");
  mkdirSync(join(checkout, "App"), { recursive: true });
  mkdirSync(dataDir);
  const fake = join(base, "fake-xcodebuild");
  writeFileSync(fake, FAKE_XCODEBUILD);
  chmodSync(fake, 0o755);
  return { base, checkout, dataDir, fake };
}

function harnessFor(ws: ReturnType<typeof workspace>, extra: Parameters<typeof createHostEntry>[0] = {}) {
  const harness = experimental_createHostEntryHarness(
    createHostEntry({
      xcodebuildBinary: ws.fake,
      pollMs: 20,
      progressIntervalMs: 0,
      livenessMs: 50,
      ...extra,
    }),
    { experimental_paths: { dataDir: ws.dataDir, tempDir: join(ws.base, "temp") } },
  );
  harnesses.push(harness);
  return harness;
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

type Harness = ReturnType<typeof harnessFor>;

function exitedSignal(harness: Harness, buildId: string): BuildState | undefined {
  for (const signal of harness.experimental_getSignals()) {
    if (signal.signal === "exited" && signal.payload.state.buildId === buildId) {
      return signal.payload.state;
    }
  }
  return undefined;
}

async function start(harness: Harness, checkout: string, scheme: string) {
  const started = await harness.experimental_call("startBuild", {
    argv: ["/usr/bin/xcodebuild", "-scheme", scheme, "build"],
    root: checkout,
  });
  if (!started.ok) throw new Error(started.message);
  return started;
}

describe("the host worker's checkout boundary", () => {
  it("validates against the host's own disk, refusing paths outside the checkout", async () => {
    const ws = workspace();
    const harness = harnessFor(ws);

    const fine = await harness.experimental_call("validateBuild", {
      argv: ["/usr/bin/xcodebuild", "-scheme", "App", "build"],
      root: ws.checkout,
      cwd: "App",
    });
    expect(fine).toEqual({ ok: true, workingDir: join(ws.checkout, "App") });

    const escaped = await harness.experimental_call("validateBuild", {
      argv: ["/usr/bin/xcodebuild", "-derivedDataPath", "../../elsewhere", "build"],
      root: ws.checkout,
    });
    expect(escaped).toEqual({ ok: false, message: "-derivedDataPath must stay inside this thread's checkout." });

    const outside = await harness.experimental_call("validateBuild", {
      argv: ["/usr/bin/xcodebuild", "build"],
      root: ws.checkout,
      cwd: ws.base,
    });
    expect(outside.ok).toBe(false);

    const mutating = await harness.experimental_call("startBuild", {
      argv: ["/usr/bin/xcodebuild", "-allowProvisioningUpdates", "build"],
      root: ws.checkout,
    });
    expect(mutating).toEqual({
      ok: false,
      message: "-allowProvisioningUpdates is not available through the tracked build runner.",
    });

    const notXcode = await harness.experimental_call("startBuild", {
      argv: ["/bin/rm", "-rf", "/"],
      root: ws.checkout,
    });
    expect(notXcode.ok).toBe(false);
    expect(existsSync(join(ws.dataDir, "builds"))).toBe(false);
  });

  it("follows a symlink in the checkout to where it really points", async () => {
    const ws = workspace();
    const harness = harnessFor(ws);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(ws.base, join(ws.checkout, "escape"));
    const result = await harness.experimental_call("validateBuild", {
      argv: ["/usr/bin/xcodebuild", "build"],
      root: ws.checkout,
      cwd: "escape",
    });
    expect(result).toEqual({
      ok: false,
      message: "The build working directory must stay inside this thread's checkout.",
    });
  });
});

describe("a tracked build on the host", () => {
  it("runs detached, reports progress, and captures the exit status from the wrapper", async () => {
    const ws = workspace();
    const harness = harnessFor(ws);

    const started = await start(harness, ws.checkout, "pass");
    expect(started.bundlePath).toBe(join(ws.dataDir, "builds", started.buildId, "result.xcresult"));
    expect(started.argv).toEqual([
      "/usr/bin/xcodebuild",
      "-scheme",
      "pass",
      "build",
      "-resultBundlePath",
      started.bundlePath,
      "-resultStreamPath",
      join(ws.dataDir, "builds", started.buildId, "stream.ndjson"),
    ]);

    const exited = await until(() => exitedSignal(harness, started.buildId));
    expect(exited).toMatchObject({
      status: "exited",
      exitCode: 0,
      signal: null,
      progress: { section: "Compile App", opened: 1, errors: 0 },
    });
    expect(exited.stderrTail).toContain("fake xcodebuild done");
    expect(exited.endedAt).toEqual(expect.any(Number));
    // Progress went out as signals before the exit did.
    expect(
      harness
        .experimental_getSignals()
        .some((signal) => signal.signal === "progress" && signal.payload.buildId === started.buildId),
    ).toBe(true);
    // The worker held a lease while watching, and let go of it at the end.
    await until(() => harness.experimental_getRetainedWorkerLeaseCount() === 0);

    const { states } = await harness.experimental_call("buildStates", { buildIds: [started.buildId] });
    expect(states[0]).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("reports a failing build's exit code and live error count", async () => {
    const ws = workspace();
    const harness = harnessFor(ws);
    const started = await start(harness, ws.checkout, "fail");
    const exited = await until(() => exitedSignal(harness, started.buildId));
    expect(exited).toMatchObject({ exitCode: 65, signal: null, progress: { errors: 1 } });
  });

  it("stops a build through the wrapper, which still records how it ended", async () => {
    const ws = workspace();
    const harness = harnessFor(ws);
    const started = await start(harness, ws.checkout, "slow");

    const stopped = await harness.experimental_call("stop", { buildId: started.buildId });
    expect(stopped.stopped).toBe(true);
    const exited = await until(() => exitedSignal(harness, started.buildId));
    expect(exited).toMatchObject({ status: "exited", exitCode: null, signal: "SIGTERM" });

    const again = await harness.experimental_call("stop", { buildId: started.buildId });
    expect(again).toEqual({ stopped: false, message: `Build ${started.buildId} has already finished.` });
  });

  it("answers for a build it never heard of without inventing one", async () => {
    const ws = workspace();
    const harness = harnessFor(ws);
    const buildId = "zz1-0123456789ab";
    const { states } = await harness.experimental_call("buildStates", { buildIds: [buildId] });
    expect(states[0]).toMatchObject({ buildId, status: "unknown" });
    expect(await harness.experimental_call("summarize", { buildId })).toEqual({
      status: "unavailable",
      reason: "No such build on this Mac.",
    });
    expect(await harness.experimental_call("stop", { buildId })).toEqual({
      stopped: false,
      message: "No such build on this Mac.",
    });
  });
});

describe("a worker restart mid-build", () => {
  it("re-adopts the build from its record and still captures its exit", async () => {
    const ws = workspace();
    const first = harnessFor(ws);
    const started = await start(first, ws.checkout, "gated");
    await until(async () => {
      const { states } = await first.experimental_call("buildStates", { buildIds: [started.buildId] });
      return states[0]?.progress.section === "Compile App";
    });

    // A reload / idle stop: the worker goes away, the build must not.
    await first.experimental_dispose();
    expect(first.experimental_getRetainedWorkerLeaseCount()).toBe(0);

    // A fresh worker, same data dir, no memory of the build.
    const second = harnessFor(ws);
    const { states } = await second.experimental_call("buildStates", { buildIds: [started.buildId] });
    expect(states[0]).toMatchObject({ status: "running", progress: { section: "Compile App" } });
    expect(second.experimental_getRetainedWorkerLeaseCount()).toBe(1);

    writeFileSync(join(ws.checkout, "go"), "");
    const exited = await until(() => exitedSignal(second, started.buildId));
    expect(exited).toMatchObject({ status: "exited", exitCode: 0 });
    expect(exitedSignal(first, started.buildId)).toBeUndefined();
  });

  it("finds a build that finished while no worker was running", async () => {
    const ws = workspace();
    const first = harnessFor(ws);
    const started = await start(first, ws.checkout, "gated");
    await first.experimental_dispose();

    writeFileSync(join(ws.checkout, "go"), "");
    await until(() => existsSync(join(ws.dataDir, "builds", started.buildId, "exit")));

    const second = harnessFor(ws);
    const { states } = await second.experimental_call("buildStates", { buildIds: [started.buildId] });
    expect(states[0]).toMatchObject({ status: "exited", exitCode: 0, progress: { section: "Compile App" } });
  });
});

describe("summarize", () => {
  it("parses the bundle on the host and bounds what it sends back", async () => {
    const ws = workspace();
    const longMessage = "x".repeat(10_000);
    const xcresult = vi.fn(async (_tool: string, args: readonly string[]) => {
      if (args[1] === "build-results") {
        return {
          status: "failed",
          errorCount: 1,
          warningCount: 0,
          analyzerCount: 0,
          errors: [{ issueType: "Swift Compiler Error", message: longMessage }],
        };
      }
      if (args[2] === "summary") {
        return { result: "Failed", totalTestCount: 2, passedTests: 1, failedTests: 1, skippedTests: 0 };
      }
      return {
        testNodes: [
          {
            nodeType: "Test Case",
            name: "testFails()",
            result: "Failed",
            children: [{ nodeType: "Failure Message", name: "boom" }],
          },
          { nodeType: "Test Case", name: "testPasses()", result: "Passed" },
        ],
      };
    });
    const harness = harnessFor(ws, { findTool: async () => "/usr/bin/xcresulttool", xcresult });
    const started = await start(harness, ws.checkout, "fail");
    await until(() => exitedSignal(harness, started.buildId));

    const result = await harness.experimental_call("summarize", { buildId: started.buildId });
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.bundlePath).toBe(started.bundlePath);
    expect(result.build?.issues[0]?.message.length).toBeLessThanOrEqual(4000);
    expect(result.summary).toMatchObject({ total: 2, failed: 1 });
    expect(result.tests.map((test) => test.name)).toEqual(["testFails()", "testPasses()"]);
    // Every xcresulttool call names the bundle the worker recorded, nothing else.
    for (const call of xcresult.mock.calls) expect(call[1]).toContain(started.bundlePath);
  });

  it("waits for a running build, and says so when Xcode is missing", async () => {
    const ws = workspace();
    const harness = harnessFor(ws, { findTool: async () => null });
    const started = await start(harness, ws.checkout, "gated");
    expect(await harness.experimental_call("summarize", { buildId: started.buildId })).toEqual({
      status: "pending",
    });
    writeFileSync(join(ws.checkout, "go"), "");
    await until(() => exitedSignal(harness, started.buildId));
    expect(await harness.experimental_call("summarize", { buildId: started.buildId })).toEqual({
      status: "unavailable",
      reason: "xcresulttool was not found on this Mac.",
    });
  });
});

describe("prune", () => {
  it("removes finished builds past retention and never a running one", async () => {
    const ws = workspace();
    const harness = harnessFor(ws);
    const done = await start(harness, ws.checkout, "pass");
    await until(() => exitedSignal(harness, done.buildId));
    const running = await start(harness, ws.checkout, "gated");

    // Age the finished build's exit past the window.
    const old = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(join(ws.dataDir, "builds", done.buildId, "exit"), old, old);

    const result = await harness.experimental_call("prune", {
      maxAgeMs: 2 * 86_400_000,
      maxTotalBytes: 5 * 1024 ** 3,
    });
    expect(result.removed).toBe(1);
    expect(existsSync(join(ws.dataDir, "builds", done.buildId))).toBe(false);
    expect(existsSync(join(ws.dataDir, "builds", running.buildId))).toBe(true);

    // A zero budget still spares the running build.
    await harness.experimental_call("prune", { maxAgeMs: 2 * 86_400_000, maxTotalBytes: 0 });
    expect(existsSync(join(ws.dataDir, "builds", running.buildId))).toBe(true);
    writeFileSync(join(ws.checkout, "go"), "");
    await until(() => exitedSignal(harness, running.buildId));
  });
});

// ------------------------------------------------------- identity, unit level

describe("process identity", () => {
  it("parses ps etime and command, including days and hours", () => {
    expect(parseElapsedSeconds("00:07")).toBe(7);
    expect(parseElapsedSeconds("01:02:03")).toBe(3723);
    expect(parseElapsedSeconds("2-00:00:01")).toBe(172_801);
    expect(parseElapsedSeconds("garbage")).toBeNull();
    expect(parseIdentity("  01:00 /bin/sh -c x bb-xcode-build:abc\n", 1_000_000)).toEqual({
      command: "/bin/sh -c x bb-xcode-build:abc",
      startedAt: 940_000,
    });
    expect(parseIdentity("", 0)).toBeNull();
  });

  it("matches within the start-time tolerance, and only with the marker", () => {
    const expected = { marker: "bb-xcode-build:abc", startedAt: 1_000_000 };
    const at = (startedAt: number, command = "/bin/sh -c … bb-xcode-build:abc /usr/bin/xcodebuild") => ({
      command,
      startedAt,
    });
    // ps etime jitter, measured at ~100-300 ms and up to a second at a boundary.
    expect(isSameProcess(at(1_000_300), expected)).toBe(true);
    expect(isSameProcess(at(999_000), expected)).toBe(true);
    expect(isSameProcess(at(1_001_900), expected)).toBe(true);
    // A recycled pid: a process that started well after ours.
    expect(isSameProcess(at(1_002_500), expected)).toBe(false);
    // Same start second, different process.
    expect(isSameProcess(at(1_000_000, "/usr/bin/vim notes.txt"), expected)).toBe(false);
    expect(isSameProcess(null, expected)).toBe(false);
    expect(isSameProcess({ command: null, startedAt: 1_000_000 }, expected)).toBe(false);
    expect(isSameProcess({ command: expected.marker, startedAt: null }, expected)).toBe(false);
  });

  it("decodes the wrapper's status, signals included", () => {
    expect(decodeExitStatus(0)).toEqual({ exitCode: 0, signal: null });
    expect(decodeExitStatus(65)).toEqual({ exitCode: 65, signal: null });
    expect(decodeExitStatus(143)).toEqual({ exitCode: null, signal: "SIGTERM" });
    expect(decodeExitStatus(137)).toEqual({ exitCode: null, signal: "SIGKILL" });
    // Not a signal sh would report: keep it as the code it is.
    expect(decodeExitStatus(200)).toEqual({ exitCode: 200, signal: null });
  });
});

describe("re-adoption by pid and start time", () => {
  function recorded(dataDir: string, startedAt: number): BuildRecord {
    const buildId = "abc1-0123456789ab";
    const dir = join(dataDir, "builds", buildId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stream.ndjson"), "");
    const record: BuildRecord = {
      version: 1,
      buildId,
      marker: `bb-xcode-build:${buildId}`,
      pid: 4242,
      startedAt,
      root: "/w/App",
      workingDir: "/w/App",
      argv: ["/usr/bin/xcodebuild", "build"],
      bundlePath: join(dir, "result.xcresult"),
      streamPath: join(dir, "stream.ndjson"),
      exitPath: join(dir, "exit"),
      pidPath: join(dir, "xcodebuild.pid"),
      stderrPath: join(dir, "stderr.log"),
    };
    writeFileSync(join(dir, "record.json"), JSON.stringify(record));
    return record;
  }

  const hooks = (): WorkerHooks => ({
    emitProgress: async () => undefined,
    emitExited: async () => undefined,
    retainWorker: () => ({ dispose: async () => undefined }),
  });

  it("re-adopts through start-time jitter, and refuses a recycled pid", async () => {
    const ws = workspace();
    const record = recorded(ws.dataDir, 5_000_000);
    let reported = { command: `/bin/sh -c … ${record.marker} /usr/bin/xcodebuild build`, startedAt: 5_000_800 };
    const kill = vi.fn();
    const builds = new HostBuilds({
      dataDir: ws.dataDir,
      readIdentity: async () => reported,
      kill,
      livenessMs: 1_000_000,
      pollMs: 10,
    });

    let [state] = await builds.states([record.buildId], hooks());
    expect(state?.status).toBe("running");
    expect(builds.watching).toBe(1);

    // Same pid, now a different process: start time far off, no marker.
    reported = { command: "/usr/sbin/cupsd -l", startedAt: 9_000_000 };
    for (let miss = 1; miss < LOST_AFTER_MISSES; miss += 1) {
      [state] = await builds.states([record.buildId], hooks());
      // One bad read is not a verdict: ps can time out on a loaded Mac.
      expect(state?.status).toBe("running");
    }
    [state] = await builds.states([record.buildId], hooks());
    expect(state).toMatchObject({ status: "lost", exitCode: null, signal: null });

    // And the stranger now holding that pid is never signalled.
    const stopped = await builds.stop(record.buildId);
    expect(stopped.stopped).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    await builds.dispose();
  });

  it("signals the build's process group only once its identity checks out", async () => {
    const ws = workspace();
    const record = recorded(ws.dataDir, 5_000_000);
    // The wrapper has launched xcodebuild as pid 4243.
    writeFileSync(record.pidPath, "4243\n");
    const kill = vi.fn();
    const builds = new HostBuilds({
      dataDir: ws.dataDir,
      readIdentity: async (pid) =>
        pid === 4242
          ? { command: `sh -c … ${record.marker}`, startedAt: 5_001_500 }
          : { command: "/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild build", startedAt: 5_001_000 },
      kill,
    });
    expect((await builds.stop(record.buildId)).stopped).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    await builds.dispose();
  });

  it("prefers a written exit status over whatever ps says", async () => {
    const ws = workspace();
    const record = recorded(ws.dataDir, 5_000_000);
    writeFileSync(record.exitPath, "65\n");
    const builds = new HostBuilds({ dataDir: ws.dataDir, readIdentity: async () => null });
    const [state] = await builds.states([record.buildId], hooks());
    expect(state).toMatchObject({ status: "exited", exitCode: 65 });
    expect(builds.watching).toBe(0);
  });
});
