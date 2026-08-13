/**
 * `::xcode-simulators{look="lk_…"}`
 *
 * Up to six changed tiles inline, with **no dismiss control**: a directive is a
 * deliberate record, and a record you can silently delete is not one.
 *
 * That has a consequence, and the consequence is most of this file: it needs
 * states for a record whose subject is gone.
 *
 * - **Pruned.** A tombstone that still says what it was. Looks referenced by a
 *   `thread_links` row are exempt from pruning, the same predicate as
 *   baselined looks. Looks referenced *only* by a directive are not: directives
 *   live in message text rather than a queryable table, so "is this look
 *   referenced by a directive" cannot be answered without scanning transcripts,
 *   and exempting every one of them means the disk never shrinks in a busy
 *   thread. This is the answer to that.
 * - **Failed or cancelled.** The failure sentence alone, no tile rail.
 * - **Zero changed.** The verdict sentence alone, no tile rail.
 * - **Images 404.** The tile's aspect box at `--muted` — never a broken-image
 *   glyph.
 *
 * Directive attributes are attacker-controlled even though a model emitted
 * them, so `look` is matched against a strict id pattern and then looked up,
 * never used as a path.
 */
import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import type { rpcContract } from "../../src/sim/wire";
import { LOOK_ID_PATTERN } from "../../src/sim/model.js";
import { PANEL_PATH } from "./route";
import type { LookSummary } from "./useStills";

/** How many tiles a record shows before it stops being a record and becomes a grid. */
const MAX_TILES = 6;

export interface StillsDirectiveProps {
  attributes: Readonly<Record<string, string>>;
  source: string;
}

export function StillsDirective({ attributes, source }: StillsDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const lookId = attributes.look ?? "";
  const valid = LOOK_ID_PATTERN.test(lookId);
  const [summary, setSummary] = useState<LookSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    void rpc
      .call("stillsLatest", { lookId })
      .then((result) => {
        if (alive) setSummary(result as LookSummary);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [rpc, lookId, valid]);

  // A malformed directive renders as its own source text, which is what the
  // host does for an unknown one — the message should never lose content.
  if (!valid) return <code className="text-xs">{source}</code>;
  if (failed) return <code className="text-xs">{source}</code>;
  if (summary === null) return <div className="bbxs-skeleton h-24 w-full" aria-hidden />;

  const changed = summary.rows.filter(
    (row) => row.status === "changed" || row.status === "layout-changed",
  );
  // A look whose frames are gone still has its verdicts: pruning removes the
  // pixels, not the record.
  const pruned = summary.lookId !== null && summary.rows.every((row) => row.frame === null);

  return (
    <div className="bbxs-stack-card p-3">
      <p className="text-sm font-medium text-balance">
        {summary.lookId === null ? "This look is gone." : summary.sentence}
      </p>

      {pruned && summary.lookId !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          This look was pruned — the frames are gone.
        </p>
      ) : null}

      {summary.status === "failed" || summary.status === "cancelled" || pruned || changed.length === 0 ? null : (
        <div className="mt-2 flex gap-2 overflow-x-auto">
          {changed.slice(0, MAX_TILES).map((row) => (
            <figure key={row.identity} className="w-24 shrink-0">
              {row.frame === null ? (
                <div
                  className="bbxs-skeleton w-full"
                  style={{ aspectRatio: "9 / 19.5" }}
                  aria-label="This frame is no longer on disk"
                />
              ) : (
                <img
                  src={row.frame.thumbUrl ?? row.frame.url}
                  alt=""
                  loading="lazy"
                  className="w-full rounded border"
                  style={{ aspectRatio: `${row.frame.width} / ${row.frame.height}` }}
                />
              )}
              <figcaption className="mt-0.5 truncate text-[10px] text-muted-foreground">
                {row.displayName}
              </figcaption>
            </figure>
          ))}
          {changed.length > MAX_TILES ? (
            <div className="flex w-24 shrink-0 items-center justify-center text-xs text-muted-foreground">
              +{changed.length - MAX_TILES}
            </div>
          ) : null}
        </div>
      )}

      <div className="mt-2">
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() =>
            navigate.toPluginPanel(PANEL_PATH, { subPath: `stills/${summary.lookId ?? ""}` })
          }
        >
          Open in the panel
        </Button>
      </div>
    </div>
  );
}
