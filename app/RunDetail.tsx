/**
 * What an activity row discloses when you open it: where it is building, how
 * hard, and what broke — in that order, so the answer to "is it stuck?" comes
 * before the answer to "did it fail?".
 */

import { Icon } from "@/components/ui/icon";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import { activityMetaClass } from "./activity-styles";
import {
  formatClock,
  formatDuration,
  basename,
  formatLocation,
  kindLabel,
  phaseLabel,
  runStatusLabel,
  runTitle,
} from "./format";
import { isLive, statusClass, type ChatStatus, type RunDto } from "./status-types";
import { WorkerSwarm } from "./WorkerSwarm";


export function RunDetail({
  run,
  findings,
  failedTests,
  recordedSnapshots = 0,
  active,
}: {
  run: RunDto;
  findings: ChatStatus["findings"];
  failedTests: ChatStatus["failedTests"];
  /** Baselines written in record mode — an outcome, not a failure. */
  recordedSnapshots?: number;
  active?: RunDto[];
}) {
  const live = isLive(run);
  const problems = findings.length > 0 || failedTests.length > 0;
  // `destinationLabel` is already resolved to "iPhone 17 Pro · iOS 26.5"; split
  // it so the device and its runtime read as two facts rather than one string.
  const [simulatorName, osVersion] = splitDestination(run.destinationLabel);
  const containerName = basename(run.container);
  // Only ever shown while live, and only while it is still positive: an
  // estimate that counts down past zero is worse than admitting the build has
  // outrun what this checkout considers usual.
  const remaining =
    live && run.typicalMs !== null
      ? Math.max(0, run.typicalMs - (Date.now() - run.startedAt)) || null
      : null;
  // `testTotal > 0`, not merely non-null: a green "0 tests passed" chip is a
  // claim of success about a run that proved nothing.
  const testsBadge =
    run.testTotal !== null && run.testTotal > 0
      ? (run.testFailed ?? 0) > 0
        ? {
            label: `${run.testFailed} of ${run.testTotal} tests failed`,
            cls: "bbx-status-fail",
          }
        : { label: `${run.testTotal} tests passed`, cls: "bbx-status-pass" }
      : null;

  return (
    <div className="max-h-72 overflow-y-auto px-3 pb-2 pt-1.5">
      {live ? <WorkerSwarm run={run} /> : null}

      {/* Identity first — the simulator and what was pointed at it. This is
          the group people actually open the row for: "which device, which
          scheme, which configuration". Paths and process detail come after,
          because they answer a rarer question. */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        {simulatorName ? <Fact label="Simulator" value={simulatorName} /> : null}
        {osVersion ? <Fact label="Runtime" value={osVersion} /> : null}
        {!simulatorName && run.destinationLabel ? (
          <Fact label="Destination" value={run.destinationLabel} />
        ) : null}
        {run.scheme ? <Fact label="Scheme" value={run.scheme} /> : null}
        {run.configuration ? (
          <Fact label="Configuration" value={run.configuration} />
        ) : null}
        <Fact label="Action" value={kindLabel(run.kind)} />
        {containerName ? <Fact label="Workspace" value={containerName} /> : null}
        {run.projectName ? <Fact label="Project" value={run.projectName} /> : null}
        {run.branch ? <Fact label="Branch" value={run.branch} mono /> : null}
        {run.worktree ? <Fact label="Checkout" value={run.worktree} /> : null}
        <Fact
          label="Started"
          value={`${formatClock(run.startedAt)}${live ? "" : ` · ${formatDuration(run.durationMs)}`}`}
        />
        {run.endedAt ? (
          <Fact label="Finished" value={formatClock(run.endedAt)} />
        ) : null}
        {live && run.phase ? (
          <Fact label="Phase" value={phaseLabel(run.phase)!} />
        ) : null}
        {live && run.currentFile ? (
          <Fact label="Current file" value={run.currentFile} mono />
        ) : null}
        {live && run.workerCount ? (
          <Fact
            label="Compilers"
            value={`${run.workerCount} running`}
          />
        ) : null}
        {run.typicalMs !== null ? (
          <Fact
            label={live ? "Usually takes" : "Usual"}
            value={
              live
                ? `${formatDuration(run.typicalMs)}${remaining !== null ? ` · ~${formatDuration(remaining)} left` : " · running long"}`
                : formatDuration(run.typicalMs)
            }
          />
        ) : null}
        {run.pid !== null ? <Fact label="Process" value={`pid ${run.pid}`} /> : null}
        {run.root ? <Fact label="Derived data" value={run.root} mono /> : null}
        {run.bundlePath ? (
          <Fact label="Result bundle" value={run.bundlePath} mono />
        ) : null}
        {run.destination && run.destination !== run.destinationLabel ? (
          <Fact label="Destination spec" value={run.destination} mono />
        ) : null}
      </dl>

      {run.errorCount > 0 ||
      run.warningCount > 0 ||
      recordedSnapshots > 0 ||
      testsBadge ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {run.errorCount > 0 ? (
            <Chip
              cls="bbx-status-fail"
              icon="CircleX"
              label={`${run.errorCount} error${run.errorCount === 1 ? "" : "s"}`}
            />
          ) : null}
          {run.warningCount > 0 ? (
            <Chip
              cls="bbx-status-warn"
              icon="AlertTriangle"
              label={`${run.warningCount} warning${run.warningCount === 1 ? "" : "s"}`}
            />
          ) : null}
          {run.analyzerCount > 0 ? (
            <Chip
              cls="bbx-status-warn"
              icon="Info"
              label={`${run.analyzerCount} analyzer`}
            />
          ) : null}
          {testsBadge ? (
            <Chip
              cls={testsBadge.cls}
              icon={(run.testFailed ?? 0) > 0 ? "CircleX" : "CircleCheck"}
              label={testsBadge.label}
            />
          ) : null}
          {recordedSnapshots > 0 ? (
            <Chip
              cls="bbx-status-run"
              icon="Layers"
              label={`${recordedSnapshots} snapshot${recordedSnapshots === 1 ? "" : "s"} recorded`}
            />
          ) : null}
          {(run.testSkipped ?? 0) > 0 ? (
            <Chip
              cls="bbx-status-muted"
              icon="CircleDashed"
              label={`${run.testSkipped} skipped`}
            />
          ) : null}
        </div>
      ) : null}

      {problems ? (
        <>
          <Separator className="my-1.5" />
          <ul className="space-y-1">
            {findings.map((finding, index) => (
              <li
                key={`f${index}`}
                className="bbx-status-fail flex items-baseline gap-2 text-[11px]"
              >
                <span className="bbx-text shrink-0 font-mono font-medium">
                  {formatLocation(finding.filePath, finding.line) ?? "error"}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {finding.message}
                </span>
              </li>
            ))}
            {failedTests.map((test, index) => (
              <li
                key={`t${index}`}
                className="bbx-status-fail flex items-baseline gap-2 text-[11px]"
              >
                <span className="bbx-text shrink-0 font-mono font-medium">
                  {test.suite ? `${test.suite}/` : ""}
                  {test.name}
                </span>
                {test.failureMessage ? (
                  <span className="min-w-0 truncate text-muted-foreground">
                    {test.failureMessage}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {active && active.length > 0 ? (
        <>
          <Separator className="my-1.5" />
          <div className="flex flex-col gap-0.5">
            {active.map((entry) => (
              <div
                key={entry.id}
                className={cn(
                  "flex items-center gap-2 text-[11px] text-muted-foreground",
                  statusClass(entry.status),
                )}
              >
                <span className="bbx-text shrink-0">{runStatusLabel(entry)}</span>
                <span className="truncate">
                  {runTitle(entry)} · {kindLabel(entry.kind)}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {formatDuration(Date.now() - entry.startedAt)}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** "iPhone 17 Pro · iOS 26.5" → ["iPhone 17 Pro", "iOS 26.5"]. */
function splitDestination(label: string | null): [string | null, string | null] {
  if (!label) return [null, null];
  const parts = label.split("·").map((part) => part.trim());
  if (parts.length < 2) return [label, null];
  return [parts[0] ?? null, parts.slice(1).join(" · ")];
}

function Fact({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <>
      <dt className={activityMetaClass("completed", "shrink-0")}>{label}</dt>
      <dd
        className={cn("min-w-0 truncate text-foreground/80", mono && "font-mono")}
        title={value}
      >
        {value}
      </dd>
    </>
  );
}

function Chip({
  cls,
  icon,
  label,
}: {
  cls: string;
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
}) {
  return (
    <span
      className={cn(
        cls,
        "bbx-chip inline-flex h-[18px] items-center gap-1 rounded-full border px-1.5 text-[10px] font-medium",
      )}
    >
      <Icon name={icon} className="size-3" aria-hidden />
      {label}
    </span>
  );
}
