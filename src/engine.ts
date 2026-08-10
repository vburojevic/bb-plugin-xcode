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

/**
 * Consecutive probe misses before a running process is considered gone.
 * One skipped `ps` sample must never end a run (the v1 flicker bug).
 */
export const MISSES_BEFORE_FINISHING = 3;

/** Window for matching an outcome artifact to a run, either side. */
export const MATCH_SLACK_MS = 90_000;

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
    const key = `manifest:${entry.uniqueIdentifier}`;
    if (!this.store.markSeen(key, now)) return false;
    if (entry.startedAt === null) return false;

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

      const verdict: RunStatus | null = isCompilePhaseOfTest
        ? entry.status === "failed"
          ? "failed"
          : null
        : entry.status;

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
      }
      this.store.updateRun(target);
      return true;
    }

    // Standalone: nothing observed overlaps. Historical or IDE-origin.
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
