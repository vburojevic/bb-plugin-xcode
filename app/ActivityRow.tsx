/**
 * The activity row — one build, one line where it fits, never a collision.
 *
 * Two rules fight here and both win:
 *
 *  1. The FRAME is the host's. Geometry, radius, surface and rhythm come from
 *     `PromptStackCard` (see `.bbx-stack-card` in app.css) so the row sits in
 *     bb's prompt stack as a peer of "Running background command".
 *  2. The CONTENTS are ours. The row opens with a phrase, not a badge:
 *     "Building Packerly" while it runs, "Packerly succeeded" once it lands.
 *     State and identity are one clause whose grammar does the work, in the
 *     run's own colour. Everything else — simulator, branch, counts — is
 *     supporting detail that may wrap behind it.
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
 * The timer and the controls never wrap — they are the row's fixed skeleton,
 * and the wrapping happens between them and the headline.
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
  runPhrase,
  runStatusLabel,
  runTitle,
} from "./format";
import { isLive, type RunDto } from "./status-types";

/**
 * The meta group's line box, pinned rather than inherited.
 *
 * The cap has to be an exact multiple of the line height or the last visible
 * line is sliced through the middle of its glyphs — which is what happened
 * when this was a guessed pixel value against `text-xs`'s inherited 16px
 * leading plus a 2px row gap. Fixing the leading here and dropping the
 * vertical gap makes the arithmetic exact: three lines, nothing clipped.
 */
const META_LINE_HEIGHT = 20;
const META_MAX_LINES = 3;
const META_MAX_HEIGHT = META_LINE_HEIGHT * META_MAX_LINES;

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
      {/* min-w-0 is what lets the children truncate instead of forcing the
          row wider than the card that holds it. */}
      <span
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 overflow-hidden text-left"
        style={{ maxHeight: META_MAX_HEIGHT, lineHeight: `${META_LINE_HEIGHT}px` }}
      >
        <Headline run={run} />
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
 * The headline: state and identity as one clause, not two tokens.
 *
 * Two earlier attempts put the state beside the name as its own object — a
 * filled pill, then a bare word — and both read as two disconnected facts
 * competing for the front of the row. Worse, while the verb was "Building"
 * the row also carried a separate "build" kind token saying the same thing
 * twice. Composing them fixes both: one clause, whose grammar carries the
 * state, and the kind token is gone because the verb already is the kind.
 *
 * The whole phrase is a single wrapping unit, so "Packerly succeeded" never
 * breaks across lines with the verb orphaned from its subject.
 */
function Headline({ run }: { run: RunDto }) {
  const { name, verb, verbFirst } = runPhrase(run);
  const nameEl = (
    <span className="font-semibold text-foreground">{name}</span>
  );
  const verbEl = <span className="bbx-text font-medium">{verb}</span>;
  return (
    <span className="max-w-full truncate" title={`${name} — ${verb}`}>
      {verbFirst ? (
        <>
          {verbEl} {nameEl}
        </>
      ) : (
        <>
          {nameEl} {verbEl}
        </>
      )}
    </span>
  );
}
