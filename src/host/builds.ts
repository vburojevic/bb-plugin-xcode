/**
 * Tracked builds on the Mac this worker runs on.
 *
 * This is the host half of a tracked build whose checkout lives on an
 * enrolled Mac rather than on the machine running bb. The worker validates
 * the request there, spawns `xcodebuild` detached, tails its result stream and
 * reports progress, and parses the bundle once it is done. The server keeps
 * the store, the engine and every surface; it reaches this through
 * `src/host/contract.ts`.
 *
 * The one thing that shapes everything here: **a build outlives its worker.**
 * Measured on bb 0.49 (`scout-xcode-detached-test`): a detached child of a
 * host worker survives a plugin reload, a disable/enable and the daemon's
 * five-minute idle stop, re-parented to launchd, and bb never cleans it up.
 * That is what a build needs — a reload must not kill a twenty-minute test
 * run — but it means the worker that finds out how the build went is usually
 * not the one that started it, and so cannot `wait()` for it. Hence:
 *
 *  - every build has a durable record in the host data dir (pid, start time,
 *    marker, paths), so a fresh worker can re-adopt it. A launch intent is
 *    written before the wrapper is spawned, and the wrapper holds xcodebuild
 *    at a gate until the record exists, so a worker that dies mid-launch
 *    leaves a build the next one adopts, never one that runs unrecorded;
 *  - liveness is pid + start time + a marker in the command line, never the
 *    pid alone (see `identity.ts`);
 *  - xcodebuild runs under a tiny `sh` wrapper that writes its exit status to
 *    a file, because after a reload nobody is left to collect it any other way.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { confinedBuildCwd, validateBuildArguments } from "../build-security";
import { curatedChildEnv } from "../child-env";
import { findDeveloperTool, xcresultJson } from "../exec";
import { treeSize } from "../shim";
import {
  applyStreamEvent,
  emptyProgress,
  injectStreamFlags,
  parseStreamLine,
  splitLines,
  type StreamProgress,
} from "../stream";
import type { BuildResults, IssueRow, TestResults, TestRow } from "../types";
import { parseBuildResults, parseTestNodes, parseTestSummary } from "../xcresult";
import type {
  BuildProgress,
  BuildRequest,
  BuildStarted,
  BuildState,
  StartBuildResult,
  StartRequest,
  SummarizeResult,
} from "./contract";
import {
  isSameProcess,
  readProcessIdentity,
  type ProcessIdentity,
  START_TIME_TOLERANCE_MS,
  type ReadIdentity,
} from "./identity";

/** The only program a tracked build may run, as the server names it. */
export const XCODEBUILD = "/usr/bin/xcodebuild";

/** Same ceiling as the server's runner, per Mac. */
export const MAX_LIVE_BUILDS = 4;

const RECORD_FILE = "record.json";
const LAUNCH_FILE = "launch.json";
const STREAM_READ_BYTES = 64 * 1024;
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_STREAM_LINE_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 4096;
/**
 * Upper bound on the whole serialized summary reply, in UTF-8 bytes — the
 * unit the host-RPC cap (8 MiB) is measured in — with room left for the
 * transport's own envelope.
 */
export const SUMMARY_BUDGET_BYTES = 7 * 1024 * 1024;
const MAX_TESTS = 10_000;
const MAX_ISSUES = 2_000;
/**
 * Consecutive failed liveness reads before a build without an exit status is
 * called lost. `ps` can time out on a loaded Mac, and one bad read must not
 * end a build that is still compiling.
 */
export const LOST_AFTER_MISSES = 3;
/** Longest `stop` waits for a just-started build to finish launching. */
const LAUNCH_WAIT_MS = 3_000;
/**
 * How long a launch intent without a wrapper is taken to be a launch still
 * under way. Past it, nothing is coming: the worker died before the wrapper
 * started, and the build never ran.
 */
export const LAUNCH_SETTLE_MS = 30_000;
/** Exit status the wrapper writes when its gate never opened. */
const UNLAUNCHED_STATUS = 125;
/** A record with no exit status is only pruned once it is this old. */
const UNSETTLED_PRUNE_AFTER_MS = 24 * 3_600_000;

/**
 * The wrapper xcodebuild runs under.
 *
 * `$0` is the build's marker (so `ps` shows it and identity checks can find
 * it), `$@` is the validated argv.
 *
 * First it records its own pid and then waits at a gate: xcodebuild does not
 * run until the worker has made the build's record durable and created the
 * `ready` file. A worker that dies between spawning the wrapper and writing
 * the record therefore leaves a wrapper that has run nothing and says where
 * it is, and the next worker adopts it from the launch intent and opens the
 * gate (`HostBuilds.recover`). A gate that never opens times out after about
 * fifteen minutes: the wrapper marks the build unlaunched and leaves. It
 * leaves at once if the build's directory disappears.
 *
 * Then it forwards SIGTERM/SIGHUP to xcodebuild rather than dying of them,
 * waits for the real exit, and writes the status atomically. A status above
 * 128 is a signal, as sh reports one. A stop that arrives at the gate, or
 * before xcodebuild has even forked, is remembered and delivered.
 *
 * xcodebuild runs as a background job so the wrapper can trap signals while
 * waiting; a non-interactive sh gives such a job /dev/null as stdin and
 * ignores SIGINT in it, neither of which a tracked build uses. Nothing from
 * the request is interpolated into the script: paths come from the
 * environment and arguments from `$@`.
 */
