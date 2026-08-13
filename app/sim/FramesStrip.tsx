/**
 * The Frames strip: the last captures from this device, newest first.
 *
 * Each tile is a thumbnail with a sentence — *"Captured while Almanac was on the
 * recipe list, 4 minutes ago."* Pressing Capture animates the new tile in;
 * there is deliberately no toast, because the frame appearing where frames live
 * is a better confirmation than a notification that covers it.
 */
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatAgo } from "../../src/sim/format.js";
import { appLabel } from "./copy";

export interface StripFrame {
  id: string;
  lookId: string;
  displayName: string;
  width: number;
  height: number;
  foregroundBundleId: string | null;
  capturedAt: number;
  url: string;
  thumbUrl: string | null;
}

export interface FramesStripProps {
  frames: StripFrame[];
  now: number;
  onOpen?: (frame: StripFrame) => void;
}

/** *"Captured while Almanac was on screen, 4 minutes ago."* */
export function describeFrame(frame: StripFrame, now: number): string {
  const app = appLabel(frame.foregroundBundleId);
  const when = formatAgo(frame.capturedAt, now);
  return app === null
    ? `Captured on the home screen, ${when}.`
    : `Captured while ${app} was on screen, ${when}.`;
}

export function FramesStrip({ frames, now, onOpen }: FramesStripProps) {
  if (frames.length === 0) return null;

  return (
    <div className="border-t px-2 py-2">
      <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Recent captures">
        {frames.map((frame) => (
          <li key={frame.id} className="shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="block overflow-hidden rounded-md border transition-opacity hover:opacity-80"
                  onClick={() => onOpen?.(frame)}
                  aria-label={describeFrame(frame, now)}
                >
                  {frame.thumbUrl === null ? (
                    // No thumbnail is a degraded grid, not a broken one: the
                    // full frame is always there.
                    <span
                      className="bbxs-skeleton flex h-16 w-10 items-center justify-center"
                      aria-hidden
                    >
                      <Icon name="File" className="size-4 text-muted-foreground" />
                    </span>
                  ) : (
                    <img
                      src={frame.thumbUrl}
                      alt=""
                      loading="lazy"
                      className="h-16 w-auto"
                      // A dynamic ratio is an inline style: a build-time
                      // utility cannot be computed at runtime anyway.
                      style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{describeFrame(frame, now)}</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  );
}
