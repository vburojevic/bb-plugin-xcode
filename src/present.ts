/**
 * Turning a run into text for a human or a model.
 *
 * Shared by the CLI and the agent tools, which must not drift: an agent that
 * reads `bb xcode status` and one that calls `xcode_status` are asking the same
 * question and deserve the same answer. Pure, so it tests without a server.
 */

import { formatDuration } from "./duration";
import { durationMs, type Run, type RunStatus } from "./model";

/** Last path segment, with any trailing slash ignored. */
export function shortName(path: string | null): string | null {
  if (!path) return null;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

/** The best name a run has: its scheme, else its container, else its root. */
export function runName(run: Run): string {
  return (
    run.scheme ?? shortName(run.container) ?? shortName(run.root) ?? "—"
  );
}

export interface PresentOptions {
  /** Resolve a bb project id to its display name. */
  projectName?(id: string): string | null;
  /** Injected so a fixture can pin "now" when formatting a live run. */
  now?: number;
}

/** One run as a fixed-width line, as `bb xcode runs` prints them. */
export function describeRun(run: Run, options: PresentOptions = {}): string {
  const name = runName(run);
  const project = run.projectId
    ? (options.projectName?.(run.projectId) ?? run.projectId)
    : "—";
  const counts: string[] = [];
  if (run.errorCount) counts.push(`${run.errorCount}E`);
  if (run.warningCount) counts.push(`${run.warningCount}W`);
  if (run.testFailed) counts.push(`${run.testFailed} failed`);
  const suffix = counts.length ? `  [${counts.join(" ")}]` : "";
  const at = run.branch ? ` @${run.branch}` : "";
  const time =
    run.status === "running"
      ? `running ${formatDuration((options.now ?? Date.now()) - run.startedAt)}`
      : formatDuration(durationMs(run));
  return `${run.status.padEnd(9)} ${run.kind.padEnd(7)} ${(name + at).padEnd(30)} ${project.padEnd(14)} ${time}${suffix}  ${run.id}`;
}

/**
 * A one-clause verdict for a model to read.
 *
 * `xcode_build` blocks until it can say one of these, which is the entire
 * point of it: the alternative is an agent polling `xcode_status` in a loop
 * that this plugin then has to recognise and refuse to believe.
 */
export function verdictSentence(
  status: RunStatus,
  detail: { errorCount: number; testFailed: number | null; testTotal: number | null },
): string {
  switch (status) {
    case "passed":
      return detail.testTotal !== null
        ? `PASSED — ${detail.testTotal} test(s), none failed.`
        : "PASSED — build succeeded.";
    case "warnings":
      return detail.testTotal !== null
        ? `PASSED with warnings — ${detail.testTotal} test(s), none failed.`
        : "PASSED with warnings — build succeeded.";
    case "failed":
      if ((detail.testFailed ?? 0) > 0) {
        return `FAILED — ${detail.testFailed} of ${detail.testTotal ?? "?"} test(s) failed.`;
      }
      return `FAILED — ${detail.errorCount} error(s).`;
    case "cancelled":
      return "CANCELLED — the build was killed before it finished.";
    case "running":
    case "finishing":
      return "STILL RUNNING — no verdict yet.";
    case "ended":
      return "NO VERDICT — the build ended without recording an outcome.";
  }
}
