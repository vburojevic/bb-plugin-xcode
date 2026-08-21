/**
 * The activity log: one unified, day-grouped list.
 *
 * Running work lives at the top inside the "Now" band and *resolves in place*
 * — the row's glyph, duration and counts change, but the row never jumps
 * between sections. Below it, history grouped by day.
 */

import { Fragment, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import {
  type BuildPhase,
  type RunKind,
  type RunStatus,
  dayLabel,
  formatClock,
  formatDuration,
  formatRelative,
  formatTime,
  kindLabel,
  phaseTail,
  runTitle,
  statusLabel,
} from "./format";
import { StatusGlyph, SweepBar } from "./primitives";

export interface RunSummary {
  id: string;
  status: RunStatus;
  kind: RunKind;
  scheme: string | null;
  container: string | null;
  root: string | null;
  destination: string | null;
  destinationLabel: string | null;
  branch: string | null;
  worktree: string | null;
  projectName: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  errorCount: number;
  warningCount: number;
  testTotal: number | null;
  testFailed: number | null;
  workerCount: number | null;
  phase?: BuildPhase | null;
}

export function isActive(run: RunSummary): boolean {
  return run.status === "running" || run.status === "finishing";
}

/**
 * Ticks once a second while anything is active, and once a minute otherwise.
 *
 * The idle tick is not decoration: `now` drives every "5m ago", the
 * clock-vs-relative switch and the "Today" day groups, and a panel left open
 * overnight with no builds used to keep all three frozen at mount time —
 * yesterday's runs under "Today", "5m ago" forever.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), active ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function RunLog({
  runs,
  selectedId,
  onSelect,
}: {
  runs: RunSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const active = runs.filter(isActive);
  const done = runs.filter((run) => !isActive(run));
  const now = useNow(active.length > 0);

  return (
    <div className="flex flex-col">
      {active.length > 0 ? (
        <section aria-label="Building now" className="flex flex-col pb-1">
          {active.map((run) => (
            <NowRow
              key={run.id}
              run={run}
              now={now}
              selected={run.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </section>
      ) : null}

      {groupByDay(done, now).map(({ label, rows }) => (
        <Fragment key={label}>
          <h3 className="sticky top-0 z-10 bg-background/95 px-2.5 pb-1 pt-3 text-xs font-medium text-muted-foreground backdrop-blur-sm">
            {label}
          </h3>
          <ul className="flex flex-col" role="list">
            {rows.map((run) => (
              <li key={run.id}>
                <LogRow
                  run={run}
                  now={now}
                  selected={run.id === selectedId}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
    </div>
  );
}

function groupByDay(
  runs: RunSummary[],
  now: number,
): Array<{ label: string; rows: RunSummary[] }> {
  const groups: Array<{ label: string; rows: RunSummary[] }> = [];
  for (const run of runs) {
    const label = dayLabel(run.startedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(run);
    else groups.push({ label, rows: [run] });
  }
  return groups;
}

/**
 * A run in flight. Bigger than a log row — this is the answer to "what is
 * Xcode doing right now" and earns the panel's one piece of real emphasis.
 */
function NowRow({
  run,
  now,
  selected,
  onSelect,
}: {
  run: RunSummary;
  now: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const finishing = run.status === "finishing";
  const elapsed = Math.max(0, (finishing ? (run.endedAt ?? now) : now) - run.startedAt);
  const detail = [
    run.projectName,
    run.branch,
    run.destinationLabel ?? run.destination,
    // Worker count when there is work to count, otherwise what the build is
    // doing. A resolve has no workers at all, and this is the row that is
    // meant to answer "what is Xcode doing right now".
    run.workerCount
      ? `${run.workerCount} compilers`
      : phaseTail(run.phase ?? null),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full flex-col gap-2 rounded-lg border border-border px-3 py-2.5 text-left",
        "transition-colors duration-150 hover:border-primary/40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "border-primary/50 bg-muted/40",
      )}
    >
      <div className="flex items-center gap-2.5">
        <StatusGlyph status={run.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {runTitle(run)}
          <span className="ml-2 font-normal text-muted-foreground">
            {kindLabel(run.kind)}
          </span>
        </span>
        <span
          className={cn(
            "shrink-0 text-sm tabular-nums",
            finishing ? "text-muted-foreground" : "text-primary",
          )}
        >
          {finishing ? "finishing…" : formatDuration(elapsed)}
        </span>
      </div>
      <SweepBar label={`${kindLabel(run.kind)} in progress`} />
      {detail ? (
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      ) : null}
    </button>
  );
}

function LogRow({
  run,
  now,
  selected,
  onSelect,
}: {
  run: RunSummary;
  now: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const context = [
    run.projectName,
    run.branch,
    run.destinationLabel ?? run.destination,
  ]
    .filter(Boolean)
    .join(" · ");
  const recent = now - run.startedAt < 43_200_000; // < 12h: clock time reads best

  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left",
        "transition-colors duration-150 hover:bg-muted/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-muted",
      )}
    >
      <StatusGlyph status={run.status} />
      {/* The glyph is aria-hidden and the counts are bare numbers, so without
          this a passed, cancelled and no-result row all read identically to a
          screen reader. */}
      <span className="sr-only">{statusLabel(run.status)}</span>

      <span className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
        {/* The scheme always wins the shrink war: a row reading "I.. test
            perf/cache-po…" had truncated the one thing that identifies it
            while spelling out the context in full. */}
        <span className="max-w-[11rem] shrink-0 truncate text-sm text-foreground">
          {runTitle(run)}
        </span>
        {runTitle(run) !== "Xcode activity" ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {kindLabel(run.kind)}
          </span>
        ) : null}
        {context ? (
          <span className="hidden min-w-0 truncate text-xs text-muted-foreground/80 sm:inline">
            {context}
          </span>
        ) : null}
      </span>

      <Counts run={run} />

      <span className="w-14 shrink-0 text-right text-sm tabular-nums text-foreground/90">
        {formatDuration(run.durationMs)}
      </span>
      <span
        className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
        title={formatClock(run.startedAt)}
      >
        {recent ? formatTime(run.startedAt) : formatRelative(run.startedAt, now)}
      </span>
    </button>
  );
}

/** Renders only what is non-zero — silence is the good case. */
function Counts({ run }: { run: RunSummary }) {
  if (run.testFailed) {
    return (
      <span className="shrink-0 text-xs tabular-nums text-destructive">
        {run.testFailed} failed
      </span>
    );
  }
  if (run.errorCount) {
    return (
      <span className="shrink-0 text-xs tabular-nums text-destructive">
        {run.errorCount}E
      </span>
    );
  }
  if (run.warningCount) {
    return (
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {run.warningCount}W
      </span>
    );
  }
  if (run.testTotal) {
    return (
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {run.testTotal} tests
      </span>
    );
  }
  return null;
}