export const WRAPPER_SCRIPT =
  `child=""; stop=""; ` +
  `trap 'stop=1; if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null; fi' TERM HUP; ` +
  `printf '%s\n' "$$" > "$XCODE_TRACK_WRAPPER.tmp" && mv -f "$XCODE_TRACK_WRAPPER.tmp" "$XCODE_TRACK_WRAPPER"; ` +
  `ticks=0; ` +
  `while [ ! -f "$XCODE_TRACK_READY" ] && [ -z "$stop" ]; do ` +
  // Its directory gone (pruned, or the data dir removed): nobody can ever
  // open the gate, and there is nowhere to report to.
  `if [ ! -d "$XCODE_TRACK_DIR" ]; then exit ${UNLAUNCHED_STATUS}; fi; ` +
  `if [ "$ticks" -ge 9000 ]; then : > "$XCODE_TRACK_UNLAUNCHED"; break; fi; ` +
  `sleep 0.1; ticks=$((ticks + 1)); done; ` +
  `if [ -n "$stop" ] || [ ! -f "$XCODE_TRACK_READY" ]; then ` +
  `if [ -n "$stop" ]; then status=143; else status=${UNLAUNCHED_STATUS}; fi; ` +
  `printf '%s\n' "$status" > "$XCODE_TRACK_EXIT.tmp" && mv -f "$XCODE_TRACK_EXIT.tmp" "$XCODE_TRACK_EXIT"; ` +
  `exit "$status"; fi; ` +
  `"$@" & child=$!; ` +
  // A stop that landed before `$child` was known is delivered now.
  `if [ -n "$stop" ]; then kill -TERM "$child" 2>/dev/null; fi; ` +
  `printf '%s\n' "$child" > "$XCODE_TRACK_PID"; ` +
  `wait "$child"; status=$?; ` +
  `while kill -0 "$child" 2>/dev/null; do wait "$child"; status=$?; done; ` +
  `printf '%s\n' "$status" > "$XCODE_TRACK_EXIT.tmp" && mv -f "$XCODE_TRACK_EXIT.tmp" "$XCODE_TRACK_EXIT"`;

const SIGNALS: Readonly<Record<number, string>> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  9: "SIGKILL",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
};

/** sh's `$?` → the exit code / signal pair the server's runner reports. */
export function decodeExitStatus(status: number): {
  exitCode: number | null;
  signal: string | null;
} {
  const signal = status > 128 ? SIGNALS[status - 128] : undefined;
  return signal ? { exitCode: null, signal } : { exitCode: status, signal: null };
}

/**
 * What is written before the wrapper is spawned: enough to adopt it if this
 * worker dies before the record is written.
 */
export interface LaunchIntent {
  version: 1;
  buildId: string;
  /** `$0` of the wrapper, so its command line names the build. */
  marker: string;
  root: string;
  workingDir: string;
  argv: string[];
  bundlePath: string;
  streamPath: string;
  exitPath: string;
  pidPath: string;
  stderrPath: string;
  /** Where the wrapper writes its own pid, before its gate. */
  wrapperPidPath: string;
  /** The gate: xcodebuild runs once this file exists. */
  readyPath: string;
  /** Created by a wrapper whose gate never opened. */
  unlaunchedPath: string;
  /** This worker's clock when the intent was written. */
  requestedAt: number;
}

/** What survives a worker: everything needed to find the build again. */
export interface BuildRecord extends LaunchIntent {
  /** The wrapper's pid, which is also its process group. */
  pid: number;
  /** The wrapper's start time as `ps` reported it, epoch ms. */
  startedAt: number;
}

/** What a build directory without a record turns out to hold. */
type Recovery =
  | { kind: "record"; record: BuildRecord }
  /** An intent whose wrapper may still be on its way. */
  | { kind: "launching" }
  /** An intent nothing ever came of: the build never ran. */
  | { kind: "unlaunched" }
  /** No intent: this Mac never got the request. */
  | { kind: "none" };

/** What one worker call lends the long-lived watcher it may start. */
export interface WorkerHooks {
  emitProgress(buildId: string, progress: BuildProgress): Promise<void>;
  emitExited(state: BuildState): Promise<void>;
  retainWorker(): { dispose(): Promise<void> };
}

export interface HostBuildsDeps {
  dataDir: string;
  readIdentity?: ReadIdentity;
  spawn?: typeof nodeSpawn;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** The binary the wrapper actually runs; tests point it at a fake. */
  xcodebuildBinary?: string;
  findTool?: (name: string) => Promise<string | null>;
  xcresult?: (tool: string, args: readonly string[]) => Promise<unknown | null>;
  /** Stream tail cadence. */
  pollMs?: number;
  /** Minimum gap between progress signals for one build. */
  progressIntervalMs?: number;
  /** How often a watcher re-confirms the wrapper is still alive. */
  livenessMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface Watch {
  record: BuildRecord;
  progress: StreamProgress;
  stopped: boolean;
  done: Promise<void>;
}

export class HostBuilds {
  private readonly readIdentity: ReadIdentity;
  private readonly spawn: typeof nodeSpawn;
  private readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  private readonly now: () => number;
  private readonly watches = new Map<string, Watch>();
  /** Final states, so a finished build's stream is parsed once. */
  private readonly settled = new Map<string, BuildState>();
  /** Consecutive failed liveness reads, per build. See `LOST_AFTER_MISSES`. */
  private readonly misses = new Map<string, number>();
  private lease: { dispose(): Promise<void> } | null = null;
  /** Starts in flight, by build id: a repeated start joins the first. */
  private readonly pendingStarts = new Map<string, Promise<StartBuildResult>>();
  /**
   * Slots held by starts that passed admission and have not become watches
   * yet. Counted with the watches, so concurrent starts cannot all pass a
   * check that none of them has been counted in.
   */
  private reserved = 0;
  private adopted: Promise<void> | null = null;
  private tool: Promise<string | null> | null = null;
  private disposed = false;

  constructor(private readonly deps: HostBuildsDeps) {
    this.readIdentity = deps.readIdentity ?? readProcessIdentity;
    this.spawn = deps.spawn ?? nodeSpawn;
    this.kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.now = deps.now ?? Date.now;
  }

