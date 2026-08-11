/**
 * The reconciler — the single writer.
 *
 * Sources (process probe, log-store manifests, result bundles) are reduced to
 * plain observations; this engine folds them into the store under one set of
 * rules. Nothing else writes runs, which is precisely what v1 lacked: with
 * three writers and a correlator, every source could contradict another.
 *
 * The rules live in `model.ts` (rank lattice, monotonic lifecycle). This file
 * applies them.
 */

import {
  FINISHING_TIMEOUT_MS,
  RANK,
  type Run,
  type RunKind,
  type RunStatus,
  VERDICT_STATUSES,
  statusTransitionAllowed,
} from "./model";
import type { Store } from "./store";
import type { LiveActivity } from "./types";
import type { BuildResults, TestResults } from "./types";
import type { BackgroundCommandOutcome } from "./thread-outcome";

/**
 * Consecutive probe misses before a running process is considered gone.
 * One skipped `ps` sample must never end a run (the v1 flicker bug).
 */
export const MISSES_BEFORE_FINISHING = 3;

/** Window for matching an outcome artifact to a run, either side. */
export const MATCH_SLACK_MS = 90_000;

/**
 * How far before its launcher's own start a run may begin and still count as
 * launched by it. Process start times come from `ps` etime, which is only
 * second-resolution, so a build that really did start after the command can
 * read as a shade earlier.
 */
export const LAUNCH_SLACK_MS = 5_000;

/**
 * Commands that WATCH a build rather than run one. Their exit status describes
 * the poll loop and must never become a build's verdict — the shapes here are
 * taken from real agent transcripts (`until ! bb xcode status …; do sleep 5;
 * done`, `until pgrep -f xcodebuild; …`).
 */
const WATCHER_RE =
  /\b(?:until|while)\s|\bpgrep\b|\bpkill\b|\bbb\s+xcode\s+(?:status|show|runs|stop)\b|\bsleep\s+\d/i;

/**
 * Commands that plausibly LAUNCH one. Deliberately broad — agents build via
 * bare xcodebuild, wrapper scripts, make, swift, fastlane and xcrun — because
 * the temporal containment check is what does the real narrowing. Its only job
 * is to keep an unrelated long-running command (a dev server, a watch task)
 * from adopting a build that happened to run inside it.
 */
const BUILDER_RE =
  /\bxcodebuild(?:mcp)?\b|\bbb\s+xcode\s+run\b|\.sh\b|\bmake\b|\bswift\s+(?:build|test)\b|\bfastlane\b|\bxcrun\b/i;

/** A command whose exit code is allowed to speak for a build's outcome. */
export function looksLikeBuildLauncher(command: string): boolean {
  return BUILDER_RE.test(command) && !WATCHER_RE.test(command);
}

export interface EngineHooks {
  /** Resolve which bb project owns a path, most specific wins. */
  projectFor(signals: {
    root?: string | null;
    cwd?: string | null;
    container?: string | null;
  }): string | null;
  /** Resolve which bb thread's environment contains a path, if any. */
  threadFor(signals: {
    root?: string | null;
    cwd?: string | null;
    container?: string | null;
  }): string | null;
  /** Notify the host when a newly observed process becomes a tracked run. */
  onRunStarted?(run: Run): void;
  log(message: string): void;
}

interface LiveEntry {
  runId: string;
  misses: number;
  lastSeenAt: number;
}

export class Engine {
  /** Keyed by pid — the probe's identity for a live activity. */
  private readonly live = new Map<number, LiveEntry>();

  constructor(
    private readonly store: Store,
    private readonly hooks: EngineHooks,
  ) {}

  /** Re-adopt unresolved runs after a reload instead of killing them. */
  hydrate(now: number): void {
    for (const run of this.store.listUnresolved()) {
      if (run.status === "running" && run.pid !== null) {
        this.live.set(run.pid, { runId: run.id, misses: 0, lastSeenAt: now });
      }
    }
  }

  /** True while anything is running or awaiting its verdict. */
  hasOpenRuns(): boolean {
    return this.store.listUnresolved().length > 0;
  }

  liveWorkerCount(runId: string, activities: readonly LiveActivity[]): number | null {
    for (const [pid, entry] of this.live) {
      if (entry.runId !== runId) continue;
      return activities.find((a) => a.pid === pid)?.workerCount ?? null;
    }
    return null;
  }

  // ------------------------------------------------------------- probe fold

