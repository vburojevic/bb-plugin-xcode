/**
 * Stills: three regions, stated as such.
 *
 * The **verdict is sticky at the top**. It is one line, it costs nothing, and
 * it is the entire point of failure-first ordering — so it must not leave the
 * viewport when you look at the third tile.
 *
 * **Everything between scrolls inside the cap with a permanently visible thin
 * scrollbar**, because a list cut by `max-height` looks exactly like a list
 * that ended.
 *
 * **Controls are pinned at the bottom, benign to consequential, left to right.**
 * `Set as baseline` is last: it silently redefines truth for every future run
 * and exempts a look from pruning forever, and an action like that should not
 * be under the cursor when a panel springs open.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatRatio } from "../../src/sim/format.js";
import { DiffTile } from "./DiffTile";
import type { LookSummary, VerdictRow } from "./useStills";

export interface StillsPanelProps {
  summary: LookSummary | null;
  isOnboarded: boolean;
  onboarding: React.ReactNode;
  onRun: () => void;
  onSetBaseline: () => void;
  onAcceptIdentity: (identity: string) => void;
  onOpenFilmstrip: (identity: string) => void;
  busy: boolean;
  /** Names what a re-baseline would replace, so the confirmation can say it. */
  baselineReplaces: string | null;
}

export function StillsPanel({
  summary,
  isOnboarded,
  onboarding,
  onRun,
  onSetBaseline,
  onAcceptIdentity,
  onOpenFilmstrip,
  busy,
  baselineReplaces,
}: StillsPanelProps) {
  const [showRekeyOnly, setShowRekeyOnly] = useState(false);

  if (!isOnboarded) return <>{onboarding}</>;
  if (summary === null) return <div className="bbxs-skeleton m-4 h-40" aria-hidden />;

  const running = summary.status === "running";
  const missing = summary.rows.filter((row) => row.status === "missing" || row.status === "errored");
  const changed = summary.rows.filter(
    (row) => row.status === "changed" || row.status === "layout-changed",
  );
  const visibleChanged = showRekeyOnly ? changed.filter((row) => !row.flaky) : changed;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Sticky, because it is the entire point of failure-first ordering. */}
      <div className="border-b px-4 py-3">
        <p className="text-sm font-medium text-balance">{summary.sentence}</p>
        {summary.rekey !== null ? (
          <div className="mt-2 space-y-2">
            <p className="text-sm text-muted-foreground text-balance">{summary.rekey.sentence}</p>
            {/* The state where you are least sure what happened is not the
                state to promote an irreversible action to primary. */}
            <Button size="sm" onClick={() => setShowRekeyOnly(true)}>
              {summary.rekey.primaryLabel}
            </Button>
          </div>
        ) : null}
        {running ? (
          <div className="mt-2">
            {summary.progress?.total == null ? (
              // Indeterminate when the manifest gave no denominator, because a
              // determinate bar would be inventing one.
              <div className="bbxs-comet h-1 w-full rounded-full" aria-label="Rendering" />
            ) : (
              <Progress
                value={(summary.progress.done / Math.max(1, summary.progress.total)) * 100}
                aria-label={`${summary.progress.done} of ${summary.progress.total} rendered`}
              />
            )}
          </div>
        ) : null}
      </div>

      {/* While a run is going the grid is not rendered at all. */}
      {running ? (
        <div className="flex-1" />
      ) : (
        <div className="bbxs-scroll min-h-0 flex-1 space-y-5 p-4">
          {summary.truncation !== null ? (
            <p className="rounded-md border p-3 text-sm text-balance">{summary.truncation.sentence}</p>
          ) : null}

          {missing.length > 0 && summary.truncation === null ? (
            <section>
              <SectionHeading>Did not render</SectionHeading>
              <ul className="space-y-1">
                {missing.slice(0, 10).map((row) => (
                  <li key={row.identity} className="text-sm">
                    <code className="text-xs">{fullName(row)}</code> did not render.
                  </li>
                ))}
              </ul>
              {summary.missingOverflow > 0 ? (
                <Collapsible>
                  <CollapsibleTrigger asChild>
                    <Button variant="link" size="sm" className="h-auto p-0 text-xs">
                      and {summary.missingOverflow} more that did not render
                    </Button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <ul className="mt-1 space-y-1">
                      {missing.slice(10).map((row) => (
                        <li key={row.identity} className="text-sm">
                          <code className="text-xs">{fullName(row)}</code>
                        </li>
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </section>
          ) : null}

          {visibleChanged.length > 0 ? (
            <section>
              <SectionHeading>
                Changed
                {showRekeyOnly ? (
                  <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => setShowRekeyOnly(false)}>
                    show all {changed.length}
                  </Button>
                ) : null}
              </SectionHeading>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {visibleChanged.map((row) => (
                  <DiffTile
                    key={row.identity}
                    row={row}
                    onOpenFilmstrip={() => onOpenFilmstrip(row.identity)}
                    onAccept={() => onAcceptIdentity(row.identity)}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <CollapsedCount label="Added" count={summary.counts.added} />
          <CollapsedCount label="Removed" count={summary.counts.removed} />
          {/* 148 unchanged thumbnails is a screensaver. */}
          <CollapsedCount label="Unchanged" count={summary.counts.unchanged} />

          {summary.facts.length > 0 ? (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-auto px-0 text-xs text-muted-foreground">
                  Facts
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <dl className="mt-1 space-y-1 text-xs">
                  {summary.facts.map((fact) => (
                    <div key={fact.label} className="flex gap-2">
                      <dt className="w-32 shrink-0 text-muted-foreground">{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      )}

      <div className="flex items-center gap-2 border-t px-3 py-2">
        <Button variant="ghost" size="sm" disabled={busy || running} onClick={onRun}>
          Re-render
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {summary.isBaseline ? <Badge variant="secondary">Baseline</Badge> : null}
          {/* Re-baselining over an existing baseline names what it replaces:
              an action that silently redefines truth for every future run
              should say what it is overwriting. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant={summary.rekey === null ? "default" : "outline"}
                disabled={busy || running || summary.lookId === null}
                onClick={onSetBaseline}
              >
                Set as baseline
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {baselineReplaces === null
                ? "Every future run compares against this one."
                : `Replaces the baseline set from ${baselineReplaces}.`}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

function CollapsedCount({ label, count }: { label: string; count: number }) {
  if (count === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {count} {label.toLowerCase()}
    </p>
  );
}

function fullName(row: VerdictRow): string {
  return row.groupName === "" ? row.displayName : `${row.groupName} / ${row.displayName}`;
}

export { formatRatio };
