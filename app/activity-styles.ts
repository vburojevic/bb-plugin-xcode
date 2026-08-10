/**
 * bb's activity-row vocabulary, ported.
 *
 * A tracked build is the same kind of object as a running background command
 * or a workflow run, so it should look like one rather than inventing a
 * parallel visual language. This is a faithful port of
 * `packages/shared-ui/src/components/ui/activity-row-styles.ts` in the bb
 * repo, which `@bb/shared-ui` exports to builtin plugins but not to external
 * ones — we bundle our own Tailwind, so the class strings are copied instead
 * of imported.
 *
 * Two substitutions, forced by which utilities this plugin's Tailwind build
 * can actually generate from the host theme:
 *   `text-subtle-foreground` → `text-muted-foreground`
 *   `text-destructive-text`  → `text-destructive`
 * Everything else is verbatim. Keep it that way: if the host row restyles,
 * this file is the single place that has to follow.
 *
 * The one deliberate divergence is `completed`, which upstream renders
 * `line-through` because its rows are checklist items. A finished build is a
 * result, not a struck-out todo, so the strike is dropped — the verdict glyph
 * and color already carry "done".
 */

import { cn } from "@/lib/utils";

export type ActivityRowState =
  | "active"
  | "pending"
  | "completed"
  | "failed"
  | "muted";

const ACTIVITY_ROW_CLASS: Record<ActivityRowState, string> = {
  active: "rounded-md bg-background/70 px-2 py-1 shadow-xs ring-1 ring-border/60",
  pending: "rounded-md px-2 py-0.5",
  completed: "rounded-md px-2 py-0.5",
  failed: "rounded-md bg-destructive/5 px-2 py-1 ring-1 ring-destructive/20",
  muted: "rounded-md px-2 py-0.5 opacity-60",
};

const ACTIVITY_ICON_CLASS: Record<ActivityRowState, string> = {
  active: "text-foreground",
  pending: "text-muted-foreground/45",
  completed: "text-muted-foreground",
  failed: "text-destructive",
  muted: "text-muted-foreground",
};

const ACTIVITY_TEXT_CLASS: Record<ActivityRowState, string> = {
  active: "font-medium text-foreground",
  pending: "text-muted-foreground",
  completed: "text-muted-foreground",
  failed: "text-destructive",
  muted: "text-muted-foreground",
};

const ACTIVITY_META_CLASS: Record<ActivityRowState, string> = {
  active: "text-muted-foreground",
  pending: "text-muted-foreground",
  completed: "text-muted-foreground",
  failed: "text-destructive",
  muted: "text-muted-foreground",
};

export function activityRowClass(state: ActivityRowState, className?: string): string {
  return cn(ACTIVITY_ROW_CLASS[state], className);
}

export function activityIconClass(state: ActivityRowState, className?: string): string {
  return cn(ACTIVITY_ICON_CLASS[state], className);
}

export function activityTextClass(state: ActivityRowState, className?: string): string {
  return cn(ACTIVITY_TEXT_CLASS[state], className);
}

export function activityMetaClass(state: ActivityRowState, className?: string): string {
  return cn(ACTIVITY_META_CLASS[state], className);
}

/** Host row height for a single-line activity entry. */
export const ACTIVITY_ROW_HEIGHT = 32;

/** A run's status mapped onto the host's five-state row vocabulary. */
export function runActivityState(status: string): ActivityRowState {
  switch (status) {
    case "running":
      return "active";
    case "finishing":
      return "pending";
    case "failed":
      return "failed";
    case "passed":
    case "warnings":
      return "completed";
    default:
      return "muted";
  }
}