  /**
   * Fold one probe snapshot. Returns true when persisted state changed.
   */
  foldSnapshot(activities: readonly LiveActivity[], now: number): boolean {
    let changed = false;
    const seenPids = new Set<number>();

    for (const activity of activities) {
      seenPids.add(activity.pid);
      const tracked = this.live.get(activity.pid);
      if (tracked) {
        tracked.misses = 0;
        tracked.lastSeenAt = now;
        continue;
      }

      const root = activity.derivedDataPath ?? activity.roots[0] ?? null;
      const run: Run = {
        id: `r:${activity.pid}:${Math.round(activity.startedAt / 1000)}`,
        status: "running",
        statusRank: RANK.observed,
        kind: activity.kind,
        scheme: activity.scheme,
        container: activity.container,
        configuration: activity.configuration,
        destination: activity.destination,
        projectId: this.hooks.projectFor({
          root,
          cwd: activity.cwd,
          container: activity.container,
        }),
        root,
        cwd: activity.cwd,
        pid: activity.pid,
        cmdline: activity.args.slice(0, 4000),
        startedAt: activity.startedAt,
        endedAt: null,
        errorCount: 0,
        warningCount: 0,
        analyzerCount: 0,
        testTotal: null,
        testFailed: null,
        testSkipped: null,
        bundlePath: activity.resultBundlePath,
        detailed: false,
        branch: activity.branch ?? null,
        worktree: activity.worktree ?? null,
        threadId: this.hooks.threadFor({
          root,
          cwd: activity.cwd,
          container: activity.container,
        }),
      };
      this.store.insertRun(run);
      this.live.set(activity.pid, { runId: run.id, misses: 0, lastSeenAt: now });
      this.hooks.log(`run started: ${run.kind} ${run.scheme ?? "?"} (${run.id})`);
      this.hooks.onRunStarted?.(run);
      changed = true;
    }

    // Hysteresis: only repeated absence moves a run to `finishing`, and the
    // end time is when the process was last SEEN — our detection grace is
    // never billed to the build.
    for (const [pid, entry] of [...this.live]) {
      if (seenPids.has(pid)) continue;
      entry.misses += 1;
      if (entry.misses < MISSES_BEFORE_FINISHING) continue;

      this.live.delete(pid);
      const run = this.store.getRun(entry.runId);
      if (!run) continue;
      if (
        statusTransitionAllowed(
          { status: run.status, rank: run.statusRank },
          { status: "finishing", rank: RANK.observed },
        )
      ) {
        run.status = "finishing";
        run.statusRank = RANK.observed;
        run.endedAt ??= entry.lastSeenAt;
        this.store.updateRun(run);
        this.hooks.log(`run finishing: ${run.id}`);
        changed = true;
      }
    }

    return changed;
  }

  /**
   * Time out `finishing` runs into the terminal, verdict-less `ended`.
   * The panel then says "Ended" (with the shim hint) instead of spinning.
   */
  expireFinishing(now: number): boolean {
    let changed = false;
    for (const run of this.store.listUnresolved()) {
      if (run.status !== "finishing") continue;
      const since = run.endedAt ?? run.startedAt;
      if (now - since < FINISHING_TIMEOUT_MS) continue;
      run.status = "ended";
      run.statusRank = RANK.observed;
      this.store.updateRun(run);
      changed = true;
    }
    return changed;
  }

  // ------------------------------------------------------ wrapped-exit fold

  /**
   * Fold the exit of a build the plugin itself spawned (`bb xcode run`).
   *
   * The exit status plus the live stream's tallies are an honest RANK.logged
   * verdict the moment the process dies — a `.xcresult` parse can still
   * upgrade it to verified later, but a killed or bundle-less build no longer
   * dangles in "finishing" (or worse, reads as passed: a signaled child's
   * `code` is null, which once mapped to 0).
   */
  foldWrappedExit(
    bundlePath: string,
    outcome: {
      exitCode: number | null;
      signal: string | null;
      errors: number;
      warnings: number;
    },
    now: number,
  ): boolean {
    const target = this.store
      .listRuns({ limit: 50 })
      .find((run) => run.bundlePath === bundlePath);
    if (!target) return false;

    const verdict: RunStatus =
      outcome.signal !== null || outcome.exitCode === null
        ? "cancelled"
        : outcome.exitCode === 0
          ? outcome.warnings > 0
            ? "warnings"
            : "passed"
          : "failed";

    target.errorCount = Math.max(target.errorCount, outcome.errors);
    target.warningCount = Math.max(target.warningCount, outcome.warnings);
    if (
      !statusTransitionAllowed(
        { status: target.status, rank: target.statusRank },
        { status: verdict, rank: RANK.logged },
      )
    ) {
      this.store.updateRun(target);
      return false;
    }
    target.status = verdict;
    target.statusRank = RANK.logged;
    target.endedAt ??= now;
    for (const [pid, live] of this.live) {
      if (live.runId === target.id) this.live.delete(pid);
    }
    this.store.updateRun(target);
    this.hooks.log(`verdict from wrapped exit: ${verdict} (${target.id})`);
    return true;
  }

