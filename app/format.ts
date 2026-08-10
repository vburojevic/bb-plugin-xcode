/** Presentation helpers — v2 vocabulary. */

import type { IconName } from "@/components/ui/icon";

export type RunStatus =
  | "running"
  | "finishing"
  | "passed"
  | "warnings"
  | "failed"
  | "cancelled"
  | "ended";

export type RunKind =
  | "build"
  | "test"
  | "archive"
  | "clean"
  | "analyze"
  | "install"
  | "export"
  | "docbuild"
  | "package"
  | "index"
  | "unknown";

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatRelative(at: number, now: number = Date.now()): string {
  const delta = now - at;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  const days = Math.round(delta / 86_400_000);
  if (days < 14) return `${days}d ago`;
  return new Date(at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Day bucket label for grouping the log: Today, Yesterday, then dates. */
export function dayLabel(at: number, now: number = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const delta = startOfDay(today) - startOfDay(date);
  if (delta <= 0) return "Today";
  if (delta <= 86_400_000) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Xcode's own vocabulary: builds succeed, they don't "pass". */
export function statusLabel(status: RunStatus): string {
  switch (status) {
    case "running":
      return "Building";
    case "finishing":
      return "Finishing";
    case "passed":
      return "Succeeded";
    case "warnings":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "ended":
      return "Finished";
  }
}

/**
 * `statusLabel`, but honest about what the process is actually doing.
 *
 * Only the in-flight state needs this: once a run resolves, "Succeeded" and
 * "Failed" read correctly for every kind. While it is alive, though, the verb
 * is the whole point — a test run labelled "Building" is simply wrong, which
 * is exactly what a card showing a build and a test side by side made obvious.
 */
export function runStatusLabel(run: {
  status: RunStatus;
  kind: RunKind;
}): string {
  if (run.status !== "running") return statusLabel(run.status);
  switch (run.kind) {
    case "test":
      return "Testing";
    case "archive":
      return "Archiving";
    case "clean":
      return "Cleaning";
    case "analyze":
      return "Analyzing";
    case "install":
      return "Installing";
    case "export":
      return "Exporting";
    case "docbuild":
      return "Documenting";
    case "package":
      return "Resolving";
    case "index":
      return "Indexing";
    case "unknown":
      return "Running";
    default:
      return "Building";
  }
}

/** Optional explanation for states whose label alone needs clarification. */
export function statusHint(_status: RunStatus): string | null {
  return null;
}

export function statusIcon(status: RunStatus): IconName {
  switch (status) {
    case "failed":
      return "CircleX";
    // A build with warnings SUCCEEDED — the check mark says so; the yellow
    // warning-count chip carries the caveat. Xcode draws it the same way.
    case "warnings":
    case "passed":
      return "CircleCheck";
    case "cancelled":
      return "CircleMinus";
    case "ended":
      return "CircleDashed";
    default:
      return "CircleDashed";
  }
}

/** Foreground tone class per status; running/finishing handled separately. */
export function statusTone(status: RunStatus): string {
  switch (status) {
    case "failed":
      return "text-destructive";
    case "warnings":
    case "passed":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground/70";
  }
}

export function kindLabel(kind: RunKind): string {
  return kind === "unknown" ? "activity" : kind;
}

export function basename(path: string | null | undefined): string | null {
  if (!path) return null;
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return (index === -1 ? trimmed : trimmed.slice(index + 1)) || null;
}

export function tildify(path: string | null | undefined): string {
  if (!path) return "—";
  const match = /^\/Users\/[^/]+(\/.*)?$/.exec(path);
  return match ? `~${match[1] ?? ""}` : path;
}

export function formatLocation(
  filePath: string | null,
  line: number | null,
): string | null {
  if (!filePath) return null;
  const name = basename(filePath) ?? filePath;
  return line === null ? name : `${name}:${line}`;
}

/** Display title for a run — scheme first, never a full path. */
export function runTitle(run: {
  scheme: string | null;
  container: string | null;
  root: string | null;
}): string {
  return (
    run.scheme ?? basename(run.container) ?? basename(run.root) ?? "Xcode activity"
  );
}
