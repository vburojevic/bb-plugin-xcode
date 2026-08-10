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
  formatLocation,
  kindLabel,
  runStatusLabel,
  runTitle,
  statusHint,
} from "./format";
import { isLive, statusClass, type ChatStatus, type RunDto } from "./status-types";
import { WorkerSwarm } from "./WorkerSwarm";

export function RunDetail({
  run,
  findings,
  failedTests,
  active,
}: {
  run: RunDto;
  findings: ChatStatus["findings"];
  failedTests: ChatStatus["failedTests"];
  active?: RunDto[];
}) {
  const live = isLive(run);
  const problems = findings.length > 0 || failedTests.length > 0;
  const testsBadge =
    run.testTotal !== null
      ? (run.testFailed ?? 0) > 0
        ? {
            label: `${run.testFailed} of ${run.testTotal} tests failed`,
            cls: "bbx-status-fail",
          }
        : { label: `${run.testTotal} tests passed`, cls: "bbx-status-pass" }
      : null;

  return (
    <div className="px-3 pb-2 pt-1.5">
      {statusHint(run.status) ? (
        <div className="flex items-start gap-1.5 pb-1.5 text-[11px] text-muted-foreground">
          <Icon name="Info" className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{statusHint(run.status)!.replaceAll("`", "")}</span>
        </div>
      ) : null}

      {live ? <WorkerSwarm run={run} /> : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
        <Fact label="Kind" value={kindLabel(run.kind)} />
        {run.destinationLabel ? (
          <Fact label="Destination" value={run.destinationLabel} />
        ) : null}
        {run.branch ? <Fact label="Branch" value={run.branch} mono /> : null}
        {run.worktree ? <Fact label="Checkout" value={run.worktree} /> : null}
        {run.projectName ? <Fact label="Project" value={run.projectName} /> : null}
        <Fact label="Started" value={formatClock(run.startedAt)} />
        {run.endedAt ? (
          <Fact
            label="Finished"
            value={`${formatClock(run.endedAt)} · ${formatDuration(run.durationMs)}`}
          />
        ) : null}
        {run.root ? <Fact label="Derived data" value={run.root} mono /> : null}
      </dl>

      {run.errorCount > 0 || run.warningCount > 0 || testsBadge ? (
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
          {testsBadge ? (
            <Chip
              cls={testsBadge.cls}
              icon={(run.testFailed ?? 0) > 0 ? "CircleX" : "CircleCheck"}
              label={testsBadge.label}
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
