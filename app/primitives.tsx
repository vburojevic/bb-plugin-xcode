/** Shared building blocks the stock components do not cover. */

import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import { type RunStatus, statusIcon, statusTone } from "./format";

/**
 * The status glyph: one fixed 16px slot for every state so rows keep a single
 * optical baseline. Running/finishing pulse; verdicts are static icons whose
 * `transition-colors` makes the resolve read as a change, not a swap.
 */
export function StatusGlyph({
  status,
  className,
}: {
  status: RunStatus;
  className?: string;
}) {
  if (status === "running" || status === "finishing") {
    return (
      <span
        className={cn(
          "relative flex size-4 shrink-0 items-center justify-center",
          className,
        )}
        aria-hidden
      >
        <span
          className={cn(
            "bb-xcode-ping absolute size-2.5 rounded-full",
            status === "running" ? "bg-primary/60" : "bg-muted-foreground/40",
          )}
        />
        <span
          className={cn(
            "relative size-2.5 rounded-full transition-colors duration-200",
            status === "running" ? "bg-primary" : "bg-muted-foreground",
          )}
        />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center transition-colors duration-200",
        statusTone(status),
        className,
      )}
      aria-hidden
    >
      <Icon name={statusIcon(status)} className="size-4" />
    </span>
  );
}

/** Indeterminate sweep for work with no honest completion percentage. */
export function SweepBar({
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-busy="true"
      className={cn(
        "relative h-0.5 w-full overflow-hidden rounded-full bg-primary/15",
        className,
      )}
    >
      <div className="bb-xcode-indeterminate-bar h-full w-full rounded-full bg-primary/80" />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-14 text-center",
        className,
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon name={icon} aria-hidden />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <div className="max-w-md text-sm text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}
