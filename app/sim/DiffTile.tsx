/**
 * One changed preview.
 *
 * The thumbnail with the diff mask overlaid at 40%, press-and-hold to see the
 * base, and the diff percentage as a tabular number so a column of them lines
 * up.
 *
 * A `layout-changed` tile is **side by side with both dimensions labelled and
 * no overlay**, because odiff produces no mask for a dimension mismatch and a
 * fabricated one would be a lie.
 *
 * Tile controls appear on hover along the bottom edge, benign first:
 * `Open filmstrip`, then `Accept this one` last.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatRatio } from "../../src/sim/format.js";
import type { VerdictRow } from "./useStills";

export interface DiffTileProps {
  row: VerdictRow;
  onOpenFilmstrip: () => void;
  onAccept: () => void;
}

export function DiffTile({ row, onOpenFilmstrip, onAccept }: DiffTileProps) {
  const [showingBase, setShowingBase] = useState(false);
  const frame = row.frame;
  const ratio = row.diffRatio;

  return (
    <figure className="group relative overflow-hidden rounded-md border">
      {row.status === "layout-changed" ? (
        <div className="flex gap-1 bg-muted p-1">
          <Side url={row.baseUrl} width={row.baseWidth} height={row.baseHeight} label="before" />
          <Side url={frame?.thumbUrl ?? frame?.url ?? null} width={frame?.width ?? null} height={frame?.height ?? null} label="after" />
        </div>
      ) : (
        <div
          className="relative"
          // Press and hold to see the base. A crossfade rather than a swap,
          // and an instant swap under reduced motion.
          onPointerDown={() => setShowingBase(true)}
          onPointerUp={() => setShowingBase(false)}
          onPointerLeave={() => setShowingBase(false)}
        >
          {frame === null ? (
            <div
              className="bbxs-skeleton w-full"
              style={{ aspectRatio: "9 / 19.5" }}
              aria-label="This frame is no longer on disk"
            />
          ) : (
            <>
              <img
                src={(showingBase ? row.baseUrl : null) ?? frame.thumbUrl ?? frame.url}
                alt=""
                loading="lazy"
                className="bbxs-tile-crossfade block w-full"
                style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
              />
              {/* Painted over the head frame, which is why odiff runs with
                  --diff-mask: its default output is the whole comparison image
                  with changed pixels tinted, and overlaying that renders a
                  washed-out second copy of the frame rather than a highlight. */}
              {row.maskUrl !== null && !showingBase ? (
                <img src={row.maskUrl} alt="" aria-hidden className="bbxs-mask" />
              ) : null}
            </>
          )}
        </div>
      )}

      <figcaption className="space-y-0.5 px-2 py-1.5">
        <p className="truncate text-xs font-medium">{row.displayName}</p>
        {row.groupName !== "" ? (
          <p className="truncate text-[11px] text-muted-foreground">{row.groupName}</p>
        ) : null}
        {row.flakyDetail !== null ? (
          // The fact, which is shorter than defending the word "flaky".
          <p className="text-[11px] text-muted-foreground">{row.flakyDetail}</p>
        ) : null}
        {ratio !== null ? (
          <p className="font-mono text-[11px] tabular-nums text-muted-foreground">{formatRatio(ratio)}</p>
        ) : null}
      </figcaption>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/40 to-transparent p-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
        <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={onOpenFilmstrip}>
          Filmstrip
        </Button>
        <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={onAccept}>
          Accept this one
        </Button>
      </div>
    </figure>
  );
}

function Side({
  url,
  width,
  height,
  label,
}: {
  url: string | null;
  width: number | null;
  height: number | null;
  label: string;
}) {
  return (
    <div className="min-w-0 flex-1">
      {url === null ? (
        <div className="bbxs-skeleton w-full" style={{ aspectRatio: "9 / 19.5" }} aria-hidden />
      ) : (
        <img src={url} alt="" loading="lazy" className="block w-full" />
      )}
      <p className="mt-0.5 text-center font-mono text-[10px] tabular-nums text-muted-foreground">
        {label} {width ?? "?"}×{height ?? "?"}
      </p>
    </div>
  );
}