  /**
   * Fold BB's terminal background-command exit into the Xcode children that
   * ran inside it. This is the only verdict source for agent-launched shell
   * and XcodeBuildMCP builds, which never write an `.xcresult` of their own.
   *
   * The previous implementation matched by string archaeology — it looked for
   * an absolute path from the run inside `${cwd}\n${command}`, or for the
   * literal word `xcodebuild`. Measured against production data, both arms
   * failed:
   *
   *  - bb reports `cwd: ""` on every `commandExecution` item, and agents write
   *    relative commands (`./scripts/build_app.sh build …`), so the haystack
   *    contained no absolute path at all and the path arm could never match.
   *    The same build resolved or not purely on whether the agent happened to
   *    prefix `cd /abs/path &&` — a verdict decided by shell style.
   *  - the `xcodebuild` arm skipped the path check entirely, so a *watcher*
   *    ("wait until my worktree's xcodebuild processes exit") was one
   *    single-candidate window away from stamping its own exit 0 onto a build
   *    that had actually failed.
   *
   * So the discriminator is no longer "does this text mention the run" but
   * "could this command have LAUNCHED a build, and does the run sit wholly
   * inside its lifetime":
   *
   *  - watchers are rejected outright; their exit code describes the poll
   *    loop, never the build;
   *  - a launched build cannot predate its launcher, so the run must start
   *    after the command did;
   *  - a build whose verdict this command can speak for must also have ENDED
   *    before it did. This is what keeps a `foo &`-style backgrounded build,
   *    still running after its launcher returned, from being called passed.
   *
   * The cost matrix is deliberately lopsided. A missed verdict leaves a run at
   * the honest "ended"; a wrong one reports a failed build as green. Every
   * ambiguity here resolves toward silence.
   */
  foldThreadCommandExit(
    outcome: BackgroundCommandOutcome & { threadId: string },
    now: number,
  ): boolean {
    if (!looksLikeBuildLauncher(outcome.command)) return false;

    const contained = this.store
      .listRuns({ limit: 500, includeNoise: true })
      .filter((run) => run.threadId === outcome.threadId)
      .filter((run) => !VERDICT_STATUSES.has(run.status))
      .filter((run) => run.startedAt >= outcome.startedAt - LAUNCH_SLACK_MS)
      .filter(
        (run) =>
          run.endedAt !== null &&
          run.endedAt <= outcome.endedAt + MATCH_SLACK_MS,
      )
      .sort((a, b) => a.startedAt - b.startedAt);
    if (contained.length === 0) return false;

    // A zero exit vouches for every build the command ran; a failure or a kill
    // only tells us about the one it died on, which is the last to have run.
    const last = contained[contained.length - 1]!;
    const verdicts: Array<[Run, RunStatus]> = outcome.interrupted
      ? [[last, "cancelled"]]
      : outcome.exitCode === 0
        ? contained.map((run): [Run, RunStatus] => [run, "passed"])
        : [[last, "failed"]];

    let changed = false;
    for (const [target, verdict] of verdicts) {
      if (
        !statusTransitionAllowed(
          { status: target.status, rank: target.statusRank },
          { status: verdict, rank: RANK.logged },
        )
      ) {
        continue;
      }
      target.status = verdict;
      target.statusRank = RANK.logged;
      target.endedAt ??= Math.min(outcome.endedAt, now);
      for (const [pid, live] of this.live) {
        if (live.runId === target.id) this.live.delete(pid);
      }
      this.store.updateRun(target);
      this.hooks.log(
        `verdict from thread command exit: ${verdict} (${target.id})`,
      );
      changed = true;
    }
    return changed;
  }

  /**
   * A run whose process is gone but whose declared result bundle never got a
   * root Info.plist was killed or crashed: xcodebuild finalizes the bundle on
   * every normal exit, including failures (verified on disk 2026-08-10 — a
   * SIGTERM'd build leaves only Data/). "Cancelled" is the honest verdict,
   * and it replaces the verdict-less "ended" that read as tracker confusion.
   */
  foldAbandonedBundle(runId: string, now: number): boolean {
    const run = this.store.getRun(runId);
    if (!run) return false;
    if (
      !statusTransitionAllowed(
        { status: run.status, rank: run.statusRank },
        { status: "cancelled", rank: RANK.observed },
      )
    ) {
      return false;
    }
    run.status = "cancelled";
    run.statusRank = RANK.observed;
    run.endedAt ??= now;
    this.store.updateRun(run);
    this.hooks.log(`verdict from abandoned bundle: cancelled (${run.id})`);
    return true;
  }