  private get buildsDir(): string {
    return join(this.deps.dataDir, "builds");
  }

  private dirFor(buildId: string): string {
    return join(this.buildsDir, buildId);
  }

  // ------------------------------------------------------------ validation

  /**
   * The plugin's checkout boundary, enforced on the disk the build will use.
   *
   * These are the same checks a build on the server gets (`build-security.ts`):
   * cwd and every path argument must resolve inside the thread's checkout, and
   * host-mutating options are refused. They must run HERE — on the server the
   * remote checkout does not exist, and a lexical check would let a symlink in
   * the checkout point a build anywhere on the Mac.
   */
  async validate(request: BuildRequest): Promise<
    { ok: true; workingDir: string } | { ok: false; message: string }
  > {
    if (request.argv[0] !== XCODEBUILD) {
      return { ok: false, message: "Only xcodebuild may be run as a tracked build." };
    }
    try {
      const workingDir = await confinedBuildCwd(request.root, request.cwd);
      await validateBuildArguments(request.argv, request.root, workingDir);
      return { ok: true, workingDir };
    } catch (error) {
      return { ok: false, message: messageOf(error) };
    }
  }

  // ----------------------------------------------------------------- start

  /**
   * Start a build under the server's id, or return the one already started
   * under it. The server records the run before it asks, so a start whose
   * reply was lost is recovered by id rather than started again.
   */
  start(request: StartRequest, hooks: WorkerHooks): Promise<StartBuildResult> {
    const pending = this.pendingStarts.get(request.buildId);
    if (pending) return pending;
    const attempt = this.startOnce(request, hooks).finally(() => {
      this.pendingStarts.delete(request.buildId);
    });
    this.pendingStarts.set(request.buildId, attempt);
    return attempt;
  }

  private async startOnce(request: StartRequest, hooks: WorkerHooks): Promise<StartBuildResult> {
    const { buildId } = request;
    await this.adoptAll(hooks);
    const existing = await this.recordFor(buildId, hooks);
    if (existing) return { ok: true, buildId, ...startedOf(existing) };
    if (await exists(join(this.dirFor(buildId), LAUNCH_FILE))) {
      // Launched, but not yet confirmed: starting it again would run it twice.
      throw new Error(`Build ${buildId} is still launching on this Mac.`);
    }
    const checked = await this.validate(request);
    if (!checked.ok) return checked;

    // Admission. Nothing may await between the count and the reservation,
    // or concurrent starts all pass it.
    if (this.watches.size + this.reserved >= MAX_LIVE_BUILDS) {
      return {
        ok: false,
        message: `${MAX_LIVE_BUILDS} tracked builds are already running on this Mac.`,
      };
    }
    this.reserved += 1;
    try {
      return await this.spawnBuild(buildId, request, checked.workingDir, hooks);
    } finally {
      // A started build is a watch by now; a failed one gives the slot back.
      this.reserved -= 1;
    }
  }

  private async spawnBuild(
    buildId: string,
    request: BuildRequest,
    workingDir: string,
    hooks: WorkerHooks,
  ): Promise<StartBuildResult> {
    const dir = this.dirFor(buildId);
    await mkdir(dir, { recursive: true });
    const bundlePath = join(dir, "result.xcresult");
    const streamPath = join(dir, "stream.ndjson");
    const injected = injectStreamFlags(request.argv, bundlePath, streamPath);
    const intent: LaunchIntent = {
      version: 1,
      buildId,
      marker: `bb-xcode-build:${buildId}`,
      root: request.root,
      workingDir,
      argv: injected.argv,
      bundlePath,
      streamPath,
      exitPath: join(dir, "exit"),
      pidPath: join(dir, "xcodebuild.pid"),
      stderrPath: join(dir, "stderr.log"),
      wrapperPidPath: join(dir, "wrapper.pid"),
      readyPath: join(dir, "ready"),
      unlaunchedPath: join(dir, "unlaunched"),
      requestedAt: this.now(),
    };
    // xcodebuild refuses a stream path that does not already exist.
    await writeFile(streamPath, "");
    // Durable before anything runs: from here on, any worker can find this
    // build again, whatever happens to this one.
    await writeJsonAtomic(join(dir, LAUNCH_FILE), intent);
    const runArgv = [this.deps.xcodebuildBinary ?? XCODEBUILD, ...injected.argv.slice(1)];

    const stderrFd = openSync(intent.stderrPath, "a");
    let pid: number | undefined;
    try {
      const child = this.spawn("/bin/sh", ["-c", WRAPPER_SCRIPT, intent.marker, ...runArgv], {
        cwd: workingDir,
        // Its own process group: `stop` can then signal the whole tree, and
        // nothing that signals the daemon's group takes the build with it.
        detached: true,
        stdio: ["ignore", "ignore", stderrFd],
        env: {
          ...curatedChildEnv(process.env),
          XCODE_TRACK_PID: intent.pidPath,
          XCODE_TRACK_EXIT: intent.exitPath,
          XCODE_TRACK_WRAPPER: intent.wrapperPidPath,
          XCODE_TRACK_READY: intent.readyPath,
          XCODE_TRACK_UNLAUNCHED: intent.unlaunchedPath,
          XCODE_TRACK_DIR: dir,
        },
      });
      child.on("error", () => undefined);
      pid = child.pid;
      child.unref();
    } finally {
      closeSync(stderrFd);
    }
    if (pid === undefined) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      return { ok: false, message: "Could not start the build wrapper (/bin/sh)." };
    }

