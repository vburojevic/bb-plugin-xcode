/**
 * Executes a wrapped `xcodebuild` and tails its live result stream.
 *
 * Used by `bb xcode run -- xcodebuild …`. The wrapper is what upgrades a build
 * from "we can see the process exists" (Tier 0) to per-section live progress
 * with issues as they are emitted (Tier 3).
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyStreamEvent,
  emptyProgress,
  injectStreamFlags,
  parseStreamLine,
  splitLines,
  type StreamEvent,
  type StreamProgress,
} from "./stream";

/** Distinguishes bundles minted within the same millisecond by one process. */
let bundleCounter = 0;

export interface RunnerOptions {
  argv: readonly string[];
  cwd?: string;
  /**
   * Where the result bundle is written when the argv does not name one.
   *
   * Defaults to the scratch directory, which is what it used to always do —
   * and the reason wrapped builds escaped retention entirely: their bundles
   * landed in a tmp directory nothing owned, to be collected whenever the OS
   * felt like it. Pointing this at the shim's bundle directory puts every
   * bundle this plugin causes to exist under one policy.
   */
  bundleDir?: string;
  /** Called on every parsed event; keep it cheap, it runs on the tail loop. */
  onEvent?: (event: StreamEvent, progress: StreamProgress) => void;
  /** Called once the child is spawned, with the paths it will write. */
  onStart?: (info: { bundlePath: string; streamPath: string; pid: number | null }) => void;
  /** Poll interval for the stream file tail. */
  pollMs?: number;
  /** Aborting this kills the child (SIGTERM). */
  signal?: AbortSignal;
  /**
   * Stops tailing the stream file and firing `onEvent`, leaving the child
   * alone. This is what a plugin reload wants: a wrapped build is detached on
   * purpose and must survive the reload, but the tail loop belongs to the old
   * plugin instance and has to stop touching its handles.
   */
  detachSignal?: AbortSignal;
}

export interface RunnerResult {
  /** Process exit code; null when the process died to a signal. */
  exitCode: number | null;
  /** Termination signal (e.g. "SIGTERM"), null on a normal exit. */
  signal: string | null;
  bundlePath: string;
  progress: StreamProgress;
  stdoutTail: string;
  stderrTail: string;
}

/** Keep only the last `limit` bytes of a growing string. */
function tailOf(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/**
 * Run xcodebuild with a result bundle + live stream, returning once it exits.
 *
 * The stream file is created up front because xcodebuild refuses to write to a
 * path that does not already exist.
 */
export async function runWrapped(options: RunnerOptions): Promise<RunnerResult> {
  const workDir = await mkdtemp(join(tmpdir(), "bb-xcode-"));
  const streamPath = join(workDir, "stream.ndjson");
  // The stream file is scratch and dies with the workdir; the bundle is the
  // artifact and outlives it, so the two must not share a directory.
  const stamp = `${Date.now().toString(36)}-${process.pid}-${bundleCounter++}`;
  const defaultBundle = options.bundleDir
    ? join(options.bundleDir, `run-${stamp}.xcresult`)
    : join(workDir, "result.xcresult");
  if (options.bundleDir) {
    await mkdir(options.bundleDir, { recursive: true });
  }
  await writeFile(streamPath, "");

  const injected = injectStreamFlags(options.argv, defaultBundle, streamPath);
  const [command, ...args] = injected.argv;
  if (!command) {
    await rm(workDir, { recursive: true, force: true });
    throw new Error("No command given to run.");
  }

  let progress = emptyProgress();
  let stdout = "";
  let stderr = "";

  const child = spawn(command, args, {
    cwd: options.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  options.onStart?.({
    bundlePath: injected.bundlePath,
    streamPath: injected.streamPath,
    pid: child.pid ?? null,
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout = tailOf(stdout + chunk.toString("utf8"), 200_000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = tailOf(stderr + chunk.toString("utf8"), 64_000);
  });

  const onAbort = (): void => {
    child.kill("SIGTERM");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  // Tail the stream file alongside the process. Reading by offset avoids
  // re-parsing the whole file on every poll.
  let stopTailing = false;
  const onDetach = (): void => {
    stopTailing = true;
  };
  options.detachSignal?.addEventListener("abort", onDetach, { once: true });
  const tail = (async () => {
    let offset = 0;
    let carry = "";
    const handle = await open(injected.streamPath, "r").catch(() => null);
    if (!handle) return;
    try {
      while (!stopTailing) {
        const stats = await handle.stat();
        if (stats.size > offset) {
          const length = stats.size - offset;
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          offset += bytesRead;
          const { lines, rest } = splitLines(
            carry + buffer.subarray(0, bytesRead).toString("utf8"),
          );
          carry = rest;
          for (const line of lines) {
            const event = parseStreamLine(line);
            if (!event) continue;
            progress = applyStreamEvent(progress, event);
            options.onEvent?.(event, progress);
          }
        }
        await delay(options.pollMs ?? 250);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  })();

  // A signaled child reports `code null`; that must never read as success —
  // it is exactly how a killed build looked "passed" before.
  const exit = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve) => {
      child.on("error", () => resolve({ code: 127, signal: null }));
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );

  // Let the tail drain whatever xcodebuild flushed as it exited.
  await delay(400);
  stopTailing = true;
  await tail.catch(() => undefined);
  options.signal?.removeEventListener("abort", onAbort);
  options.detachSignal?.removeEventListener("abort", onDetach);

  // Nothing reads the stream file after the tail stops. Leaving the scratch
  // directory behind meant one abandoned `bb-xcode-*` per wrapped build,
  // forever, waiting on whenever the OS decides to sweep its temp directory.
  // Only safe now that the bundle is written somewhere else.
  if (options.bundleDir) {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    exitCode: exit.code,
    signal: exit.signal,
    bundlePath: injected.bundlePath,
    progress,
    stdoutTail: stdout,
    stderrTail: stderr,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Interpret an xcodebuild exit code.
 *
 * 65 is the one that matters in practice: it means the build succeeded but
 * tests failed, which is a very different outcome from a compile failure.
 */
export function describeExit(code: number | null, signal?: string | null): string {
  if (code === null) return signal ? `killed (${signal})` : "killed";
  switch (code) {
    case 0:
      return "succeeded";
    case 64:
      return "usage error";
    case 65:
      return "tests failed";
    case 66:
      return "input error";
    case 70:
      return "internal error";
    case 130:
      return "interrupted";
    default:
      return `exit ${code}`;
  }
}
