/**
 * The activity row — one build, one line where it fits, never a collision.
 *
 * Two rules fight here and both win:
 *
 *  1. The FRAME is the host's. Geometry, radius, surface and rhythm come from
 *     `PromptStackCard` (see `.bbx-stack-card` in app.css) so the row sits in
 *     bb's prompt stack as a peer of "Running background command".
 *  2. The CONTENTS are ours. State leads as a filled pill in the run's own
 *     colour — BUILDING, SUCCEEDED, FAILED — because in a stack of neutral
 *     grey rows the one fact a build has that a shell command doesn't is an
 *     outcome, and it should be readable before anything else.
 *
 * ## Why it wraps instead of truncating
 *
 * The fields are variable-length and unbounded: a scheme, a simulator name and
 * OS, a branch that can run fifty characters. Held on one line with `shrink-0`
 * they overlapped on a narrow composer — text drawn over text, which is worse
 * than either truncation or wrapping. So the meta group is a wrapping flex
 * row: one line when it fits, growing to at most three when it does not, each
 * field truncating individually rather than shoving its neighbour. Past three
 * lines the row clips, because a prompt-stack card that grows without bound
 * stops being chrome and starts being content.
 *
 * The status pill, the timer and the controls never wrap — they are the row's
 * fixed skeleton, and the wrapping happens between them.
 *
 * The host has five row states, Xcode has seven; the mapping is the one
 * judgement call here:
 *
 *   running   → active     the row that earns its weight
 *   finishing → pending    process gone, verdict not in yet
 *   failed    → failed     destructive tint
 *   passed    │
 *   warnings  ┘→ completed quiet — warnings are a SUCCESS state
 *   cancelled │
 *   ended     ┘→ muted     nothing was concluded
 */

