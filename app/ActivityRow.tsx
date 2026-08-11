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
 * ## One line, like its neighbours
 *
 * The fields are variable-length and unbounded — a scheme, a simulator name
 * and OS, a branch that can run fifty characters. Held on one line with
 * `shrink-0` they overlapped on a narrow composer; wrapped to three lines they
 * stopped overlapping but made the card two lines taller than every native row
 * beside it, which read as a different component bolted into the stack.
 *
 * So it does what the native rows do: the whole identity run is ONE truncating
 * unit, ellipsised as a unit, with the glyph, timer and controls as the fixed
 * skeleton around it. Nothing can overlap because nothing competes for width,
 * and the full text lives in the tooltip and the disclosure.
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

import {
  activityIconClass,
  activityMetaClass,
  runActivityState,
} from "./activity-styles";
import {
  formatDuration,
  formatRelative,
  kindLabel,
  runPhrase,
  runStatusLabel,
  runTitle,
  statusIcon,
} from "./format";
import { isLive, type RunDto } from "./status-types";

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
  const progress = elapsedProgress(run, elapsed);

  // One trailing fact, chosen for what the state leaves unanswered: a live
  // build is "how hard is it working", a settled one "what did it leave".
  const tail = live
    ? run.currentFile ??
      (run.workerCount
        ? `${run.workerCount} compiler${run.workerCount === 1 ? "" : "s"}`
        : null)
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

  // Everything the row says about identity, as ONE truncating unit — which is
  // exactly how the native rows beside it behave ("Running background command:
  // …"). An earlier version wrapped this to three lines to stop the fields
  // overlapping; it fixed the overlap and made the card two lines taller than
  // every neighbour in the stack, which read as a different component.
  const meta = [run.destinationLabel, run.branch, tail].filter(
    (part): part is string => Boolean(part),
  );

  const header = (
    <>
      {/* Native rows lead with a fixed-size glyph; matching it keeps the whole
          stack on one optical baseline. Live wears the plugin's mark, settled
          wears its verdict. */}
      <Icon
        name={live ? "Toolbox" : statusIcon(run.status)}
        className={cn(
          "size-3.5 shrink-0",
          live ? activityIconClass(state) : "bbx-text",
        )}
        aria-hidden
      />
      <span
        className="min-w-0 flex-1 truncate text-left"
        title={[runPhrase(run).name, ...meta].join(" · ")}
      >
        <Headline run={run} />
        {meta.map((part) => (
          <span key={part} className={activityMetaClass(state)}>
            {" · "}
            {part}
          </span>
        ))}
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
          row reads as working rather than merely present. When this checkout
          has enough history to know what "usual" is, that hairline becomes a
          real fraction instead of a sweep. */}
      {live && !expanded ? (
        progress === null ? (
          <Progress
            indeterminate
            aria-label={`${runStatusLabel(run)} ${runTitle(run)}`}
            className="bbx-progress-track h-0.5 rounded-none"
            indicatorClassName={
              run.status === "finishing"
                ? "bbx-progress-breath w-full"
                : "bbx-progress-comet"
            }
          />
        ) : (
          <Progress
            value={progress}
            aria-label={`${runStatusLabel(run)} ${runTitle(run)} — ${progress}% of a typical run`}
            className="bbx-progress-track h-0.5 rounded-none"
            indicatorClassName="bbx-progress-fill"
          />
        )
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
 * How far along a live run is, as a percentage of a typical one.
 *
 * Not a task count — llbuild holds its ledger inside one open transaction for
 * the whole build, so the only exact counter available is frozen until the
 * build ends. Elapsed against this checkout's own median is the honest
 * alternative, and it is genuinely useful because incremental builds of the
 * same scheme cluster tightly.
 *
 * It never reaches 100 and never goes backwards: a build that outruns its
 * median pins at 99 and the caption says so, because a bar that sat full while
 * work continued would be a lie told every single time a build ran long.
 */
function elapsedProgress(
  run: RunDto,
  elapsed: number | null,
): number | null {
  if (!isLive(run) || run.typicalMs === null || elapsed === null) return null;
  if (run.typicalMs <= 0) return null;
  return Math.min(99, Math.max(1, Math.round((elapsed / run.typicalMs) * 100)));
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
