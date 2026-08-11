/**
 * Thin `child_process` helpers.
 *
 * Everything here runs on the bb *server* host. The SDK exposes no general
 * remote-exec primitive, so process observation is necessarily server-local;
 * remote hosts are covered by the file-based tiers via `bb.sdk.files`.
 */

import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run a command, capturing output.
 *
 * Never rejects: a non-zero exit, a missing binary, and a timeout all come back
 * as a result with a non-zero `code`, because every caller here treats failure
 * as "no data this tick" rather than an error worth propagating.
 */
export function run(
  file: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBuffer?: number; cwd?: string } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        timeout: options.timeoutMs ?? 10_000,
        // SIGKILL, not the default SIGTERM. Measured at load average 795, a
        // `ps -A` blocked in the kernel ignored SIGTERM and held the call for
        // over two minutes — fifteen times its own timeout — which is exactly
        // when the probe must NOT be stuck. A timeout has to be a timeout.
        killSignal: "SIGKILL",
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        cwd: options.cwd,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          code,
        });
      },
    );
  });
}

/** Snapshot every process, in the field order `parsePsOutput` expects. */
export async function psSnapshot(): Promise<string> {
  const result = await run("/bin/ps", ["-Aww", "-o", "pid=,ppid=,etime=,args="], {
    timeoutMs: 8_000,
  });
  return result.stdout;
}

/**
 * Working directory of a process.
 *
 * `lsof -d cwd` needs no elevated privileges for processes owned by the same
 * user (verified), which is exactly the case for a developer's own builds.
 */
export async function processCwd(pid: number): Promise<string | null> {
  const result = await run(
    "/usr/sbin/lsof",
    ["-p", String(pid), "-a", "-d", "cwd", "-Fn"],
    { timeoutMs: 4_000 },
  );
  if (result.code !== 0 && !result.stdout) return null;
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("n/")) return line.slice(1).trim() || null;
  }
  return null;
}

/** Resolve a developer tool through `xcrun`, or null when Xcode is absent. */
export async function findDeveloperTool(name: string): Promise<string | null> {
  const result = await run("/usr/bin/xcrun", ["--find", name], {
    timeoutMs: 8_000,
  });
  const path = result.stdout.trim();
  return result.code === 0 && path ? path : null;
}

/** Run `xcresulttool` and parse its JSON, or null if anything goes wrong. */
export async function xcresultJson(
  toolPath: string,
  args: readonly string[],
): Promise<unknown | null> {
  const result = await run(toolPath, [...args, "--compact"], {
    timeoutMs: 60_000,
  });
  if (result.code !== 0 || !result.stdout.trim()) return null;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}