    const startedAt = await this.startTimeOf(pid, intent.marker);
    if (startedAt === null) {
      // `ps` never answered for it. A guessed start time would later fail
      // the identity check against the real one and orphan a live build, so
      // the wrapper stays at its gate. Whoever next asks about this build
      // recovers it from the intent once `ps` reads its real start, and
      // opens the gate then; until then it reports as launching.
      this.deps.log?.(`build ${buildId} (pid ${pid}) waits for a readable process table`);
      throw new Error(
        `Started build ${buildId}, but could not read its process yet; ` +
          "it runs once this Mac can confirm it.",
      );
    }
    const record: BuildRecord = { ...intent, pid, startedAt };
    await writeJsonAtomic(join(dir, RECORD_FILE), record);
    // Only now may xcodebuild run.
    await openGate(record);
    this.watch(record, hooks);
    this.deps.log?.(`started build ${buildId} (pid ${pid}) in ${workingDir}`);
    return { ok: true, buildId, ...startedOf(record) };
  }

  /**
   * Make a record for a build directory that has none.
   *
   * Only a launch the worker did not finish leaves one: its intent is on
   * disk, and its wrapper (if it got that far) has written its pid and is
   * waiting at the gate. Adopting it means writing the record this worker
   * would have written, then opening the gate.
   */
  private async recover(buildId: string): Promise<Recovery> {
    const intent = await readIntent(join(this.dirFor(buildId), LAUNCH_FILE), buildId);
    if (intent === null) return { kind: "none" };
    const wrapperPid = await readPid(intent.wrapperPidPath);
    if (wrapperPid !== null) {
      const exited = await this.readExit({ exitPath: intent.exitPath });
      const identity = exited ? null : await this.probe(wrapperPid);
      // Could not look: the wrapper may well be there. Never call that lost.
      if (identity === undefined) return { kind: "launching" };
      const alive =
        identity?.startedAt != null && identity.command?.includes(intent.marker) === true;
      if (alive || exited) {
        const record: BuildRecord = {
          ...intent,
          pid: wrapperPid,
          startedAt: alive ? identity!.startedAt! : intent.requestedAt,
        };
        await writeJsonAtomic(join(this.dirFor(buildId), RECORD_FILE), record);
        if (alive) await openGate(record);
        this.deps.log?.(`recovered build ${buildId} from its launch intent`);
        return { kind: "record", record };
      }
    }
    // Proof of a launch that never ran: no wrapper ever wrote its pid, or
    // `ps` says the one that did is gone without an exit. (A wrapper whose
    // gate times out writes its own exit, and is recovered as such above.)
    return this.now() - intent.requestedAt < LAUNCH_SETTLE_MS
      ? { kind: "launching" }
      : { kind: "unlaunched" };
  }

  /**
   * Open the gate of a recorded build whose worker died between writing the
   * record and opening it. Only for a wrapper proven alive and not exited;
   * opening an open gate is a no-op, so every path that loads a record runs
   * this rather than guessing which ones a crash could have interrupted.
   */
  private async resumeGate(record: BuildRecord): Promise<void> {
    if (await exists(record.readyPath)) return;
    if (await this.readExit(record)) return;
    if ((await this.liveness(record)) !== "alive") return;
    await openGate(record);
    this.deps.log?.(`opened the gate of recorded build ${record.buildId}`);
  }

  /** The build's record, recovering one from a launch intent when needed. */
  private async recordFor(buildId: string, hooks: WorkerHooks | null): Promise<BuildRecord | null> {
    const record = await this.loadRecord(buildId);
    if (record) {
      await this.resumeGate(record);
      return record;
    }
    const recovered = await this.recover(buildId);
    if (recovered.kind !== "record") return null;
    if (hooks && !(await this.readExit(recovered.record))) this.watch(recovered.record, hooks);
    return recovered.record;
  }