  // ---------------------------------------------------------- manifest fold

  /**
   * Fold one log-store entry (Build or Test domain only — measured on a real
   * machine, the Package domain carries no build outcomes, only "Resolve
   * Packages" noise that v1 famously mis-correlated).
   *
   * A manifest entry ENRICHES the overlapping run. It creates a standalone
   * run only when nothing overlaps — an IDE build from before the plugin
   * loaded, for example.
   */
  foldManifestEntry(
    root: string,
    domainKind: "build" | "test",
    entry: {
      uniqueIdentifier: string;
      title: string | null;
      scheme: string | null;
      startedAt: number | null;
      endedAt: number | null;
      status: RunStatus;
      errorCount: number;
      warningCount: number;
      analyzerCount: number;
      testFailureCount: number;
    },
    now: number,
  ): boolean {
    if (entry.startedAt === null) return false;
    const key = `manifest:${entry.uniqueIdentifier}`;
    if (this.store.hasSeen(key)) return false;

    const candidates = this.store
      .findVerdictCandidates(entry.startedAt, MATCH_SLACK_MS)
      .filter((run) => !run.root || run.root === root)
      .filter((run) => domainCompatible(domainKind, run.kind));

    const target = candidates[0] ?? null;

    if (target) {
      // A test run's compile phase writes a Build entry whose status covers
      // only that phase — adopt its counts, and its verdict only when it is
      // a failure (compile failed ⇒ the whole run failed) or when the run
      // really is a plain build.
      const isCompilePhaseOfTest = target.kind === "test" && domainKind === "build";
      target.errorCount = Math.max(target.errorCount, entry.errorCount);
      target.warningCount = Math.max(target.warningCount, entry.warningCount);
      target.analyzerCount = Math.max(target.analyzerCount, entry.analyzerCount);
      target.scheme ??= entry.scheme;
      target.root ??= root;

      // A live process has not finished, whatever a log entry claims. One
      // invocation writes an entry per action, so the clean phase of
      // `clean build` — or the compile phase of a test run — would otherwise
      // finalize the whole run as passed while it is still compiling.
      // A failure is different: a phase that failed sinks the run for real.
      const stillAlive = target.status === "running";
      const verdict: RunStatus | null =
        isCompilePhaseOfTest || stillAlive
          ? entry.status === "failed"
            ? "failed"
            : null
          : entry.status;

      /**
       * Look, decline, come back.
       *
       * Xcode writes the manifest the instant xcodebuild exits — routinely a
       * few seconds BEFORE this plugin's `ps` hysteresis concedes the process
       * is gone. Consuming the entry at that moment (which is what `markSeen`
       * at the top of this function used to do) threw away the only
       * launcher-independent verdict the plugin has: the run was still
       * `running`, so `stillAlive` suppressed the outcome, the entry was
       * marked seen, and no later sweep looked at it again. The run then timed
       * out of `finishing` into a permanent, verdict-less `ended`.
       *
       * Measured before the fix: ZERO manifest verdicts had ever been
       * recorded on this machine, against 10 from abandoned bundles and 3 from
       * launcher exits. The entry that would have resolved the run in the bug
       * report was consumed 2.9 seconds before that run left `running`.
       *
       * Counts are still adopted on the early pass — they are only ever
       * revised upward, so re-reading is harmless — but the entry stays
       * unseen until its verdict could actually be applied. That converges
       * within seconds, because the probe always moves a dead process out of
       * `running`.
       */
      const tooEarly = stillAlive && verdict === null;
      if (!tooEarly) this.store.markSeen(key, now);

      if (
        verdict &&
        VERDICT_STATUSES.has(verdict) &&
        statusTransitionAllowed(
          { status: target.status, rank: target.statusRank },
          { status: verdict, rank: RANK.logged },
        )
      ) {
        target.status = verdict;
        target.statusRank = RANK.logged;
        target.endedAt ??= entry.endedAt ?? now;
        for (const [pid, live] of this.live) {
          if (live.runId === target.id) this.live.delete(pid);
        }
        this.hooks.log(`verdict from manifest: ${verdict} (${target.id})`);
      }
      this.store.updateRun(target);
      return true;
    }

    // Standalone: nothing observed overlaps. Historical or IDE-origin.
    this.store.markSeen(key, now);
    const run: Run = {
      id: `m:${entry.uniqueIdentifier}`,
      status: VERDICT_STATUSES.has(entry.status) ? entry.status : "ended",
      statusRank: RANK.logged,
      kind: domainKind,
      scheme: entry.scheme,
      container: null,
      configuration: null,
      destination: null,
      projectId: this.hooks.projectFor({ root }),
      root,
      cwd: null,
      pid: null,
      cmdline: null,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      errorCount: entry.errorCount,
      warningCount: entry.warningCount,
      analyzerCount: entry.analyzerCount,
      testTotal: null,
      testFailed: domainKind === "test" ? entry.testFailureCount : null,
      testSkipped: null,
      bundlePath: null,
      detailed: false,
      branch: null,
      worktree: null,
      threadId: null,
    };
    this.store.insertRun(run);
    return true;
  }

