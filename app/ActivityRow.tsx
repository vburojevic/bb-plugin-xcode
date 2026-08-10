/**
 * The activity row — one build, one line, opening onto everything else.
 *
 * Two rules fight here and both win:
 *
 *  1. The FRAME is the host's. Geometry, radius, surface and rhythm come from
 *     `PromptStackCard` (see `.bbx-stack-card` in app.css) so the row sits in
 *     bb's prompt stack as a peer of "Running background command", not as a
 *     plugin bolted on beside it. 32px, `px-3 py-1.5`, `text-xs`.
 *  2. The CONTENTS are ours. Inside that frame a build says what only a build
 *     can: a pulsing Xcode-blue dot while compilers churn, a green check or a
 *     red cross when the verdict lands, the status word in that same colour,
 *     and a border that shifts with it. The host's flat grey is right for a
 *     shell command; a build has a state worth seeing across the room.
 *
 * Status colours are Xcode's own vocabulary blended with live theme tokens
 * (`--bbx`, set by `.bbx-status-*`), so they track any palette instead of
 * fighting it.
 *
 * The host has five row states, Xcode has seven — the mapping is the one
 * judgement call in this file:
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
  statusIcon,
} from "./format";
import { isLive, statusClass, type RunDto } from "./status-types";

/** Native header-row geometry, matched exactly. */
const ROW_CLASS =
  "flex min-h-8 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-xs";

export function XcodeActivityRow({
  run,
  children,
  defaultExpanded,
  trailing,
}: {
  run: RunDto;
  /** Disclosed body. Omit for a row that does not open. */
  children?: ReactNode;
  defaultExpanded?: boolean;
  /** Extra meta rendered just before the chevron, e.g. "+2 more". */
  trailing?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const bodyId = useId();
  const toggleId = useId();

  const state = runActivityState(run.status);
  const live = isLive(run);
  const elapsed = live ? Date.now() - run.startedAt : run.durationMs;
  const collapsible = Boolean(children);

  // One trailing fact, chosen for what the state actually leaves unanswered:
  // a live build is "how hard is it working", a finished one is "what did it
  // leave behind". Never both — this is a single line.
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
      <StatusMark status={run.status} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0 font-semibold text-foreground">
          {runTitle(run)}
        </span>
        <span className="bbx-chip shrink-0 rounded-full border px-1.5 py-0 text-[10px] font-medium capitalize leading-[15px]">
          {kindLabel(run.kind)}
        </span>
        <span className="bbx-text shrink-0 font-medium">
          {runStatusLabel(run)}
        </span>
        {run.destinationLabel ? (
          <span className={activityMetaClass(state, "shrink-0 truncate")}>
            {run.destinationLabel}
          </span>
        ) : null}
        {run.branch ? (
          <span className={activityMetaClass(state, "flex min-w-0 items-center gap-0.5")}>
            <Icon name="GitBranch" className="size-3 shrink-0 opacity-70" aria-hidden />
            <span className="truncate" title={run.branch}>
              {run.branch}
            </span>
          </span>
        ) : null}
      </span>
      {tail ? (
        <span className={activityMetaClass(state, "shrink-0 tabular-nums")}>{tail}</span>
      ) : null}
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
      {collapsible ? (
        <button
          type="button"
          id={toggleId}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`${kindLabel(run.kind)}: ${runTitle(run)}`}
          onClick={() => setExpanded((value) => !value)}
          className={cn(ROW_CLASS, "cursor-pointer text-left transition-colors hover:bg-background/80")}
        >
          {header}
        </button>
      ) : (
        <div className={ROW_CLASS}>{header}</div>
      )}

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
          <div className={cn("overflow-hidden bg-popover", statusClass(run.status))}>
            {children}
          </div>
        </section>
      ) : null}
    </>
  );
}

/**
 * The status mark: a pulsing dot while live (Xcode-blue blended with the theme
 * accent), a static verdict icon once resolved. Colours flow from the enclosing
 * `.bbx-status-*` scope, and the icon's `transition-colors` makes a verdict
 * landing read as the row settling rather than swapping.
 */
function StatusMark({ status }: { status: RunDto["status"] }) {
  if (status === "running" || status === "finishing") {
    return (
      <span
        className="bbx-dot relative flex size-3.5 shrink-0 items-center justify-center"
        aria-hidden
      >
        <span className="bb-xcode-ping absolute size-2.5 rounded-full opacity-60" />
        <span
          className={cn(
            "relative size-2.5 rounded-full",
            status === "finishing" && "opacity-60",
          )}
        />
      </span>
    );
  }
  return (
    <span
      className="bbx-text flex size-3.5 shrink-0 items-center justify-center"
      aria-hidden
    >
      <Icon
        name={statusIcon(status)}
        className="bbx-verdict-in size-3.5 transition-colors duration-200"
      />
    </span>
  );
}
