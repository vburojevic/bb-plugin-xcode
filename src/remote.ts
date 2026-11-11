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
 * The run is recorded BEFORE the Mac is asked to start it, under an id minted
 * here, already attributed to its thread. A start whose reply is lost — the
 * Mac spawned the build, then the connection dropped — therefore still has a
 * row, and the worker's record of that id is what fills it in later. Nothing
 * a Mac runs on this plugin's behalf goes unaccounted for.
 *
 * From then on two paths feed the row, and both are idempotent:
 *
 *  - the worker's `progress` / `exited` signals, the fast path;
 *  - `reconcile`, which asks each Mac about every run still waiting on it.
 *    Signals are ephemeral and a reload drops them, so this is what makes the
 *    record eventually right: after a server reload, a worker restart, or a
 *    Mac that was asleep when its build ended.
 *
 * A failed call is never taken as an answer. A Mac that cannot be reached is
 * asked again later, with backoff, for as long as the run is kept; only what
 * a Mac actually says (exited, gone, never heard of it, nothing to parse)
 * settles anything.
 *
 * A finished build's bundle is parsed on its own Mac (`summarize`) and folded
 * through the same `Engine.foldBundle` as a local one.
 */

import { randomBytes } from "node:crypto";

import type { ExperimentalHostClient } from "@get-bb/plugin-sdk";

import type { Engine } from "./engine";
import { RANK, type Run } from "./model";
import { parseXcodebuildArgs } from "./proc";
import type { ThreadScope } from "./scopes";
import { HOST_BUILD_RUN_PREFIX, type Store } from "./store";
import type { WrappedOutcome } from "./wrapped";
import type {
  BuildProgress,
  BuildStarted,
  BuildState,
  HostContract,
  HostSignals,
  SummarizeResult,
} from "./host/contract";

export type HostCaller = Pick<ExperimentalHostClient<HostContract, HostSignals>, "call">;

/** Run ids of remote builds: the build id, behind a fixed prefix. */
const RUN_PREFIX = HOST_BUILD_RUN_PREFIX;

/** Call budgets. A summary can be three 60s-class xcresulttool runs. */
const STATE_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;
const SUMMARY_TIMEOUT_MS = 4 * 60_000;
const PRUNE_TIMEOUT_MS = 5 * 60_000;
/**
 * How long an unconfirmed start may go unheard-of on its Mac before it is
 * taken to have never arrived. Past the start call's own timeout plus bb's
 * cancellation grace, so a start still in flight is never written off.
 */
export const UNCONFIRMED_START_GRACE_MS = 2 * 60_000;
/** Backoff for a Mac that could not be reached: 5 s doubling to 15 min. */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 15 * 60_000;
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

