/**
 * Shared shape of the `chatStatus` rpc output.
 *
 * Lifted out of ChatCard so the composer banner and the message directive
 * render the same runs from the same contract without importing each other.
 */

import type { BuildPhase } from "../src/types";

export type { BuildPhase };

export type RunDto = {
  id: string;
  status:
    | "running"
    | "finishing"
    | "passed"
    | "warnings"
    | "failed"
    | "cancelled"
    | "ended";
  kind:
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
  scheme: string | null;
  container: string | null;
  destination: string | null;
  destinationLabel: string | null;
  root: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  configuration: string | null;
  cwd: string | null;
  pid: number | null;
  bundlePath: string | null;
  errorCount: number;
  warningCount: number;
  analyzerCount: number;
  testTotal: number | null;
  testFailed: number | null;
  testSkipped: number | null;
  branch: string | null;
  worktree: string | null;
  workerCount: number | null;
  // Imported, not re-spelled: this union had drifted from `src/types.ts` and
  // silently dropped whichever phase was added last.
  phase: BuildPhase | null;
  currentFile: string | null;
  typicalMs: number | null;
  projectName: string | null;
};

export type ChatStatus = {
  /** Whether the thread banner should render at all. Data flows either way. */
  showActivity: boolean;
  run: RunDto | null;
  active: RunDto[];
  recent: RunDto[];
  /** Newest settled, undismissed run — what the banner shows when idle. */
  lastSettled: RunDto | null;
  /** Snapshot baselines written by this run (record mode), not failures. */
  recordedSnapshots: number;
  scope: {
    threadId: string;
    path: string;
    branch: string | null;
    worktree: string | null;
  } | null;
  findings: Array<{
    severity: "error" | "warning" | "analyzer";
    message: string;
    filePath: string | null;
    line: number | null;
    target: string | null;
  }>;
  failedTests: Array<{
    suite: string | null;
    name: string;
    status: string;
    durationMs: number | null;
    failureMessage: string | null;
    target: string | null;
  }>;
};

/** Statuses whose run is still in flight. */
export const LIVE = new Set<RunDto["status"]>(["running", "finishing"]);

export function isLive(run: RunDto): boolean {
  return LIVE.has(run.status);
}

/** Xcode status vocabulary → theme-blended color class (app.css). */
export function statusClass(status: RunDto["status"]): string {
  switch (status) {
    case "running":
    case "finishing":
      return "bbx-status-run";
    // Warnings are a SUCCESS state: green verdict, yellow count chip. The
    // caution lives on the chip, never on the verdict itself.
    case "passed":
    case "warnings":
      return "bbx-status-pass";
    case "failed":
      return "bbx-status-fail";
    default:
      return "bbx-status-muted";
  }
}
