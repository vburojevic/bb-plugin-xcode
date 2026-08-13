/**
 * Launching a build this plugin can speak for.
 *
 * `bb xcode run`, `bb xcode run --wait` and the `xcode_build` agent tool are
 * three doors onto one mechanism: wrap `xcodebuild` so it writes a result
 * bundle and a live event stream, watch it, and fold its exit. They differ only
 * in whether the caller waits.
 */

import type { Collector } from "./collector";
import type { Engine } from "./engine";
import { describeExit, runWrapped } from "./runner";
import { VERDICT_STATUSES, type Run, type RunStatus } from "./model";
import { shimPaths } from "./shim";
import type { Store } from "./store";

export interface WrappedDeps {
  store: Store;
  engine: Engine;
  collector: Collector;
  dataDir: string;
  /** Aborted on dispose: stops watching without killing the user's build. */
  detachSignal: AbortSignal;
  /** Live-progress publish, already throttled by the caller. */
  publishLive(payload: Record<string, unknown>): void;
  publishSoon(): void;
  log: { info(m: string): void; warn(m: string): void };
  isDisposed(): boolean;
}

export interface WrappedOutcome {
  exitCode: number | null;
  signal: string | null;
  bundlePath: string;
  errors: number;
  warnings: number;
  /** The child never spawned — a bad binary, a bad cwd. */
  failed: boolean;
}

export interface StartedBuild {
  bundlePath: string;
  /**
   * Resolves once the child has exited AND its verdict has been folded, so a
   * caller that awaits this can read the run and get a real answer.
   * Never rejects.
   */
  completed: Promise<WrappedOutcome>;
}

/** Milliseconds between live-progress publishes while a build streams. */
const LIVE_PUBLISH_INTERVAL_MS = 500;

/**
 * Start a wrapped build and return as soon as the child has spawned.
 *
 * DELIBERATELY DETACHED from whatever asked for it: holding a CLI request open
 * for a whole build meant bb's CLI proxy timeout (~5 min, measured live on a
 * Packerly build) aborted its signal, which SIGTERM'd xcodebuild mid-build and
 * left an unfinalized result bundle. A build's lifetime belongs to the build.
 * `killSignal` is the one way to end it early, and only `xcode_build`'s own
 * timeout passes one.
 */
export async function startWrappedBuild(
  deps: WrappedDeps,
  options: { argv: readonly string[]; cwd?: string; killSignal?: AbortSignal },
): Promise<StartedBuild | null> {
  let lastLivePublishAt = 0;
  let bundlePath: string | null = null;

  let resolveStarted: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const completed = runWrapped({
    argv: options.argv,
    cwd: options.cwd,
    // Bundles go where the shim's do, so one retention policy covers every
    // bundle this plugin causes to exist.
    bundleDir: shimPaths(deps.dataDir).bundleDir,
    ...(options.killSignal ? { signal: options.killSignal } : {}),
    // Not `signal`: that SIGTERMs the child. A reload must leave the user's
    // build running and only stop us watching it.
    detachSignal: deps.detachSignal,
    onStart: (info) => {
      bundlePath = info.bundlePath;
      resolveStarted();
    },
    onEvent: (_event, progress) => {
      // Throttled: xcodebuild can emit hundreds of events per build, and every
      // publish makes each open panel refetch the full overview — N events × M
      // panels of amplification.
      const at = Date.now();
      if (at - lastLivePublishAt < LIVE_PUBLISH_INTERVAL_MS) return;
      lastLivePublishAt = at;
      deps.publishLive({
        at,
        live: {
          section: progress.currentSection,
          opened: progress.sectionsOpened,
          closed: progress.sectionsClosed,
          errors: progress.errors,
          warnings: progress.warnings,
        },
      });
    },
  })
    .then(async (result): Promise<WrappedOutcome> => {
      const outcome: WrappedOutcome = {
        exitCode: result.exitCode,
        signal: result.signal,
        bundlePath: result.bundlePath,
        errors: result.progress.errors,
        warnings: result.progress.warnings,
        failed: false,
      };
      // Lands whenever the build ends, which may be long after a reload.
      // fullScan and foldWrappedExit both reach for storage on this instance's
      // handle, so bail before touching any of it.
      if (deps.isDisposed()) return outcome;
      deps.engine.foldWrappedExit(
        result.bundlePath,
        {
          exitCode: result.exitCode,
          signal: result.signal,
          errors: result.progress.errors,
          warnings: result.progress.warnings,
        },
        Date.now(),
      );
      await deps.collector.fullScan(Date.now(), deps.detachSignal);
      if (deps.isDisposed()) return outcome;
      deps.publishSoon();
      deps.log.info(
        `wrapped build ${describeExit(result.exitCode, result.signal)}: ${result.bundlePath}`,
      );
      return outcome;
    })
    .catch((error: unknown): WrappedOutcome => {
      resolveStarted();
      if (!deps.isDisposed()) {
        deps.log.warn(`wrapped build failed to run: ${String(error)}`);
      }
      return {
        exitCode: null,
        signal: null,
        bundlePath: bundlePath ?? "",
        errors: 0,
        warnings: 0,
        failed: true,
      };
    });

  await started;
  if (!bundlePath) {
    // Keep the rejection contained; nothing is going to await it now.
    void completed;
    return null;
  }
  return { bundlePath, completed };
}

/**
 * Normalise a user/agent-supplied command into an argv this can spawn.
 *
 * A bare `xcodebuild` is rewritten to the absolute system stub so the wrapper
 * can never re-enter the PATH shim — which would add a second result bundle
 * and hand back the wrong one.
 */
export function resolveBuildArgv(commandArgs: readonly string[]): string[] {
  return commandArgs[0] === "xcodebuild"
    ? ["/usr/bin/xcodebuild", ...commandArgs.slice(1)]
    : [...commandArgs];
}

/**
 * Wait for a run to reach a status that states an outcome.
 *
 * The probe assigns a run to the process asynchronously, and the verdict can
 * arrive from any of four sources, so the honest way to answer "did it pass" is
 * to watch the store rather than to guess from one of them.
 */
export async function waitForVerdict(
  store: Store,
  match: { runId?: string; bundlePath?: string },
  options: { timeoutMs: number; pollMs?: number; signal?: AbortSignal },
): Promise<Run | null> {
  const deadline = Date.now() + options.timeoutMs;
  const poll = options.pollMs ?? 500;
  for (;;) {
    const run = match.runId
      ? store.getRun(match.runId)
      : match.bundlePath
        ? store.getRunByBundlePath(match.bundlePath)
        : null;
    if (run && VERDICT_STATUSES.has(run.status)) return run;
    if (run && run.status === "ended") return run;
    if (options.signal?.aborted || Date.now() >= deadline) return run;
    await sleep(Math.min(poll, Math.max(0, deadline - Date.now())));
  }
}

/**
 * The verdict an exit code implies, for the case where no run row exists.
 *
 * A build shorter than the probe interval can finish before `ps` ever sees it,
 * and then there is nothing in the store to report. The wrapper still knows how
 * the process died, and saying so is better than saying nothing.
 */
export function verdictFromOutcome(outcome: WrappedOutcome): RunStatus {
  if (outcome.failed) return "ended";
  if (outcome.signal !== null || outcome.exitCode === null) return "cancelled";
  if (outcome.exitCode !== 0) return "failed";
  return outcome.warnings > 0 ? "warnings" : "passed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
