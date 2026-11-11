/**
 * Tracked builds on another Mac: the server's half.
 *
 * When a thread's checkout lives on an enrolled Mac, `xcode_build`, `bb xcode
 * run` and `bb xcode stop` reach that Mac's `bb.host` worker (`host.ts`)
 * through this module. The store, the engine and every surface stay here, so
 * a remote build is an ordinary run row — with `hostId` set — and the live
 * row, `xcode_status` and `bb xcode wait` read it exactly as they read a
 * local one.
 *
 * The run is inserted the moment the worker has spawned the build, already
 * attributed to its thread: there is no process probe on the other Mac to
 * discover it, and none is needed. From then on two paths feed it, and both
 * are idempotent:
 *
 *  - the worker's `progress` / `exited` signals, the fast path;
 *  - `reconcile`, which asks each Mac about every open run. Signals are
 *    ephemeral and a reload drops them, so this is what makes the record
 *    eventually right: after a server reload, a worker restart, or a Mac that
 *    was asleep when its build ended.
 *
 * A finished build's bundle is parsed on its own Mac (`summarize`) and folded
 * through the same `Engine.foldBundle` as a local one.
 */

import type { ExperimentalHostClient } from "@get-bb/plugin-sdk";

import type { Engine } from "./engine";
import { RANK, type Run } from "./model";
import { parseXcodebuildArgs } from "./proc";
import type { ThreadScope } from "./scopes";
import type { Store } from "./store";
import type { WrappedOutcome } from "./wrapped";
import type {
  BuildProgress,
  BuildState,
  HostContract,
  HostSignals,
  SummarizeResult,
} from "./host/contract";

export type HostCaller = Pick<ExperimentalHostClient<HostContract, HostSignals>, "call">;

/** Run ids of remote builds: the worker's build id, behind a fixed prefix. */
const RUN_PREFIX = "w:";

/** Call budgets. A summary can be three 60s-class xcresulttool runs. */
const STATE_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;
const SUMMARY_TIMEOUT_MS = 4 * 60_000;
const PRUNE_TIMEOUT_MS = 5 * 60_000;
/** Summaries that keep failing (an unreachable Mac) stop being retried. */
const MAX_SUMMARY_ATTEMPTS = 5;
/** Matches the server runner's grace before SIGKILL on a timed-out build. */
export const REMOTE_STOP_GRACE_MS = 2_000;

export function runIdFor(buildId: string): string {
  return `${RUN_PREFIX}${buildId}`;
}

export function buildIdOf(run: Pick<Run, "id" | "hostId">): string | null {
  return run.hostId !== null && run.id.startsWith(RUN_PREFIX)
    ? run.id.slice(RUN_PREFIX.length)
    : null;
}

export interface RemoteTarget {
  hostId: string;
  machineName: string;
}

export interface RemoteBuildRequest {
  argv: readonly string[];
  /** The thread's checkout, as bb's environment names it on that Mac. */
  root: string;
  cwd?: string;
}

export type RemoteStart =
  | { ok: true; runId: string; bundlePath: string; completed: Promise<WrappedOutcome> }
  | { ok: false; message: string };

export interface RemoteBuildsDeps {
  store: Store;
  engine: Engine;
  host: HostCaller;
  /** Live-progress publish, the same payload shape a local build sends. */
  publishLive(payload: Record<string, unknown>): void;
  publishSoon(): void;
  log: { debug(m: string): void; info(m: string): void; warn(m: string): void };
  isDisposed(): boolean;
  now?: () => number;
}

interface Waiter {
  promise: Promise<WrappedOutcome>;
  resolve(outcome: WrappedOutcome): void;
}

export class RemoteBuilds {
  private readonly now: () => number;
  private readonly waiters = new Map<string, Waiter>();
  /** Runs whose exit is being folded right now; signal and poll can race. */
  private readonly finishing = new Set<string>();
  private readonly summaryAttempts = new Map<string, number>();
  private readonly summarizing = new Set<string>();

