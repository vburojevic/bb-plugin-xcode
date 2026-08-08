/**
 * The domain model, v2.
 *
 * The previous architecture let three sources (process probe, log-store
 * manifests, result bundles) each CREATE run rows, then tried to correlate
 * them afterwards. Every field bug traced back to that correlation: duplicate
 * rows, a "Resolve Packages" log hijacking a build's identity, log spans
 * clobbering true durations.
 *
 * v2 inverts it: **one run, one identity, monotonic enrichment.**
 *
 *  - A run is born from a process observation (or, rarely, from a log entry
 *    when no process was observed — an IDE build while the plugin was down).
 *  - Other sources never create competing rows; they *enrich* the existing
 *    run, and every enrichment carries a confidence rank that can only go up.
 *  - The lifecycle is explicit and one-directional:
 *
 *        running ─→ finishing ─→ passed | warnings | failed | cancelled
 *                        │
 *                        └─(no verdict arrives)─→ ended
 *
 *    "finishing" is the window after the process exits while we wait for a
 *    verdict. It resolves or times out to "ended" — never a permanent
 *    "Unknown", which read as the tracker malfunctioning.
 */

/** Where a fact came from, ordered by trustworthiness. */
export const RANK = {
  /** Seen via `ps` — existence, timing, argv. */
  observed: 0,
  /** Xcode's own log store wrote a summary. */
  logged: 1,
  /** Parsed from a `.xcresult` — the ground truth for outcomes. */
  verified: 2,
} as const;

export type Rank = (typeof RANK)[keyof typeof RANK];

export type RunStatus =
  | "running"
  | "finishing"
  | "passed"
  | "warnings"
  | "failed"
  | "cancelled"
  | "ended";

/** Statuses that end a run's life. Nothing may follow them but a higher rank. */
export const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set([
  "passed",
  "warnings",
  "failed",
  "cancelled",
  "ended",
]);

/** A verdict is a terminal status that states an actual outcome. */
export const VERDICT_STATUSES: ReadonlySet<RunStatus> = new Set([
  "passed",
  "warnings",
  "failed",
  "cancelled",
]);

export type RunKind =
  | "build"
  | "test"
  | "archive"
  | "clean"
  | "analyze"
  | "install"
  | "export"
  | "docbuild"
  | "package"
  | "index"
  | "unknown";

export interface Run {
  id: string;
  status: RunStatus;
  /** Rank of the source that set the current status. */
  statusRank: Rank;
  kind: RunKind;
  scheme: string | null;
  container: string | null;
  configuration: string | null;
  destination: string | null;
  projectId: string | null;
  root: string | null;
  cwd: string | null;
  pid: number | null;
  cmdline: string | null;
  startedAt: number;
  endedAt: number | null;
  errorCount: number;
  warningCount: number;
  analyzerCount: number;
  testTotal: number | null;
  testFailed: number | null;
  testSkipped: number | null;
  bundlePath: string | null;
  /** True once findings/tests were extracted from a bundle. */
  detailed: boolean;
  /** Git branch (or short detached SHA) of the source checkout. */
  branch: string | null;
  /** Human name of the checkout/worktree directory the build ran from. */
  worktree: string | null;
}

export interface Finding {
  runId: string;
  severity: "error" | "warning" | "analyzer";
  message: string;
  filePath: string | null;
  line: number | null;
  target: string | null;
}

export interface TestCase {
  runId: string;
  suite: string | null;
  name: string;
  status: "passed" | "failed" | "skipped" | "expected-failure" | "unknown";
  durationMs: number | null;
  failureMessage: string | null;
  target: string | null;
}

/**
 * May `next` replace `current` as the run's status?
 *
 * The rules that killed v1's bug classes, stated once:
 *  - higher rank always wins;
 *  - at equal rank, life only moves forward (no terminal → running);
 *  - a verdict is never displaced by a non-verdict of the same rank.
 */
export function statusTransitionAllowed(
  current: { status: RunStatus; rank: Rank },
  next: { status: RunStatus; rank: Rank },
): boolean {
  if (next.rank > current.rank) return true;
  if (next.rank < current.rank) return false;

  const currentTerminal = TERMINAL_STATUSES.has(current.status);
  const nextTerminal = TERMINAL_STATUSES.has(next.status);

  if (!currentTerminal) {
    // running → finishing → any terminal; also running → running (no-op ok).
    if (current.status === "finishing" && next.status === "running") return false;
    return true;
  }

  // Terminal already. Same-rank upgrades allowed only from the verdict-less
  // "ended" to a real verdict.
  if (current.status === "ended" && VERDICT_STATUSES.has(next.status)) {
    return true;
  }
  return currentTerminal && nextTerminal && false;
}

/** Duration is always derived, never stored from a source's own log span. */
export function durationMs(run: Pick<Run, "startedAt" | "endedAt">): number | null {
  if (run.endedAt === null) return null;
  return Math.max(0, run.endedAt - run.startedAt);
}

/**
 * How long a run may sit in "finishing" before it becomes "ended".
 *
 * Long enough for the post-exit sweep and a shim bundle to arrive; short
 * enough that the panel never shows a stuck spinner for a build that will
 * clearly never report.
 */
export const FINISHING_TIMEOUT_MS = 45_000;