/** A fresh build id, in the format the host contract accepts. */
export function mintBuildId(now: number): string {
  return `${now.toString(36)}-${randomBytes(6).toString("hex")}`;
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
  private readonly summarizing = new Set<string>();
  /** Starts this instance is still waiting on; reconcile leaves them alone. */
  private readonly starting = new Set<string>();
  /** Macs that failed to answer, and when to try them again. */
  private readonly backoff = new Map<string, { failures: number; retryAt: number }>();

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
      const checked = await this.deps.host.call(
        "validateBuild",
        { argv: [...request.argv], root: request.root, ...(request.cwd ? { cwd: request.cwd } : {}) },
        { hostId: target.hostId, timeoutMs: STATE_TIMEOUT_MS },
      );
      this.reached(target.hostId);
      return checked;
    } catch (error) {
      this.unreached(target.hostId);
      return { ok: false, message: unreachable(target, error) };
    }
  }

  /**
   * Record the build as a run of `scope`'s thread, then ask its Mac to start
   * it under that run's id.
   *
   * `killSignal` is the caller's way to end it early (the agent tool's
   * timeout); aborting it stops the build on its Mac, with the same grace
   * before SIGKILL the local runner gives.
   */
  async start(
    target: RemoteTarget,
    request: RemoteBuildRequest & { workingDir: string },
    scope: ThreadScope,
    killSignal?: AbortSignal,
  ): Promise<RemoteStart> {
    const buildId = mintBuildId(this.now());
    const runId = runIdFor(buildId);
    const commandLine = request.argv.join(" ");
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
      cwd: request.workingDir,
      pid: null,
      cmdline: commandLine.slice(0, 4000),
      // Provisional; replaced by the Mac's own clock once the start is
      // confirmed, so start and end come from the same clock.
      startedAt: this.now(),
      endedAt: null,
      errorCount: 0,
      warningCount: 0,
      analyzerCount: 0,
      testTotal: null,
      testFailed: null,
      testSkipped: null,
      // NULL until the Mac confirms: that is what marks a start unconfirmed.
      bundlePath: null,
      detailed: false,
      branch: scope.branch,
      worktree: lastSegment(scope.path),
      threadId: scope.threadId,
      hostId: target.hostId,
    };
    this.starting.add(runId);
    // Registered before the Mac is asked: on a short build its `exited`
    // signal can overtake the start reply, and the finish it triggers must
    // have someone to tell. The promise keeps that answer for whoever awaits
    // it once the reply does arrive.
    const waiter = this.waiterFor(runId);
    try {
      this.deps.store.insertRun(run);
      this.deps.store.addCleanupHost(target.hostId, this.now());
      this.deps.publishSoon();

      let started;
      try {
        started = await this.deps.host.call(
          "startBuild",
          {
            buildId,
            argv: [...request.argv],
            root: request.root,
            ...(request.cwd ? { cwd: request.cwd } : {}),
          },
          { hostId: target.hostId, timeoutMs: START_TIMEOUT_MS },
        );
      } catch (error) {
        // The Mac may well have started it. The row stays, and `reconcile`
        // adopts it from the worker's record, or writes it off once the Mac
        // has had `UNCONFIRMED_START_GRACE_MS` to know about it.
        this.unreached(target.hostId);
        // Nobody will await this start; reconcile settles the run on its own.
        this.waiters.delete(runId);
        const reason = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          message:
            `Could not confirm the build started on ${target.machineName}: ${reason}. ` +
            `If it did, it is tracked as ${runId}; check with: bb xcode status.`,
        };
      }
      this.reached(target.hostId);
      if (!started.ok) {
        // A definite refusal: nothing runs, so there is no run.
        this.waiters.delete(runId);
        this.deps.store.deleteRun(runId);
        this.deps.publishSoon();
        return started;
      }
      this.adopt(runId, started);
    } finally {
      this.starting.delete(runId);
    }
    this.deps.log.info(`remote build started on ${target.machineName}: ${runId}`);
    this.deps.publishSoon();

    const current = this.deps.store.getRun(runId) ?? run;
    if (killSignal) {
      const onAbort = (): void => {
        void this.stop(current, REMOTE_STOP_GRACE_MS).catch(() => undefined);
      };
      if (killSignal.aborted) onAbort();
      else killSignal.addEventListener("abort", onAbort, { once: true });
      void waiter.promise.finally(() => killSignal.removeEventListener("abort", onAbort));
    }
    return {
      ok: true,
      runId,
      bundlePath: current.bundlePath ?? "",
      completed: waiter.promise,
    };
  }

  /** Stop a remote run on its Mac. The worker re-proves the pid first. */
  async stop(run: Run, graceMs?: number): Promise<{ stopped: boolean; message: string }> {
    const buildId = buildIdOf(run);
    if (buildId === null || run.hostId === null) {
      return { stopped: false, message: `Run ${run.id} is not a build on another Mac.` };
    }
    try {
      const result = await this.deps.host.call(
        "stop",
        { buildId, ...(graceMs === undefined ? {} : { graceMs }) },
        { hostId: run.hostId, timeoutMs: STATE_TIMEOUT_MS },
      );
      this.reached(run.hostId);
      return result;
    } catch (error) {
      this.unreached(run.hostId);
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
    this.reached(event.hostId);
    this.publishProgress(run, event.payload.progress);
  }

  onExited(event: { hostId: string; payload: { state: BuildState } }): void {
    if (this.deps.isDisposed()) return;
    const run = this.ownedRun(event.hostId, event.payload.state.buildId);
    if (!run) return;
    this.reached(event.hostId);
    void this.finish(run, event.payload.state).catch((error: unknown) => {
      this.deps.log.warn(`folding ${run.id} failed: ${String(error)}`);
    });
  }

  /** A Mac's worker exited unexpectedly: it is up, so stop backing off. */
  onWorkerExit(hostId: string): void {
    this.backoff.delete(hostId);
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
      this.deps.store.listRemoteRunsAwaitingHost().length > 0 ||
      this.deps.store.listUnscannedRemoteBundles(1).length > 0
    );
  }

  /**
   * Ask each Mac about the runs waiting on it, fold whatever has ended, and
   * summarize bundles not yet read. `onlyHost` narrows it to one Mac, for a
   * worker that just exited. Macs in backoff are skipped. Returns true when
   * anything changed.
   */
  async reconcile(onlyHost?: string): Promise<boolean> {
    let changed = false;
    const byHost = new Map<string, Run[]>();
    for (const run of this.deps.store.listRemoteRunsAwaitingHost()) {
      if (run.hostId === null || (onlyHost && run.hostId !== onlyHost)) continue;
      if (this.starting.has(run.id)) continue;
      byHost.set(run.hostId, [...(byHost.get(run.hostId) ?? []), run]);
    }
    for (const [hostId, runs] of byHost) {
      if (this.deps.isDisposed()) return changed;
      if (!this.due(hostId)) continue;
      for (let index = 0; index < runs.length; index += 64) {
        const batch = runs.slice(index, index + 64);
        const ids = batch.map((run) => buildIdOf(run)).filter((id): id is string => id !== null);
        let states: BuildState[];
        try {
          ({ states } = await this.deps.host.call(
            "buildStates",
            { buildIds: ids },
            { hostId, timeoutMs: STATE_TIMEOUT_MS },
          ));
        } catch (error) {
          // Offline or asleep. Not an answer: the runs stay as they are and
          // the Mac is asked again after a backoff.
          this.unreached(hostId);
          this.deps.log.debug(`could not reach ${hostId} for build states: ${String(error)}`);
          break;
        }
        this.reached(hostId);
        for (const state of states) {
          const run = batch.find((entry) => buildIdOf(entry) === state.buildId);
          if (!run) continue;
          if (await this.apply(run, state)) changed = true;
        }
      }
    }

    for (const pending of this.deps.store.listUnscannedRemoteBundles()) {
      if (this.deps.isDisposed()) return changed;
      if (onlyHost && pending.hostId !== onlyHost) continue;
      if (!this.due(pending.hostId)) continue;
      if (await this.summarize(pending.runId, pending.hostId, pending.bundlePath)) changed = true;
    }
    if (changed) this.deps.publishSoon();
    return changed;
  }

  /** What a Mac said about one run. */
  private async apply(run: Run, state: BuildState): Promise<boolean> {
    let changed = false;
    if (run.bundlePath === null && state.started) {
      // A start whose reply never arrived: the worker's record fills it in.
      changed = this.adopt(run.id, state.started);
    }
    if (state.status === "running") {
      if (run.status === "running") this.publishProgress(run, state.progress);
      return changed;
    }
    if (
      state.status === "unknown" &&
      run.bundlePath === null &&
      this.now() - run.startedAt < UNCONFIRMED_START_GRACE_MS
    ) {
      // Its start may still be on the way to that Mac.
      return changed;
    }
    const current = this.deps.store.getRun(run.id) ?? run;
    return (await this.finish(current, state)) || changed;
  }

  private adopt(runId: string, started: BuildStarted): boolean {
    const commandLine = started.argv.join(" ");
    const adopted = this.deps.store.adoptRemoteStart(runId, {
      bundlePath: started.bundlePath,
      pid: started.pid,
      cwd: started.workingDir,
      cmdline: commandLine.slice(0, 4000),
      startedAt: started.startedAt,
    });
    if (adopted) this.deps.log.debug(`remote start confirmed: ${runId}`);
    return adopted;
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
      if (run.bundlePath === null && state.started) this.adopt(run.id, state.started);
      const now = this.now();
      let changed = false;
      const current = this.deps.store.getRun(run.id) ?? run;
      // `ended` at the observed rank is the engine's age cap, or nothing at
      // all: the Mac's answer may replace it.
      const waiting =
        current.status === "running" ||
        current.status === "finishing" ||
        (current.status === "ended" && current.statusRank === RANK.observed);
      if (waiting) {
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
            current.hostId,
          );
          // An age-capped run already carries the cap's end time; the Mac's
          // is the true one.
          const folded = this.deps.store.getRun(run.id);
          if (changed && folded && state.endedAt !== null && folded.endedAt !== state.endedAt) {
            this.deps.store.updateRun({ ...folded, endedAt: state.endedAt });
          }
        } else if (current.status !== "ended") {
          changed = this.deps.engine.foldUnaccountedExit(
            run.id,
            state.endedAt ?? now,
            state.status === "unknown" ? "its Mac has no record of it" : "its wrapper is gone",
          );
        }
      }
      // Whatever the Mac said, it said it: stop asking.
      this.deps.store.markRemoteSettled(run.id, now);
      if (changed) this.deps.publishSoon();
      const settled = this.deps.store.getRun(run.id) ?? current;
      if (settled.bundlePath && settled.hostId) {
        if (await this.summarize(run.id, settled.hostId, settled.bundlePath)) changed = true;
      }
      if (changed) this.deps.publishSoon();
      this.release(run.id, {
        exitCode: state.exitCode,
        signal: state.signal,
        bundlePath: settled.bundlePath ?? "",
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
    if (!this.due(hostId)) return false;
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
        // Transport, not an answer: the bundle stays queued, the Mac backs off.
        this.unreached(hostId);
        this.deps.log.debug(`summarizing ${runId} failed: ${String(error)}`);
        return false;
      }
      this.reached(hostId);
      if (this.deps.isDisposed()) return false;
      switch (result.status) {
        case "pending":
          return false;
        case "unavailable":
        case "unparseable":
          // The Mac's own answer: there is nothing to read.
          this.deps.log.debug(
            `no summary for ${runId}: ${result.status === "unavailable" ? result.reason : "unparseable bundle"}`,
          );
          this.markScanned(bundlePath);
          return false;
        case "ok": {
          const folded = this.deps.engine.foldBundle(
            bundlePath,
            result.build,
            result.summary ? { ...result.summary, tests: [] } : null,
            result.tests,
            this.now(),
            hostId,
          );
          this.markScanned(bundlePath);
          return folded;
        }
      }
    } finally {
      this.summarizing.delete(runId);
    }
  }

  private markScanned(bundlePath: string): void {
    this.deps.store.markSeen(`bundle-scanned:${bundlePath}`, this.now());
  }

  // ------------------------------------------------------------- backoff

  private due(hostId: string): boolean {
    const entry = this.backoff.get(hostId);
    return entry === undefined || this.now() >= entry.retryAt;
  }

  private reached(hostId: string): void {
    this.backoff.delete(hostId);
  }

  private unreached(hostId: string): void {
    const failures = (this.backoff.get(hostId)?.failures ?? 0) + 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    this.backoff.set(hostId, { failures, retryAt: this.now() + delay });
  }

  // ----------------------------------------------------------- retention

  /**
   * Ask every Mac that may hold this plugin's builds to apply the bundle
   * retention. The list is the durable cleanup inventory, not the run table:
   * a Mac that stayed offline until its last run aged out of history still
   * gets cleaned when it is back. A Mac leaves the inventory only once it
   * reports nothing left and no run here points at it.
   */
  async prune(retention: { maxAgeMs: number; maxTotalBytes: number }): Promise<number> {
    let removed = 0;
    const hosts = new Set([
      ...this.deps.store.listCleanupHosts(),
      ...this.deps.store.listRemoteHostIds(),
    ]);
    for (const hostId of hosts) {
      if (this.deps.isDisposed()) break;
      try {
        const result = await this.deps.host.call("prune", retention, {
          hostId,
          timeoutMs: PRUNE_TIMEOUT_MS,
        });
        removed += result.removed;
        if (result.remaining === 0 && this.deps.store.countRunsOnHost(hostId) === 0) {
          this.deps.store.removeCleanupHost(hostId);
        } else {
          this.deps.store.addCleanupHost(hostId, this.now());
        }
      } catch (error) {
        // Stays in the inventory; the next prune tries again.
        this.deps.store.addCleanupHost(hostId, this.now());
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