import type { ReactNode } from "react";
import { useId, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

import { activityMetaClass, runActivityState } from "./activity-styles";
import {
  formatDuration,
  formatRelative,
  kindLabel,
  runStatusLabel,
  runTitle,
} from "./format";
import { isLive, type RunDto } from "./status-types";

/**
 * Three lines of meta at ~17px. The cap is a clip, not a scroll: whatever
 * falls past it is by definition the least important field, and the
 * disclosure holds the complete picture anyway.
 */
const META_MAX_HEIGHT = 54;

export function XcodeActivityRow({
  run,
  children,
  defaultExpanded,
  trailing,
  onDismiss,
}: {
  run: RunDto;
  /** Disclosed body. Omit for a row that does not open. */
  children?: ReactNode;
  defaultExpanded?: boolean;
  /** Extra meta rendered just before the controls, e.g. "+2 more". */
  trailing?: ReactNode;
  /** Present only on a settled run the user is allowed to clear. */
  onDismiss?: () => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const bodyId = useId();
  const toggleId = useId();

  const state = runActivityState(run.status);
  const live = isLive(run);
  const elapsed = live ? Date.now() - run.startedAt : run.durationMs;
  const collapsible = Boolean(children);

  // One trailing fact, chosen for what the state leaves unanswered: a live
  // build is "how hard is it working", a settled one "what did it leave".
  const tail = live
    ? run.workerCount
      ? `${run.workerCount} compiler${run.workerCount === 1 ? "" : "s"}`
      : null
    : run.errorCount > 0
      ? `${run.errorCount} error${run.errorCount === 1 ? "" : "s"}`
      : (run.testFailed ?? 0) > 0
        ? `${run.testFailed} of ${run.testTotal} failed`
        : run.testTotal !== null
          ? `${run.testTotal} tests passed`
          : run.warningCount > 0
            ? `${run.warningCount} warning${run.warningCount === 1 ? "" : "s"}`
            : run.endedAt
              ? formatRelative(run.endedAt)
              : null;

  const header = (
    <>
      <StatusPill run={run} />
      {/* min-w-0 is what lets the children truncate instead of forcing the
          row wider than the card that holds it. */}
      <span
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 overflow-hidden text-left"
        style={{ maxHeight: META_MAX_HEIGHT }}
      >
        <span className="max-w-full truncate font-semibold text-foreground">
          {runTitle(run)}
        </span>
        <span className={activityMetaClass(state, "max-w-full truncate")}>
          {kindLabel(run.kind)}
        </span>
        {run.destinationLabel ? (
          <span
            className={activityMetaClass(state, "max-w-full truncate")}
            title={run.destinationLabel}
          >
            {run.destinationLabel}
          </span>
        ) : null}
        {run.branch ? (
          <span
            className={activityMetaClass(state, "flex max-w-full items-center gap-0.5")}
            title={run.branch}
          >
            <Icon name="GitBranch" className="size-3 shrink-0 opacity-70" aria-hidden />
            <span className="truncate">{run.branch}</span>
          </span>
        ) : null}
        {tail ? (
          <span className={activityMetaClass(state, "max-w-full truncate tabular-nums")}>
            {tail}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "shrink-0 font-medium tabular-nums",
          live ? "bbx-text" : activityMetaClass(state),
        )}
      >
        {formatDuration(elapsed)}
      </span>
      {trailing ? (
        <span className={activityMetaClass(state, "shrink-0")}>{trailing}</span>
      ) : null}
      {collapsible ? (
        <Icon
          name="ChevronDown"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      ) : null}
    </>
  );

  return (
    <>
      {/* The dismiss control sits OUTSIDE the disclosure button: a button
          inside a button is invalid markup, and clearing a row must never
          also toggle its panel open. */}
      <div className="flex items-stretch">
        {collapsible ? (
          <button
            type="button"
            id={toggleId}
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={`${kindLabel(run.kind)}: ${runTitle(run)}`}
            onClick={() => setExpanded((value) => !value)}
            className="flex min-h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-background/80"
          >
            {header}
          </button>
        ) : (
          <div className="flex min-h-8 min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-xs">
            {header}
          </div>
        )}
        {onDismiss ? (
          <button
            type="button"
            aria-label={`Dismiss ${runTitle(run)}`}
            title="Dismiss"
            onClick={onDismiss}
            className="flex w-8 shrink-0 cursor-pointer items-center justify-center border-l border-border/40 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Icon name="X" className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* A live run keeps a hairline of motion even while collapsed, so the
          row reads as working rather than merely present. */}
      {live && !expanded ? (
        <Progress
          indeterminate
          aria-label={`${runStatusLabel(run)} ${runTitle(run)}`}
          className="bbx-progress-track h-0.5 rounded-none"
          indicatorClassName={
            run.status === "finishing" ? "bbx-progress-breath w-full" : "bbx-progress-comet"
          }
        />
      ) : null}

      {collapsible ? (
        <section
          id={bodyId}
          role="region"
          aria-labelledby={toggleId}
          aria-hidden={!expanded}
          className={cn(
            "grid overflow-hidden transition-[grid-template-rows,opacity,border-color] duration-200 ease-out",
            expanded
              ? "grid-rows-[1fr] border-t border-border opacity-100"
              : "pointer-events-none grid-rows-[0fr] opacity-0",
          )}
        >
          <div className="overflow-hidden bg-popover">{children}</div>
        </section>
      ) : null}
    </>
  );
}

/**
 * The state, as a filled pill.
 *
 * Solid fill rather than tinted text because this is the row's anchor: it
 * never wraps and never truncates, holding its position while everything to
 * its right reflows. The label is kind-aware while in flight (Testing,
 * Archiving), since a test run reading "Building" is simply wrong.
 */
function StatusPill({ run }: { run: RunDto }) {
  return (
    <span className="bbx-pill shrink-0 rounded-full px-2 text-[10px] font-semibold uppercase leading-[17px] tracking-wide">
      {runStatusLabel(run)}
    </span>
  );
}
