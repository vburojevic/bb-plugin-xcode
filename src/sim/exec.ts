/**
 * Child processes, uniformly.
 *
 * Everything here spawns with an argv array and never a shell string, awaits
 * `close` rather than polling, and carries an `AbortSignal` so a reload can
 * reclaim it. No caller anywhere parses a number out of the human output of a
 * tool — ask for JSON or a machine-readable flag, or do not ask.
 */
import { spawn } from "node:child_process";
import { curatedChildEnv } from "../child-env.js";

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** True when the deadline fired and we killed it. */
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Stop buffering past this many bytes per stream. Default 1 MiB. */
  maxBuffer?: number;
  stdin?: string;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;

const SYSTEM_EXECUTABLES: Readonly<Record<string, string>> = {
  git: "/usr/bin/git",
  plutil: "/usr/bin/plutil",
  sips: "/usr/bin/sips",
  sw_vers: "/usr/bin/sw_vers",
  "xcode-select": "/usr/bin/xcode-select",
  xcodebuild: "/usr/bin/xcodebuild",
  xcrun: "/usr/bin/xcrun",
};

/** Resolve every Apple/system helper without trusting the server's PATH. */
export function trustedExecutable(command: string): string {
  return SYSTEM_EXECUTABLES[command] ?? command;
}

/**
 * Run a command to completion.
 *
 * Never rejects on a non-zero exit — the exit code is data, and every caller
 * here has a better error message than "command failed". It rejects only when
 * the process could not be spawned at all.
 */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const executable = trustedExecutable(command);

  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        // Native helpers and third-party binaries do not need provider,
        // tunnel, or plugin credentials from the long-lived bb server.
        env: options.env ?? curatedChildEnv(process.env),
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const kill = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      // A build that ignores SIGTERM must not hold a reload open forever.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 2000).unref?.();
    };

    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            kill();
          }, options.timeoutMs);
    timer?.unref?.();

    const onAbort = (): void => {
      kill();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) onAbort();

    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code, signal) => {
      finish({ code, signal, stdout, stderr, timedOut });
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.end(options.stdin);
    }
  });
}

/** Run and parse stdout as JSON, or throw with the tool's own stderr attached. */
export async function runJson<T>(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<T> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code ?? "?"}`;
    throw new Error(`${command} ${args[0] ?? ""} failed: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${command} ${args[0] ?? ""} did not return JSON`);
  }
}

/** Is this executable on PATH? Used only by probes, and cached by the caller. */
export async function which(command: string): Promise<string | null> {
  try {
    const result = await run("/usr/bin/which", [command], { timeoutMs: 5000 });
    if (result.code !== 0) return null;
    const path = result.stdout.trim().split("\n")[0]?.trim();
    return path === undefined || path === "" ? null : path;
  } catch {
    return null;
  }
}

/** The last N bytes of a stream, for a failure message that fits in a card. */
export function tail(text: string, bytes: number): string {
  const trimmed = text.trimEnd();
  if (Buffer.byteLength(trimmed, "utf8") <= bytes) return trimmed;
  const buffer = Buffer.from(trimmed, "utf8");
  // Slice on a character boundary rather than mid-codepoint.
  return `…${buffer.subarray(buffer.length - bytes).toString("utf8").replace(/^[^\n]*\n/, "")}`;
}