  /**
   * The wrapper's start time as identity checks will later read it.
   *
   * Read back from `ps`, never taken from the clock: identity checks compare
   * later reads of the same process against it, within `etime` jitter.
   * `null` when `ps` could not show the wrapper in ten tries.
   */
  private async startTimeOf(pid: number, marker: string): Promise<number | null> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const identity = await this.probe(pid);
      if (identity?.startedAt != null && identity.command?.includes(marker)) {
        return identity.startedAt;
      }
      await delay(50);
    }
    return null;
  }

  // ----------------------------------------------------------------- state

  async states(buildIds: readonly string[], hooks: WorkerHooks): Promise<BuildState[]> {
    await this.adoptAll(hooks);
    const out: BuildState[] = [];
    for (const buildId of buildIds) out.push(await this.stateOf(buildId, hooks));
    return out;
  }

  private async stateOf(buildId: string, hooks: WorkerHooks | null): Promise<BuildState> {
    const cached = this.settled.get(buildId);
    if (cached) return cached;
    let record = await this.loadRecord(buildId);
    if (record !== null) await this.resumeGate(record);
    if (record === null) {
      const recovered = await this.recover(buildId);
      switch (recovered.kind) {
        case "record":
          record = recovered.record;
          break;
        case "launching":
          // The Mac has it and is starting it: not yet a build to report on.
          return { ...unknownState(buildId), status: "running" };
        case "unlaunched":
          // It arrived, and nothing ever ran: an answer, unlike "unknown".
          return { ...unknownState(buildId), status: "lost" };
        case "none":
          return unknownState(buildId);
      }
    }

    const exited = await this.readExit(record);
    if (exited) return this.settle(record, exited);

    if (!(await this.confirmLost(record))) {
      if (hooks) this.watch(record, hooks);
      return {
        buildId,
        status: "running",
        exitCode: null,
        signal: null,
        endedAt: null,
        progress: toWire(this.watches.get(buildId)?.progress ?? (await readProgress(record.streamPath))),
        stderrTail: null,
        started: startedOf(record),
      };
    }
    // The wrapper may have written its status between the two reads.
    const late = await this.readExit(record);
    if (late) return this.settle(record, late);
    return this.settle(record, null);
  }

  /** Freeze a finished build's state. `null` exit means the wrapper was lost. */
  private async settle(
    record: BuildRecord,
    exit: { status: number; endedAt: number } | null,
  ): Promise<BuildState> {
    // A wrapper whose gate timed out ran nothing; its 125 is not a build's.
    const unlaunched = exit !== null && (await exists(record.unlaunchedPath));
    const decoded =
      exit && !unlaunched ? decodeExitStatus(exit.status) : { exitCode: null, signal: null };
    const state: BuildState = {
      buildId: record.buildId,
      status: exit && !unlaunched ? "exited" : "lost",
      exitCode: decoded.exitCode,
      signal: decoded.signal,
      endedAt: exit?.endedAt ?? null,
      progress: toWire(await readProgress(record.streamPath)),
      stderrTail: await readTail(record.stderrPath, STDERR_TAIL_BYTES),
      started: startedOf(record),
    };
    this.misses.delete(record.buildId);
    if (exit) {
      if (this.settled.size > 256) this.settled.clear();
      this.settled.set(record.buildId, state);
    }
    return state;
  }

  /**
   * `unknown` when the process table could not be read: neither proof of
   * life nor of death, and every caller treats it as such.
   */
  private async liveness(record: BuildRecord): Promise<"alive" | "gone" | "unknown"> {
    const identity = await this.probe(record.pid);
    if (identity === undefined) return "unknown";
    return isSameProcess(identity, record) ? "alive" : "gone";
  }

  /** An identity, `null` for no such process, `undefined` for could-not-look. */
  private async probe(pid: number): Promise<ProcessIdentity | null | undefined> {
    try {
      return await this.readIdentity(pid);
    } catch (error) {
      this.deps.log?.(`could not inspect pid ${pid}: ${messageOf(error)}`);
      return undefined;
    }
  }

  /**
   * True once the wrapper has failed `LOST_AFTER_MISSES` liveness reads in a
   * row; any successful read resets the count.
   */
  private async confirmLost(record: BuildRecord): Promise<boolean> {
    const live = await this.liveness(record);
    if (live === "alive") {
      this.misses.delete(record.buildId);
      return false;
    }
    // Could not look: not a miss, and not a sighting either.
    if (live === "unknown") return false;
    const misses = (this.misses.get(record.buildId) ?? 0) + 1;
    this.misses.set(record.buildId, misses);
    return misses >= LOST_AFTER_MISSES;
  }

  private async readExit(
    record: Pick<BuildRecord, "exitPath">,
  ): Promise<{ status: number; endedAt: number } | null> {
    try {
      const [text, info] = await Promise.all([
        readFile(record.exitPath, "utf8"),
        stat(record.exitPath),
      ]);
      const status = Number.parseInt(text.trim(), 10);
      if (!Number.isFinite(status)) return null;
      return { status, endedAt: Math.round(info.mtimeMs) };
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------- watch

  /**
   * Re-adopt every build a previous worker left running.
   *
   * Once per worker, on its first call. Without it a reload would leave the
   * live row frozen until the server's next reconcile asked about each build
   * by name; with it, progress resumes as soon as anything wakes the worker.
   */
  private adoptAll(hooks: WorkerHooks): Promise<void> {
    this.adopted ??= (async () => {
      for (const record of await this.listRecords()) {
        if (this.watches.has(record.buildId)) continue;
        if (await this.readExit(record)) continue;
        if ((await this.liveness(record)) !== "gone") this.watch(record, hooks);
      }
    })().catch((error: unknown) => {
      this.deps.log?.(`re-adopting builds failed: ${messageOf(error)}`);
    });
    return this.adopted;
  }

  /**
   * Tail one build's stream until it exits, emitting progress and its end.
   *
   * Holds a worker lease while any build is being watched, because the daemon
   * stops an idle worker after five minutes and a quiet build makes no calls.
   */
  private watch(record: BuildRecord, hooks: WorkerHooks): void {
    if (this.disposed || this.watches.has(record.buildId)) return;
    const entry: Watch = {
      record,
      progress: emptyProgress(),
      stopped: false,
      done: Promise.resolve(),
    };
    this.watches.set(record.buildId, entry);
    try {
      this.lease ??= hooks.retainWorker();
    } catch (error) {
      // Only possible outside an open call. Watching still works; the worker
      // may just be idle-stopped sooner, and the server's reconcile covers it.
      this.deps.log?.(`could not retain the worker: ${messageOf(error)}`);
    }
    entry.done = this.tail(entry, hooks)
      .catch((error: unknown) => {
        this.deps.log?.(`watching ${record.buildId} failed: ${messageOf(error)}`);
      })
      .finally(() => {
        this.watches.delete(record.buildId);
        if (this.watches.size === 0 && this.lease) {
          const lease = this.lease;
          this.lease = null;
          void lease.dispose().catch(() => undefined);
        }
      });
  }

  private async tail(entry: Watch, hooks: WorkerHooks): Promise<void> {
    const pollMs = this.deps.pollMs ?? 250;
    const progressMs = this.deps.progressIntervalMs ?? 500;
    const livenessMs = this.deps.livenessMs ?? 5_000;
    const { record } = entry;
    const reader = new StreamReader(record.streamPath);
    let lastEmitAt = 0;
    let lastLivenessAt = this.now();
    let emitted = toWire(entry.progress);

    const emitIfChanged = async (force: boolean): Promise<void> => {
      const wire = toWire(entry.progress);
      if (sameProgress(wire, emitted)) return;
      if (!force && this.now() - lastEmitAt < progressMs) return;
      lastEmitAt = this.now();
      emitted = wire;
      await hooks.emitProgress(record.buildId, wire).catch(() => undefined);
    };

    try {
      while (!entry.stopped && !this.disposed) {
        entry.progress = await reader.drain(entry.progress);
        await emitIfChanged(false);

        let exit = await this.readExit(record);
        if (!exit && this.now() - lastLivenessAt >= livenessMs) {
          lastLivenessAt = this.now();
          if (await this.confirmLost(record)) {
            exit = await this.readExit(record);
            if (!exit) {
              await hooks.emitExited(await this.settle(record, null)).catch(() => undefined);
              return;
            }
          }
        }
        if (exit) {
          // Let the tail catch whatever xcodebuild flushed as it exited.
          await delay(Math.min(400, pollMs * 2));
          entry.progress = await reader.drain(entry.progress);
          await emitIfChanged(true);
          await hooks.emitExited(await this.settle(record, exit)).catch(() => undefined);
          return;
        }
        await delay(pollMs);
      }
    } finally {
      await reader.close();
    }
  }

  // ------------------------------------------------------------------ stop

  async stop(buildId: string, graceMs?: number): Promise<{ stopped: boolean; message: string }> {
    const record = await this.recordFor(buildId, null);
    if (record === null) return { stopped: false, message: "No such build on this Mac." };
    if (await this.readExit(record)) {
      return { stopped: false, message: `Build ${buildId} has already finished.` };
    }
    // The one place a stale pid would do real harm: never signal a process
    // that does not prove it is the wrapper this record describes.
    const live = await this.liveness(record);
    if (live === "unknown") {
      return { stopped: false, message: `Could not inspect build ${buildId}'s process; try again.` };
    }
    if (live === "gone") {
      return { stopped: false, message: `Build ${buildId} is no longer running.` };
    }
    await this.launched(record);
    try {
      // The group: the wrapper forwards TERM and waits, xcodebuild and its
      // children get it directly.
      this.kill(-record.pid, "SIGTERM");
    } catch {
      try {
        this.kill(record.pid, "SIGTERM");
      } catch {
        return { stopped: false, message: `Build ${buildId} is already gone.` };
      }
    }
    if (graceMs !== undefined) {
      const timer = setTimeout(() => {
        void this.escalate(record);
      }, graceMs);
      timer.unref?.();
    }
    return { stopped: true, message: `Sent SIGTERM to build ${buildId} (pid ${record.pid}).` };
  }

  /**
   * Wait, briefly, until the build is past its first milliseconds.
   *
   * A stop that lands right after the start can find the wrapper before it
   * has set its trap (TERM would kill it before it records anything), or its
   * child forked but not yet exec'd into xcodebuild — still a copy of the
   * wrapper shell, trap included, so TERM would be swallowed and the build
   * would run on. Both are over once the wrapper has written the child's pid
   * and that pid no longer carries the wrapper's marker. Bounded: past
   * `LAUNCH_WAIT_MS` the signal goes anyway.
   */
  private async launched(record: BuildRecord): Promise<void> {
    // Still at its gate: the wrapper's trap is set and nothing has forked.
    if (!(await exists(record.readyPath))) return;
    const deadline = this.now() + LAUNCH_WAIT_MS;
    while (this.now() < deadline) {
      const childPid = await readPid(record.pidPath);
      if (childPid !== null) {
        const identity = await this.probe(childPid);
        if (identity === null || (identity && !identity.command?.includes(record.marker))) return;
      }
      if (await this.readExit(record)) return;
      await delay(25);
    }
  }

  /**
   * SIGKILL xcodebuild itself, never the wrapper, so the wrapper still lives
   * to write the exit status. Only when the pid it recorded still looks like
   * an xcodebuild that started with this build.
   */
  private async escalate(record: BuildRecord): Promise<void> {
    if (await this.readExit(record)) return;
    const childPid = await readPid(record.pidPath);
    if (childPid === null) return;
    const identity = await this.probe(childPid);
    if (
      !identity ||
      identity.command?.includes("xcodebuild") !== true ||
      identity.startedAt === null ||
      identity.startedAt < record.startedAt - START_TIME_TOLERANCE_MS
    ) {
      return;
    }
    try {
      this.kill(childPid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  // ------------------------------------------------------------- summarize

  async summarize(buildId: string): Promise<SummarizeResult> {
    const record = await this.recordFor(buildId, null);
    if (record === null) return { status: "unavailable", reason: "No such build on this Mac." };
    const exited = (await this.readExit(record)) !== null;
    const finalized = await stat(join(record.bundlePath, "Info.plist"))
      .then((info) => info.isFile())
      .catch(() => false);
    if (!finalized) {
      if (!exited && (await this.liveness(record)) !== "gone") return { status: "pending" };
      // xcodebuild finalizes on every normal exit, failures included; a
      // bundle that is still unfinalized after the wrapper reported is one
      // a killed build left behind. Give the exit a moment to have flushed.
      return exited
        ? { status: "unavailable", reason: "The result bundle was never finalized." }
        : { status: "unavailable", reason: "The build is gone and left no finished bundle." };
    }

    const tool = await (this.tool ??= (this.deps.findTool ?? findDeveloperTool)("xcresulttool"));
    if (!tool) {
      this.tool = null; // Xcode may be selected later; ask again next time.
      return { status: "unavailable", reason: "xcresulttool was not found on this Mac." };
    }
    const query = this.deps.xcresult ?? xcresultJson;
    const build = parseBuildResults(
      await query(tool, ["get", "build-results", "--path", record.bundlePath]),
    );
    const summary = parseTestSummary(
      await query(tool, ["get", "test-results", "summary", "--path", record.bundlePath]),
    );
    if (!build && !summary) return { status: "unparseable" };
    const tests =
      summary && summary.total > 0
        ? parseTestNodes(
            await query(tool, ["get", "test-results", "tests", "--path", record.bundlePath]),
          )
        : [];
    return boundSummary(record.bundlePath, build, summary, tests);
  }

  // ----------------------------------------------------------------- prune

  /**
   * Delete finished builds' directories (bundle, stream, logs): age first,
   * then oldest-first down to the budget. A running build is never touched,
   * and neither is a record a worker cannot read — it may be mid-write.
   */
  async prune(
    retention: { maxAgeMs: number; maxTotalBytes: number },
  ): Promise<{ removed: number; bytesFreed: number; bytesRetained: number; remaining: number }> {
    const now = this.now();
    const result = { removed: 0, bytesFreed: 0, bytesRetained: 0, remaining: 0 };
    const surviving: Array<{ dir: string; settledAt: number; size: number }> = [];
    const records = await this.listRecords();
    for (const record of records) {
      if (this.watches.has(record.buildId)) continue;
      const exit = await this.readExit(record);
      const dir = this.dirFor(record.buildId);
      const settledAt =
        exit?.endedAt ??
        (await stat(join(dir, RECORD_FILE)).then((info) => info.mtimeMs).catch(() => now));
      // No exit status: only a long-dead build is fair game. One negative
      // `ps` read is not enough to delete a running build's bundle.
      if (!exit) {
        if (now - settledAt < UNSETTLED_PRUNE_AFTER_MS) continue;
        if ((await this.liveness(record)) !== "gone") continue;
      }
      const size = await treeSize(dir);
      if (now - settledAt > retention.maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        this.settled.delete(record.buildId);
        result.removed += 1;
        result.bytesFreed += size;
        continue;
      }
      surviving.push({ dir, settledAt, size });
    }
    surviving.sort((a, b) => a.settledAt - b.settledAt);
    let held = surviving.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of surviving) {
      if (held <= retention.maxTotalBytes) break;
      await rm(entry.dir, { recursive: true, force: true });
      held -= entry.size;
      result.removed += 1;
      result.bytesFreed += entry.size;
    }
    result.bytesRetained = held;
    // What the server needs to know whether this Mac still owes a cleanup.
    result.remaining = records.length - result.removed;

    // Directories with no record even after recovery: a launch that never
    // ran, or a request that died before its intent was written. Nothing
    // there is a build, but they are still this plugin's files.
    const recorded = new Set(records.map((record) => record.buildId));
    for (const name of await this.listDirs()) {
      if (recorded.has(name) || this.pendingStarts.has(name)) continue;
      const dir = this.dirFor(name);
      const recovered = await this.recover(name);
      const modifiedAt = await stat(dir).then((info) => info.mtimeMs).catch(() => now);
      const age = now - modifiedAt;
      if (recovered.kind === "launching" || age < Math.max(retention.maxAgeMs, LAUNCH_SETTLE_MS)) {
        result.remaining += 1;
        continue;
      }
      const size = await treeSize(dir);
      await rm(dir, { recursive: true, force: true });
      result.removed += 1;
      result.bytesFreed += size;
    }
    return result;
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * Stop watching. Never stops a build: the worker going away (reload, idle
   * stop, disable) is exactly when the build must carry on.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = [...this.watches.values()];
    for (const entry of pending) entry.stopped = true;
    await Promise.all(pending.map((entry) => entry.done));
  }

  /** For tests: resolve when every watcher has finished. */
  async idle(): Promise<void> {
    await Promise.all([...this.watches.values()].map((entry) => entry.done));
  }

  get watching(): number {
    return this.watches.size;
  }

  // --------------------------------------------------------------- records

  private async loadRecord(buildId: string): Promise<BuildRecord | null> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.dirFor(buildId), RECORD_FILE), "utf8"),
      ) as Partial<BuildRecord>;
      return isRecord(raw) && raw.buildId === buildId ? raw : null;
    } catch {
      return null;
    }
  }

  private async listDirs(): Promise<string[]> {
    try {
      return await readdir(this.buildsDir);
    } catch {
      return [];
    }
  }

  private async listRecords(): Promise<BuildRecord[]> {
    const names = await this.listDirs();
    const out: BuildRecord[] = [];
    for (const name of names) {
      const record = await this.recordFor(name, null);
      if (record) out.push(record);
    }
    return out;
  }
}

