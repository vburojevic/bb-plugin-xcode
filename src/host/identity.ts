/**
 * Is this pid still the process we started?
 *
 * A build outlives the worker that spawned it — a plugin reload, a disable and
 * the daemon's idle stop all leave it running, re-parented to launchd — so the
 * worker that later checks on it, or is asked to stop it, is no longer its
 * parent and cannot `wait()` for it. All it has is the pid in the build's
 * record, and macOS hands pids out again. Before believing a pid is alive, and
 * above all before signalling it, two things must agree with the record:
 *
 *  - the command line carries the build's own marker;
 *  - the start time matches within `START_TIME_TOLERANCE_MS`.
 *
 * This mirrors the SDK's `experimental_readProcessIdentity` (same `ps` fields,
 * same arithmetic, plus `-ww`). It is reimplemented rather than imported because that
 * function lives on the `@get-bb/plugin-sdk/host` subpath, which would make
 * the SDK a runtime dependency of the host bundle; the root helpers this entry
 * uses are stubbed in by bb's builder.
 */

import { execFile } from "node:child_process";

export interface ProcessIdentity {
  command: string | null;
  /** Epoch ms, derived from `ps etime`: whole seconds, so it jitters. */
  startedAt: number | null;
}

/**
 * `null`: no such process — `ps` said so. A rejection with
 * `ProcessInspectionError`: nobody knows (`ps` timed out, failed to run). The
 * difference matters: only the first is evidence a build is gone.
 */
export type ReadIdentity = (pid: number) => Promise<ProcessIdentity | null>;

export class ProcessInspectionError extends Error {
  override readonly name = "ProcessInspectionError";
}

/**
 * How far a re-read start time may sit from the recorded one.
 *
 * `etime` has one-second resolution and `startedAt` is `now - elapsed`, so the
 * same process reads back up to a second apart (measured: ~100–300 ms between
 * reads on a remote Mac, up to a full second at a boundary). Two seconds is
 * past that and far short of a pid being recycled into a process that started
 * at the same moment.
 */
export const START_TIME_TOLERANCE_MS = 2_000;

export const readProcessIdentity: ReadIdentity = (pid) =>
  new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      resolve(null);
      return;
    }
    execFile(
      "/bin/ps",
      // `-ww`: never truncate the command column. The marker this check looks
      // for sits after the wrapper script, and procps cuts a piped `ps` at 80
      // columns without it.
      ["-ww", "-p", String(pid), "-o", "etime=", "-o", "command="],
      { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          // `ps -p` exits 1 for a pid that does not exist; that is an answer.
          // Anything else — killed by the timeout on a loaded Mac, failed to
          // start — is not, and must not read as "gone".
          const code = (error as { code?: unknown }).code;
          const killed = (error as { killed?: boolean }).killed === true;
          if (code === 1 && !killed && stdout.trim() === "") resolve(null);
          else reject(new ProcessInspectionError(`ps -p ${pid} failed: ${error.message}`));
          return;
        }
        resolve(parseIdentity(stdout, Date.now()));
      },
    );
  });

/** Parse `ps -o etime= -o command=` for one pid. Exported for tests. */
export function parseIdentity(stdout: string, now: number): ProcessIdentity | null {
  const match = /^(\S+)\s+([\s\S]+)$/u.exec(stdout.trim());
  if (match === null) return null;
  const elapsed = parseElapsedSeconds(match[1] ?? "");
  return {
    command: match[2] ?? null,
    startedAt: elapsed === null ? null : now - elapsed * 1000,
  };
}

/** `[[dd-]hh:]mm:ss` → seconds. */
export function parseElapsedSeconds(raw: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d{1,2}):(\d{2})$/u.exec(raw.trim());
  if (match === null) return null;
  const days = Number(match[1] ?? "0");
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

/**
 * Does a live process's identity match what a build record says it started?
 *
 * Fails closed: an unreadable start time or command is not a match, because
 * the cost of a false "yes" is signalling a stranger.
 */
export function isSameProcess(
  identity: ProcessIdentity | null,
  expected: { marker: string; startedAt: number },
  toleranceMs = START_TIME_TOLERANCE_MS,
): boolean {
  if (identity === null || identity.command === null || identity.startedAt === null) {
    return false;
  }
  if (!identity.command.includes(expected.marker)) return false;
  return Math.abs(identity.startedAt - expected.startedAt) <= toleranceMs;
}
