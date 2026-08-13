/**
 * Every user-facing sentence this plugin can say, and the number formatting
 * underneath them.
 *
 * The sentences live together because they are the contract: `bb sims doctor`,
 * the panel's Doctor section and the empty state must render the *same* words,
 * or a stranger reading one and then the other learns there are two
 * vocabularies for one state. The frontend tests assert these strings, not
 * class names.
 *
 * Locale rules, from a sibling plugin that shipped a real bug where a European
 * locale rendered a duration as `0,55s` and `parseFloat` silently returned `0`:
 * never format by concatenating a locale-formatted value, never store a
 * formatted anything, and never parse a number out of a tool's human output.
 * Durations are integer milliseconds until the moment they are rendered.
 */

/**
 * `550` → `"0.55s"`, in every locale.
 *
 * Seconds all the way down rather than switching to milliseconds under a
 * second: one shape is easier to scan in a Facts column, and `toFixed` is
 * locale-independent where `toLocaleString` is not. This is the assertion the
 * international run exists for.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** A changed-pixel fraction as a percentage with two decimals: `0.0625` → `"6.25%"`. */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(2)}%`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value).toString()} ${units[unit]}`;
}

/**
 * Relative time, coarse on purpose. A second-precision countdown on a
 * 30-minute TTL is a nervous animation that re-renders the prompt stack at 1Hz.
 */
export function formatAgo(then: number, now: number): string {
  const ms = Math.max(0, now - then);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "a minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "an hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/** The exposure countdown. Minutes, never `27:14`. */
export function formatRemaining(msLeft: number): string {
  if (msLeft <= 0) return "expired";
  const minutes = Math.floor(msLeft / 60_000);
  if (minutes < 1) return "less than a minute left";
  return minutes === 1 ? "1 more minute" : `${minutes} more minutes`;
}

/** A commit for display. Short, and never presented as if it were the full sha. */
export function shortSha(sha: string | null): string | null {
  if (sha === null || sha.length < 7) return sha;
  return sha.slice(0, 7);
}

/** `["a"]` → `"a"`, `["a","b"]` → `"a and b"`, `["a","b","c"]` → `"a, b and c"`. */
export function joinWords(words: readonly string[]): string {
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!;
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