  constructor(private readonly deps: RemoteBuildsDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------ requests

  /**
   * The checkout boundary, checked on the Mac that holds the checkout.
   *
   * Called before anyone is asked to confirm, so the person never approves a
   * build that is then refused.
   */
  async validate(
    target: RemoteTarget,
    request: RemoteBuildRequest,
  ): Promise<{ ok: true; workingDir: string } | { ok: false; message: string }> {
    try {
      return await this.deps.host.call(
        "validateBuild",
        { argv: [...request.argv], root: request.root, ...(request.cwd ? { cwd: request.cwd } : {}) },
        { hostId: target.hostId, timeoutMs: STATE_TIMEOUT_MS },
      );
    } catch (error) {
      return { ok: false, message: unreachable(target, error) };
    }
  }

  /**
   * Start the build on its Mac and record it as a run of `scope`'s thread.
   *
   * `killSignal` is the caller's way to end it early (the agent tool's
   * timeout); aborting it stops the build on its Mac, with the same grace
   * before SIGKILL the local runner gives.
   */
  async start(
    target: RemoteTarget,
    request: RemoteBuildRequest,
    scope: ThreadScope,
    killSignal?: AbortSignal,
  ): Promise<RemoteStart> {
    let started;
    try {
      started = await this.deps.host.call(
        "startBuild",
        { argv: [...request.argv], root: request.root, ...(request.cwd ? { cwd: request.cwd } : {}) },
        { hostId: target.hostId, timeoutMs: START_TIMEOUT_MS },
      );
    } catch (error) {
      return { ok: false, message: unreachable(target, error) };
    }
    if (!started.ok) return started;

    const runId = runIdFor(started.buildId);
    const commandLine = started.argv.join(" ");
    const attribution = parseXcodebuildArgs(commandLine);
    const run: Run = {
      id: runId,
      status: "running",
      statusRank: RANK.observed,
      kind: attribution.kind,
      scheme: attribution.scheme,
      container: attribution.container,
      configuration: attribution.configuration,
      destination: attribution.destination,
      projectId: scope.projectId,
      root: attribution.derivedDataPath,
      cwd: started.workingDir,
      pid: started.pid,
      cmdline: commandLine.slice(0, 4000),
      // The Mac's own clock, like the end time the worker will report, so the
      // duration is never skewed by the two machines disagreeing.
      startedAt: started.startedAt,
      endedAt: null,
      errorCount: 0,
      warningCount: 0,
      analyzerCount: 0,
      testTotal: null,
      testFailed: null,
      testSkipped: null,
      bundlePath: started.bundlePath,
      detailed: false,
      branch: scope.branch,
      worktree: lastSegment(scope.path),
      threadId: scope.threadId,
      hostId: target.hostId,
    };
    this.deps.store.insertRun(run);
    this.deps.log.info(`remote build started on ${target.machineName}: ${runId}`);
    this.deps.publishSoon();

    const waiter = this.waiterFor(runId);
    if (killSignal) {
      const onAbort = (): void => {
        void this.stop(run, REMOTE_STOP_GRACE_MS).catch(() => undefined);
      };
      if (killSignal.aborted) onAbort();
      else killSignal.addEventListener("abort", onAbort, { once: true });
      void waiter.promise.finally(() => killSignal.removeEventListener("abort", onAbort));
    }
    return { ok: true, runId, bundlePath: started.bundlePath, completed: waiter.promise };
  }

  /** Stop a remote run on its Mac. The worker re-proves the pid first. */
  async stop(run: Run, graceMs?: number): Promise<{ stopped: boolean; message: string }> {
    const buildId = buildIdOf(run);
    if (buildId === null || run.hostId === null) {
      return { stopped: false, message: `Run ${run.id} is not a build on another Mac.` };
    }
    try {
      return await this.deps.host.call(
        "stop",
        { buildId, ...(graceMs === undefined ? {} : { graceMs }) },
        { hostId: run.hostId, timeoutMs: STATE_TIMEOUT_MS },
      );
    } catch (error) {
      return {
        stopped: false,
        message: unreachable({ hostId: run.hostId, machineName: "its Mac" }, error),
      };
    }
  }

  // ------------------------------------------------------------- signals

  /** Live counts for the activity row, from the worker's stream tail. */
  onProgress(event: { hostId: string; payload: { buildId: string; progress: BuildProgress } }): void {
    if (this.deps.isDisposed()) return;
    const run = this.ownedRun(event.hostId, event.payload.buildId);
    if (!run || run.status !== "running") return;
    this.publishProgress(run, event.payload.progress);
  }

  onExited(event: { hostId: string; payload: { state: BuildState } }): void {
    if (this.deps.isDisposed()) return;
    const run = this.ownedRun(event.hostId, event.payload.state.buildId);
    if (!run) return;
    void this.finish(run, event.payload.state).catch((error: unknown) => {
      this.deps.log.warn(`folding ${run.id} failed: ${String(error)}`);
    });
  }

  /**
   * A run is only ever updated by the Mac it ran on. Signals carry the
   * authenticated host id; a worker cannot speak for another Mac's build.
   */
  private ownedRun(hostId: string, buildId: string): Run | null {
    const run = this.deps.store.getRun(runIdFor(buildId));
    return run && run.hostId === hostId ? run : null;
  }

  // ----------------------------------------------------------- reconcile

  /** Is there anything for `reconcile` to do? One cheap query each. */
  hasWork(): boolean {
    return (
      this.deps.store.listOpenRemoteRuns().length > 0 ||
      this.deps.store.listUnscannedRemoteBundles(1).length > 0
    );
  }

  /**
   * Ask each Mac about its open runs, fold whatever has ended, and summarize
   * bundles not yet read. `onlyHost` narrows it to one Mac, for a worker that
   * just exited. Returns true when anything changed.
   */
  async reconcile(onlyHost?: string): Promise<boolean> {
    let changed = false;
    const byHost = new Map<string, Run[]>();
    for (const run of this.deps.store.listOpenRemoteRuns()) {
      if (run.hostId === null || (onlyHost && run.hostId !== onlyHost)) continue;
      byHost.set(run.hostId, [...(byHost.get(run.hostId) ?? []), run]);
    }
    for (const [hostId, runs] of byHost) {
      if (this.deps.isDisposed()) return changed;
      const ids = runs.map((run) => buildIdOf(run)).filter((id): id is string => id !== null);
      let states: BuildState[];
      try {
        ({ states } = await this.deps.host.call(
          "buildStates",
          { buildIds: ids.slice(0, 64) },
          { hostId, timeoutMs: STATE_TIMEOUT_MS },
        ));
      } catch (error) {
        // Offline or asleep. The run stays `running`; the engine's age cap is
        // the backstop if the Mac never comes back.
        this.deps.log.debug(`could not reach ${hostId} for build states: ${String(error)}`);
        continue;
      }
      for (const state of states) {
        const run = runs.find((entry) => buildIdOf(entry) === state.buildId);
        if (!run) continue;
        if (state.status === "running") {
          if (run.status === "running") this.publishProgress(run, state.progress);
          continue;
        }
        if (await this.finish(run, state)) changed = true;
      }
    }

    for (const pending of this.deps.store.listUnscannedRemoteBundles()) {
      if (this.deps.isDisposed()) return changed;
      if (onlyHost && pending.hostId !== onlyHost) continue;
      if (await this.summarize(pending.runId, pending.hostId, pending.bundlePath)) changed = true;
    }
    if (changed) this.deps.publishSoon();
    return changed;
  }

  /**
   * Fold a build's end, then its bundle, then tell whoever is waiting.
   *
   * The bundle is read BEFORE the waiter is released, as the local runner
   * does: `xcode_build` answers with the errors and failed tests, and those
   * only exist once the bundle has been folded.
   */
  private async finish(run: Run, state: BuildState): Promise<boolean> {
    if (this.finishing.has(run.id)) return false;
    this.finishing.add(run.id);
    try {
      const now = this.now();
      let changed = false;
      const current = this.deps.store.getRun(run.id) ?? run;
      if (current.status === "running" || current.status === "finishing") {
        if (state.status === "exited" && current.bundlePath) {
          changed = this.deps.engine.foldWrappedExit(
            current.bundlePath,
            {
              exitCode: state.exitCode,
              signal: state.signal,
              errors: state.progress.errors,
              warnings: state.progress.warnings,
            },
            state.endedAt ?? now,
          );
        } else {
          changed = this.deps.engine.foldUnaccountedExit(
            run.id,
            state.endedAt ?? now,
            state.status === "unknown" ? "its Mac has no record of it" : "its wrapper is gone",
          );
        }
        if (changed) this.deps.publishSoon();
      }
      if (current.bundlePath && current.hostId) {
        if (await this.summarize(run.id, current.hostId, current.bundlePath)) changed = true;
      }
      if (changed) this.deps.publishSoon();
      this.release(run.id, {
        exitCode: state.exitCode,
        signal: state.signal,
        bundlePath: current.bundlePath ?? "",
        errors: state.progress.errors,
        warnings: state.progress.warnings,
        failed: state.status === "unknown",
      });
      return changed;
    } finally {
      this.finishing.delete(run.id);
    }
  }

  /** Read one remote bundle on its Mac and fold it. True when folded. */
  private async summarize(runId: string, hostId: string, bundlePath: string): Promise<boolean> {
    const run = this.deps.store.getRun(runId);
    const buildId = run ? buildIdOf(run) : null;
    if (!run || buildId === null || this.summarizing.has(runId)) return false;
    if (this.deps.store.hasSeen(`bundle-scanned:${bundlePath}`)) return false;
    this.summarizing.add(runId);
    try {
      let result: SummarizeResult;
      try {
        result = await this.deps.host.call(
          "summarize",
          { buildId },
          { hostId, timeoutMs: SUMMARY_TIMEOUT_MS },
        );
      } catch (error) {
        const attempts = (this.summaryAttempts.get(runId) ?? 0) + 1;
        this.summaryAttempts.set(runId, attempts);
        if (attempts >= MAX_SUMMARY_ATTEMPTS) this.markScanned(runId, bundlePath);
        this.deps.log.debug(`summarizing ${runId} failed (${attempts}): ${String(error)}`);
        return false;
      }
      if (this.deps.isDisposed()) return false;
      switch (result.status) {
        case "pending":
          return false;
        case "unavailable":
        case "unparseable":
          this.deps.log.debug(
            `no summary for ${runId}: ${result.status === "unavailable" ? result.reason : "unparseable bundle"}`,
          );
          this.markScanned(runId, bundlePath);
          return false;
        case "ok": {
          const folded = this.deps.engine.foldBundle(
            bundlePath,
            result.build,
            result.summary ? { ...result.summary, tests: [] } : null,
            result.tests,
            this.now(),
          );
          this.markScanned(runId, bundlePath);
          return folded;
        }
      }
    } finally {
      this.summarizing.delete(runId);
    }
  }

  private markScanned(runId: string, bundlePath: string): void {
    this.summaryAttempts.delete(runId);
    this.deps.store.markSeen(`bundle-scanned:${bundlePath}`, this.now());
  }

  // ----------------------------------------------------------- retention

  /** Ask every Mac that ran a build here to apply the bundle retention. */
  async prune(retention: { maxAgeMs: number; maxTotalBytes: number }): Promise<number> {
    let removed = 0;
    for (const hostId of this.deps.store.listRemoteHostIds()) {
      if (this.deps.isDisposed()) break;
      try {
        const result = await this.deps.host.call("prune", retention, {
          hostId,
          timeoutMs: PRUNE_TIMEOUT_MS,
        });
        removed += result.removed;
      } catch (error) {
        this.deps.log.debug(`could not prune builds on ${hostId}: ${String(error)}`);
      }
    }
    return removed;
  }

  // ----------------------------------------------------------- lifecycle

  /**
   * Release every waiter. The builds carry on, and the next instance's
   * reconcile folds them; a caller blocked on one here gets a non-answer
   * rather than hanging on a plugin that no longer exists.
   */
  dispose(): void {
    for (const runId of [...this.waiters.keys()]) {
      this.release(runId, {
        exitCode: null,
        signal: null,
        bundlePath: this.deps.store.getRun(runId)?.bundlePath ?? "",
        errors: 0,
        warnings: 0,
        failed: true,
      });
    }
  }

  // ------------------------------------------------------------- helpers

  private publishProgress(run: Run, progress: BuildProgress): void {
    this.deps.publishLive({
      at: this.now(),
      live: {
        runId: run.id,
        section: progress.section,
        opened: progress.opened,
        closed: progress.closed,
        errors: progress.errors,
        warnings: progress.warnings,
      },
    });
  }

  private waiterFor(runId: string): Waiter {
    let waiter = this.waiters.get(runId);
    if (!waiter) {
      let resolve!: (outcome: WrappedOutcome) => void;
      const promise = new Promise<WrappedOutcome>((done) => {
        resolve = done;
      });
      waiter = { promise, resolve };
      this.waiters.set(runId, waiter);
    }
    return waiter;
  }

  private release(runId: string, outcome: WrappedOutcome): void {
    const waiter = this.waiters.get(runId);
    if (!waiter) return;
    this.waiters.delete(runId);
    waiter.resolve(outcome);
  }
}

function unreachable(target: RemoteTarget, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not reach ${target.machineName} to run the build there: ${reason}`;
}

function lastSegment(path: string): string | null {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  const name = index === -1 ? trimmed : trimmed.slice(index + 1);
  return name || null;
}
