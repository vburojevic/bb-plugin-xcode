/** Presentation helpers — v2 vocabulary. */

import type { IconName } from "@/components/ui/icon";

import { formatDuration } from "../src/duration";

export { formatDuration };

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

export function formatRelative(at: number, now: number = Date.now()): string {
  const delta = now - at;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  const days = Math.round(delta / 86_400_000);
  if (days < 14) return `${days}d ago`;
  const date = new Date(at);
  // "Jul 30" from last year is indistinguishable from this year's without it.
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
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
      // NOT "Finished". Finished what — succeeded, failed, was killed? This
      // state means the run started, stopped, and no verdict source ever told
      // us the outcome. A terminal label has to state a result or admit it has
      // none; "Finished" did neither and read as a synonym for success.
      return "No result";
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
  // `finishing` deliberately keeps the in-flight verb. It is a real internal
  // state — the 45s window where three verdict sources race — but as a word on
  // screen it made a build that had already stopped look like it was still
  // doing something, for up to three quarters of a minute.
  if (run.status !== "running" && run.status !== "finishing") {
    return statusLabel(run.status);
  }
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

/**
 * The row's headline, as a phrase rather than a label plus a name.
 *
 * A leading status token sat beside the scheme and read as two disconnected
 * facts — and when the verb was "Building" the separate "build" kind token
 * said it a second time. Composing them removes both problems: the line reads
 * as one clause, and its grammar carries the state.
 *
 *   running/finishing  →  "Building Packerly"   (verb first, present)
 *   passed/warnings    →  "Packerly succeeded"  (verb last, past)
 *   failed             →  "Packerly failed"
 *   cancelled          →  "Packerly cancelled"
 *   ended              →  "Packerly — no result"
 */
export function runPhrase(run: {
  status: RunStatus;
  kind: RunKind;
  scheme: string | null;
  container: string | null;
  root: string | null;
}): { name: string; verb: string; verbFirst: boolean } {
  const name = runTitle(run);
  switch (run.status) {
    case "running":
    case "finishing":
      return { name, verb: runStatusLabel(run), verbFirst: true };
    case "passed":
    case "warnings":
      return { name, verb: "succeeded", verbFirst: false };
    case "failed":
      return { name, verb: "failed", verbFirst: false };
    case "cancelled":
      return { name, verb: "cancelled", verbFirst: false };
    case "ended":
      return { name, verb: "— no result", verbFirst: false };
  }
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
  switch (kind) {
    case "unknown":
      return "activity";
    // "package" alone reads as a noun in a row that wants a verb phrase.
    case "package":
      return "package resolve";
    case "index":
      return "indexing";
    default:
      return kind;
  }
}

/** What a live build is doing right now, in words. */
export type BuildPhase =
  | "preparing"
  | "resolving"
  | "compiling"
  | "assets"
  | "linking"
  | "packaging"
  | "signing"
  | "testing";

const PHASE_LABEL: Record<BuildPhase, string> = {
  preparing: "Preparing",
  resolving: "Resolving packages",
  compiling: "Compiling",
  assets: "Compiling assets",
  linking: "Linking",
  packaging: "Generating symbols",
  signing: "Signing",
  testing: "Running tests",
};

export function phaseLabel(phase: BuildPhase | null): string | null {
  return phase ? PHASE_LABEL[phase] : null;
}

/**
 * The same fact in lower case, for use mid-sentence in a dense row.
 *
 * Package resolution loses the word "packages" here: the row already names the
 * scheme, and "Index · resolving packages · 7m" spends its scarcest column on
 * a word the verb implies.
 */
export function phaseTail(phase: BuildPhase | null): string | null {
  if (!phase) return null;
  return phase === "resolving"
    ? "resolving packages"
    : PHASE_LABEL[phase].toLowerCase();
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
  kind?: RunKind;
}): string {
  const named = run.scheme ?? basename(run.container) ?? basename(run.root);
  if (named) return named;
  // A standalone `xcodebuild -resolvePackageDependencies` names no scheme and
  // resolves no DerivedData root, so the generic fallback produced "Resolving
  // Xcode activity". These two give the verb something to act on.
  if (run.kind === "package") return "packages";
  if (run.kind === "index") return "files";
  return "Xcode activity";
}
