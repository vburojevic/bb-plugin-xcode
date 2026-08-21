/**
 * The compiler swarm: one dot per Swift/clang process this build has alive
 * right now, so a glance answers "is it actually working, and how hard".
 *
 * Lifted out of the chat card when the row gained a second mount (the
 * composer banner): both surfaces disclose the same live picture.
 */

import { useEffect, useState } from "react";

import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

import { runTitle, statusLabel } from "./format";
import type { RunDto } from "./status-types";

/**
 * Most compiler dots we will draw. Beyond this the row stops being countable
 * at a glance and becomes texture, so the surplus goes to the label instead.
 */
const MAX_WORKER_DOTS = 24;

export function WorkerSwarm({ run }: { run: RunDto }) {
  const live = run.workerCount ?? 0;
  const [peak, setPeak] = useState(live);

  useEffect(() => {
    setPeak((current) => (live > current ? live : current));
  }, [live]);
  useEffect(() => {
    setPeak(0); // a pinned card can switch runs; capacity is per run
  }, [run.id]);

  const slots = Math.min(Math.max(peak, live), MAX_WORKER_DOTS);
  const label =
    live > 0
      ? `${live} compiler${live === 1 ? "" : "s"} running`
      : run.status === "finishing"
        ? "awaiting result"
        : "no compilers running";

  // Nothing observed yet, and nothing to remember: say "moving" without
  // claiming a number.
  if (slots === 0) {
    return (
      <Slot>
        <Progress
          indeterminate
          aria-label={`${statusLabel(run.status)} ${runTitle(run)}`}
          className="bbx-progress-track h-1"
          indicatorClassName={
            run.status === "finishing"
              ? "bbx-progress-breath w-full"
              : "bbx-progress-comet"
          }
        />
      </Slot>
    );
  }

  return (
    <Slot>
      <div
        className="flex items-center gap-2"
        role="progressbar"
        aria-label={`${statusLabel(run.status)} ${runTitle(run)}`}
        aria-valuenow={live}
        aria-valuemin={0}
        // Never below valuenow: the dot row caps at MAX_WORKER_DOTS but a
        // 32-compiler build must not report "32 of 24" to a screen reader.
        aria-valuemax={Math.max(slots, live)}
        aria-valuetext={label}
      >
        <div className="flex flex-wrap items-center gap-1" aria-hidden>
          {Array.from({ length: slots }, (_, index) => (
            <span
              key={index}
              className={cn(
                "size-1.5 rounded-full transition-[opacity,transform] duration-300 ease-out",
                index < live ? "bbx-worker" : "bbx-worker-idle",
              )}
              // Staggered so the row breathes as a wave rather than a unison
              // blink, which at twelve dots reads as a warning light.
              style={
                index < live
                  ? { animationDelay: `${(index % 8) * 110}ms` }
                  : undefined
              }
            />
          ))}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {label}
        </span>
      </div>
    </Slot>
  );
}

function Slot({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-1.5 px-3.5 pb-3">{children}</div>;
}