  // ------------------------------------------------------------ bundle fold

  /**
   * Fold a parsed `.xcresult`. The bundle is ground truth (rank: verified):
   * it attaches to the overlapping run, or the run that already claims the
   * bundle path, and sets the final verdict, findings, and per-test rows.
   */
  foldBundle(
    bundlePath: string,
    build: BuildResults | null,
    tests: TestResults | null,
    testCases: readonly {
      suite: string | null;
      name: string;
      status: "passed" | "failed" | "skipped" | "expected-failure" | "unknown";
      durationMs: number | null;
      failureMessage: string | null;
      target: string | null;
    }[],
    now: number,
  ): boolean {
    if (!build && !tests) return false;
    const anchor =
      tests?.startedAt ?? build?.startedAt ?? tests?.endedAt ?? build?.endedAt;
    if (!anchor) return false;

    // Prefer the run that already recorded this bundle path (wrapper/`bb
    // xcode run` case), else window-match.
    const byPath = this.store
      .listRuns({ limit: 50 })
      .find((run) => run.bundlePath === bundlePath);
    const target =
      byPath ??
      this.store
        .findVerdictCandidates(anchor, MATCH_SLACK_MS)
        .filter((run) => run.kind !== "index")[0] ??
      null;
    if (!target) return false;

    const key = `bundle:${bundlePath}:${target.id}`;
    if (!this.store.markSeen(key, now)) return false;

    target.bundlePath = bundlePath;

    if (build) {
      target.errorCount = build.errorCount;
      target.warningCount = build.warningCount;
      target.analyzerCount = build.analyzerCount;
      target.destination ??= build.destination;
      this.store.replaceFindings(
        target.id,
        build.issues
          .filter((issue) => issue.severity !== "note")
          .map((issue) => ({
            runId: target.id,
            severity: issue.severity as "error" | "warning" | "analyzer",
            message: issue.message,
            filePath: issue.filePath,
            line: issue.line,
            target: issue.target,
          })),
      );
      target.detailed = true;
    }

    let verdict: RunStatus | null = build ? build.status : null;

    if (tests && tests.total > 0) {
      target.kind = "test";
      target.testTotal = tests.total;
      target.testFailed = tests.failed;
      target.testSkipped = tests.skipped;
      target.destination ??= tests.destination;
      verdict = tests.status; // test outcome outranks the compile phase
      this.store.replaceTests(
        target.id,
        testCases.map((test) => ({ ...test, runId: target.id })),
      );
      target.detailed = true;
    }

    // Same rule as the manifest fold: a bundle written by one action of a
    // still-running invocation describes that action, not the whole run.
    // Only a failure is allowed to speak early.
    if (target.status === "running" && verdict !== "failed") {
      verdict = null;
    }

    if (
      verdict &&
      VERDICT_STATUSES.has(verdict) &&
      statusTransitionAllowed(
        { status: target.status, rank: target.statusRank },
        { status: verdict, rank: RANK.verified },
      )
    ) {
      target.status = verdict;
      target.statusRank = RANK.verified;
      target.endedAt ??= tests?.endedAt ?? build?.endedAt ?? now;
      for (const [pid, live] of this.live) {
        if (live.runId === target.id) this.live.delete(pid);
      }
    }

    this.store.updateRun(target);
    this.hooks.log(`verdict from bundle: ${target.status} (${target.id})`);
    return true;
  }
}

/** Which log domain may speak about which run kind. */
export function domainCompatible(
  domain: "build" | "test",
  kind: RunKind,
): boolean {
  if (domain === "test") return kind === "test" || kind === "unknown";
  return kind !== "index" && kind !== "package";
}