/** Incremental reader for a growing NDJSON stream file. */
class StreamReader {
  private offset = 0;
  private carry = "";
  private handle: Awaited<ReturnType<typeof open>> | null = null;

  constructor(private readonly path: string) {}

  async drain(progress: StreamProgress): Promise<StreamProgress> {
    this.handle ??= await open(this.path, "r").catch(() => null);
    if (!this.handle) return progress;
    let next = progress;
    for (;;) {
      const { size } = await this.handle.stat();
      if (size <= this.offset || this.offset >= MAX_STREAM_BYTES) return next;
      const length = Math.min(size - this.offset, STREAM_READ_BYTES, MAX_STREAM_BYTES - this.offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await this.handle.read(buffer, 0, length, this.offset);
      if (bytesRead === 0) return next;
      this.offset += bytesRead;
      const { lines, rest } = splitLines(this.carry + buffer.subarray(0, bytesRead).toString("utf8"));
      this.carry = Buffer.byteLength(rest, "utf8") > MAX_STREAM_LINE_BYTES ? "" : rest;
      for (const line of lines) {
        const event = parseStreamLine(line);
        if (event) next = applyStreamEvent(next, event);
      }
    }
  }

  async close(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = null;
  }
}

/** Let a gated wrapper run xcodebuild. Idempotent. */
async function openGate(record: Pick<LaunchIntent, "readyPath">): Promise<void> {
  await writeFile(record.readyPath, "");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function readIntent(path: string, buildId: string): Promise<LaunchIntent | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<LaunchIntent>;
    return isIntent(raw) && raw.buildId === buildId ? raw : null;
  } catch {
    return null;
  }
}

function isIntent(raw: Partial<LaunchIntent>): raw is LaunchIntent {
  return (
    raw.version === 1 &&
    typeof raw.buildId === "string" &&
    typeof raw.marker === "string" &&
    typeof raw.bundlePath === "string" &&
    typeof raw.streamPath === "string" &&
    typeof raw.exitPath === "string" &&
    typeof raw.pidPath === "string" &&
    typeof raw.stderrPath === "string" &&
    typeof raw.wrapperPidPath === "string" &&
    typeof raw.readyPath === "string" &&
    typeof raw.unlaunchedPath === "string" &&
    typeof raw.requestedAt === "number" &&
    Array.isArray(raw.argv)
  );
}

async function readPid(path: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function readProgress(path: string): Promise<StreamProgress> {
  const reader = new StreamReader(path);
  try {
    return await reader.drain(emptyProgress());
  } finally {
    await reader.close();
  }
}

async function readTail(path: string, bytes: number): Promise<string | null> {
  try {
    const handle = await open(path, "r");
    try {
      const { size } = await handle.stat();
      if (size === 0) return null;
      const length = Math.min(size, bytes);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      // A cut through a multi-byte character decodes to U+FFFD; harmless.
      return buffer.subarray(0, bytesRead).toString("utf8").slice(-bytes);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function toWire(progress: StreamProgress): BuildProgress {
  return {
    section: clip(progress.currentSection, 2000),
    opened: progress.sectionsOpened,
    closed: progress.sectionsClosed,
    errors: progress.errors,
    warnings: progress.warnings,
  };
}

function sameProgress(a: BuildProgress, b: BuildProgress): boolean {
  return (
    a.section === b.section &&
    a.opened === b.opened &&
    a.closed === b.closed &&
    a.errors === b.errors &&
    a.warnings === b.warnings
  );
}

function unknownState(buildId: string): BuildState {
  return {
    buildId,
    status: "unknown",
    exitCode: null,
    signal: null,
    endedAt: null,
    progress: toWire(emptyProgress()),
    stderrTail: null,
    started: null,
  };
}

function startedOf(record: BuildRecord): BuildStarted {
  return {
    bundlePath: record.bundlePath,
    workingDir: record.workingDir,
    argv: record.argv,
    pid: record.pid,
    startedAt: record.startedAt,
  };
}

function clip(value: string, max: number): string;
function clip(value: string | null, max: number): string | null;
function clip(value: string | null, max: number): string | null {
  return value === null || value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

type SummaryOk = Extract<SummarizeResult, { status: "ok" }>;

/**
 * The summary reply, held to `budget` UTF-8 bytes as a whole.
 *
 * Per-field clipping alone does not bound it: 1,200 long diagnostics and
 * 1,600 long failures serialize to over 11 MB, and multibyte text gets there
 * with fewer, and the host RPC then rejects the reply outright — the build
 * loses all of its diagnostics instead of some. So every row is measured as
 * the bytes it adds to the serialized reply, and rows are admitted in the
 * order someone waiting on the build needs them: errors, failed tests, the
 * other issues, the other tests. The counts in `build` and `summary` stay
 * exact either way.
 */
export function boundSummary(
  bundlePath: string,
  build: BuildResults | null,
  summary: Omit<TestResults, "tests"> | null,
  tests: readonly TestRow[],
  budget = SUMMARY_BUDGET_BYTES,
): SummaryOk {
  const reply: SummaryOk = {
    status: "ok",
    bundlePath,
    build: build
      ? {
          ...build,
          actionTitle: clip(build.actionTitle, 2000),
          destination: clip(build.destination, 2000),
          issues: [],
        }
      : null,
    summary: summary ? { ...summary, destination: clip(summary.destination, 2000) } : null,
    tests: [],
  };
  let used = utf8Bytes(reply);

  const issues = (build?.issues ?? []).map(clipIssue);
  const rows = tests.map(clipTest);
  const queue: Array<{ issue: IssueRow } | { test: TestRow }> = [
    ...issues.filter((issue) => issue.severity === "error").map((issue) => ({ issue })),
    ...rows.filter((test) => test.status === "failed").map((test) => ({ test })),
    ...issues
      .filter((issue) => issue.severity !== "error")
      .sort((a, b) => ISSUE_RANK[a.severity] - ISSUE_RANK[b.severity])
      .map((issue) => ({ issue })),
    ...rows.filter((test) => test.status !== "failed").map((test) => ({ test })),
  ];
  for (const entry of queue) {
    const isIssue = "issue" in entry;
    const target = isIssue ? reply.build?.issues : reply.tests;
    if (!target || target.length >= (isIssue ? MAX_ISSUES : MAX_TESTS)) continue;
    // The row itself plus the comma that separates it from the previous one.
    const cost = utf8Bytes(isIssue ? entry.issue : entry.test) + 1;
    if (used + cost > budget) continue;
    used += cost;
    if (isIssue) reply.build!.issues.push(entry.issue);
    else reply.tests.push(entry.test);
  }
  return reply;
}

const ISSUE_RANK = { error: 0, warning: 1, analyzer: 2, note: 3 } as const;

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function clipIssue(issue: IssueRow): IssueRow {
  return {
    ...issue,
    message: clip(issue.message, 4000),
    filePath: clip(issue.filePath, 4096),
    target: clip(issue.target, 1000),
  };
}

function clipTest(test: TestRow): TestRow {
  return {
    ...test,
    suite: clip(test.suite, 2000),
    name: clip(test.name, 2000),
    identifier: clip(test.identifier, 4000),
    failureMessage: clip(test.failureMessage, 4000),
    target: clip(test.target, 1000),
  };
}

function isRecord(raw: Partial<BuildRecord>): raw is BuildRecord {
  const fields = raw as Partial<BuildRecord>;
  return isIntent(raw) && typeof fields.pid === "number" && typeof fields.startedAt === "number";
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, path);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
