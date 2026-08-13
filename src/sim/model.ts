/**
 * The vocabulary: frames, looks, verdicts, and the rules that turn a pile of
 * comparisons into one sentence.
 *
 * No I/O of any kind lives here, which is what makes the interesting decisions
 * — what counts as a regression, what counts as a re-key, what an empty result
 * is allowed to mean — testable on a Linux box with no bb, no Mac and no Xcode.
 */

/** A look is one run of one mode against one device. */
export type LookKind = "stills" | "live";
export type LookStatus = "running" | "ok" | "failed" | "cancelled";

/** Where a frame came from. Captures and previews never share an identity. */
export type FrameSource = "preview" | "capture";

export type VerdictStatus =
  | "unchanged"
  | "changed"
  | "layout-changed"
  | "added"
  | "removed"
  | "missing"
  | "errored";

export interface Frame {
  id: string;
  lookId: string;
  /** `preview:<png basename>` or `capture:<slug>`. Stable across runs. */
  identity: string;
  source: FrameSource;
  displayName: string;
  groupName: string;
  relPath: string;
  thumbRelPath: string | null;
  width: number;
  height: number;
  contentHash: string;
  bytes: number;
  /** From the frame's sidecar. `null` means "use the global setting". */
  diffThreshold: number | null;
  foregroundBundleId: string | null;
  capturedAt: number;
}

export interface Look {
  id: string;
  projectId: string;
  scopeKey: string;
  kind: LookKind;
  status: LookStatus;
  commitSha: string | null;
  branch: string | null;
  deviceKey: string;
  deviceUdid: string | null;
  deviceName: string | null;
  osVersion: string | null;
  scale: number | null;
  startedAt: number;
  endedAt: number | null;
  frameCount: number;
  /** The manifest's denominator. `null` genuinely means "we don't know". */
  expectedCount: number | null;
  manifestRan: boolean;
  bytesTotal: number;
  error: string | null;
}

export interface Verdict {
  lookId: string;
  baseLookId: string | null;
  identity: string;
  status: VerdictStatus;
  diffRatio: number | null;
  diffPixels: number | null;
  maskRelPath: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

/**
 * Failure-first ordering, as one number so every surface sorts identically.
 *
 * `missing` outranks everything because it is the most alarming thing this
 * plugin can say: SnapshotPreviews writes nothing and fails nothing when a
 * render fails, so a missing frame is the one result that looks like success
 * from every other angle.
 */
const SEVERITY: Record<VerdictStatus, number> = {
  missing: 0,
  errored: 1,
  "layout-changed": 2,
  changed: 3,
  removed: 4,
  added: 5,
  unchanged: 6,
};

export function severityOf(status: VerdictStatus): number {
  return SEVERITY[status];
}

/** True for the statuses that belong above the fold. */
export function isAlarming(status: VerdictStatus): boolean {
  return status === "missing" || status === "errored";
}

/**
 * Sort verdicts for display: severity first, then flaky changes below stable
 * ones, then by name so two runs of the same set render in the same order.
 */
export function compareForDisplay(
  a: { status: VerdictStatus; identity: string; flaky?: boolean },
  b: { status: VerdictStatus; identity: string; flaky?: boolean },
): number {
  const bySeverity = severityOf(a.status) - severityOf(b.status);
  if (bySeverity !== 0) return bySeverity;
  const byFlaky = Number(a.flaky ?? false) - Number(b.flaky ?? false);
  if (byFlaky !== 0) return byFlaky;
  return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function previewIdentity(pngBasename: string): string {
  return `preview:${pngBasename}`;
}

export function captureIdentity(slug: string): string {
  return `capture:${slug}`;
}

/**
 * A capture slug from a human label. Deliberately narrow: an identity ends up
 * in a URL query parameter and in a database key, so it stays lowercase
 * alphanumerics and single hyphens, with a fallback that is never empty.
 */
export function captureSlug(label: string, at: number): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base === "" ? `capture-${at}` : base;
}

/**
 * The sidecar filename for a preview PNG.
 *
 * Upstream derives it as `imageFileName.dropLast(".png".count) + ".json"` — a
 * plain suffix swap. Preview filenames contain embedded dots
 * (`MyModule_LoginView.swift_Dark_Mode.png`), so anything shaped like
 * "replace the extension" corrupts them. One function, used everywhere.
 */
export function sidecarFor(pngName: string): string {
  return pngName.endsWith(".png") ? `${pngName.slice(0, -".png".length)}.json` : `${pngName}.json`;
}

/**
 * Split a SnapshotPreviews filename into the group and the display name.
 *
 * `MyModule_LoginView.swift_Dark_Mode.png` reads as "Dark Mode" in
 * "MyModule / LoginView.swift". The split is presentational only — the
 * identity is always the whole filename, because that is what stays stable.
 */
export function describePreviewName(pngName: string): { groupName: string; displayName: string } {
  const stem = pngName.endsWith(".png") ? pngName.slice(0, -".png".length) : pngName;
  const parts = stem.split("_").filter((part) => part !== "");
  if (parts.length <= 1) return { groupName: "", displayName: stem };
  const displayName = parts[parts.length - 1]!.replace(/([a-z])([A-Z])/g, "$1 $2");
  return { groupName: parts.slice(0, -1).join(" / "), displayName };
}

// ---------------------------------------------------------------------------
// Device identity
// ---------------------------------------------------------------------------

/**
 * Baselines are per device class, not per device instance — you re-create a
 * simulator and the UDID changes while the pixels do not.
 *
 * The architecture is in the key because SnapshotPreviews' `gettimeofday` pin
 * is compiled out on x86_64, so an Intel machine legitimately produces
 * different baselines from an Apple silicon one and comparing them is noise.
 */
export function deviceKey(parts: {
  name: string;
  osVersion: string;
  scale: number;
  arch: string;
}): string {
  return [parts.name, parts.osVersion, String(parts.scale), parts.arch].join("|");
}

// ---------------------------------------------------------------------------
// Thresholds and the verdict ladder
// ---------------------------------------------------------------------------

/**
 * `diff_threshold` round-trips through `1 - precision` in `Float` upstream, so
 * a sidecar can hold `0.050000012` for what was written as `0.05`. Never
 * compare it exactly.
 */
export const THRESHOLD_EPSILON = 1e-6;

/**
 * Does this ratio exceed the threshold in force?
 *
 * `ratio` is a **fraction** of changed pixels, 0–1 — not the 0–100 percentage
 * odiff prints. The two are never allowed to meet; see `src/diff.ts`.
 */
export function exceedsThreshold(ratio: number, threshold: number): boolean {
  return ratio > threshold + THRESHOLD_EPSILON;
}

/** Per-frame sidecar threshold wins over the global setting. */
export function thresholdFor(frameThreshold: number | null, globalThreshold: number): number {
  return frameThreshold ?? globalThreshold;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

/**
 * Preview identity is the filename, and the filename breaks when a file moves,
 * when an anonymous `#Preview` shifts by a line, or when a `PreviewProvider`
 * preview shifts by an ordinal. A run where most identities changed at once is
 * far more likely to be a re-key than 112 simultaneous regressions.
 */
export const REKEY_FRACTION = 0.25;

/**
 * …but the fraction alone is not enough.
 *
 * The argument is *"this many simultaneous genuine regressions is
 * implausible"*, and that argument needs the count to be large. On a project
 * with three previews, changing two is 67% and completely ordinary — measured
 * on a real three-preview run, where a background colour edit produced "2 of 3
 * previews changed — that usually means previews were re-keyed rather than that
 * the UI moved. Did a file move?" above two correct diffs. A heuristic that
 * doubts the tool every time a small project changes teaches people to ignore
 * it by the time it is right.
 */
export const REKEY_MIN_CHANGED = 5;

export function looksLikeRekey(changedCount: number, totalCount: number): boolean {
  if (totalCount === 0) return false;
  if (changedCount < REKEY_MIN_CHANGED) return false;
  return changedCount / totalCount > REKEY_FRACTION;
}

/**
 * An identity that changed in most of its recent runs is reporting instability,
 * not a regression. It sorts below the stable changes and is labelled with the
 * fact — "changed in 3 of the last 5 runs" — which is shorter than defending
 * the word "flaky".
 */
export const FLAKY_MIN_RUNS = 5;
export const FLAKY_MIN_CHANGES = 3;

export function isFlaky(changedRuns: number, totalRuns: number): boolean {
  if (totalRuns < FLAKY_MIN_RUNS) return false;
  return changedRuns >= FLAKY_MIN_CHANGES;
}

/**
 * Detect a truncated run: one trapping preview takes the whole XCTest runner
 * down, and every later preview in that class is lost. The tail of the sorted
 * manifest goes missing in one contiguous block.
 *
 * Returns the identity the run stopped after and how many never rendered, or
 * `null` when the missing set is scattered — in which case they really are
 * individual failures and deserve individual rows.
 */
export function detectTruncation(
  manifestSorted: readonly string[],
  missing: ReadonlySet<string>,
): { stoppedAfter: string; neverReached: number } | null {
  if (missing.size < 2 || manifestSorted.length === 0) return null;

  // Walk back from the end while every name is missing.
  let firstMissing = manifestSorted.length;
  while (firstMissing > 0 && missing.has(manifestSorted[firstMissing - 1]!)) firstMissing -= 1;

  const tailLength = manifestSorted.length - firstMissing;
  // The tail has to account for the whole missing set, or it is not a
  // truncation — a scattered miss with an unlucky last entry must not read as
  // "the runner stopped here".
  if (tailLength !== missing.size) return null;
  if (firstMissing === 0) return null; // everything missing: that is a failed run, not a truncated one

  return { stoppedAfter: manifestSorted[firstMissing - 1]!, neverReached: tailLength };
}

// ---------------------------------------------------------------------------
// The banner watermark
// ---------------------------------------------------------------------------

/**
 * Dismissing the "12 previews moved" banner watermarks the **set of changed
 * identities**, not a timestamp: it stays gone through re-renders of the same
 * twelve and comes back the moment a thirteenth changes.
 */
export function watermarkOf(identities: readonly string[]): string {
  return [...identities].sort().join(" ");
}

export function isDismissed(watermark: string | null, identities: readonly string[]): boolean {
  if (watermark === null) return false;
  return watermark === watermarkOf(identities);
}

// ---------------------------------------------------------------------------
// Empty is never success
// ---------------------------------------------------------------------------

/**
 * A stills run may claim everything matched **only** when the manifest ran, it
 * gave a denominator above zero, and every name in it produced a frame.
 *
 * Any other empty result is "nothing rendered — here is why". A full set of
 * `added` is not empty, and an empty set is not agreement.
 */
export function mayClaimUnchanged(look: Pick<Look, "manifestRan" | "expectedCount" | "frameCount">): boolean {
  return (
    look.manifestRan &&
    look.expectedCount !== null &&
    look.expectedCount > 0 &&
    look.frameCount === look.expectedCount
  );
}

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID: 48 bits of millisecond timestamp then 80 bits of randomness, in
 * Crockford base32. Lexicographic order matches creation order, which is what
 * makes `ORDER BY id` meaningful and keeps the index tidy.
 */
export function ulid(now: number, random: () => number = Math.random): string {
  let time = "";
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[remaining % 32]! + time;
    remaining = Math.floor(remaining / 32);
  }
  let entropy = "";
  for (let i = 0; i < 16; i += 1) {
    entropy += CROCKFORD[Math.floor(random() * 32)]!;
  }
  return time + entropy;
}

/** A commit for display. Short, and never presented as if it were the full sha. */
export function shortShaOf(sha: string | null): string | null {
  if (sha === null || sha.length < 7) return sha;
  return sha.slice(0, 7);
}

export const LOOK_ID_PATTERN = /^lk_[0-9A-HJKMNP-TV-Z]{26}$/;
export const FRAME_ID_PATTERN = /^fr_[0-9A-HJKMNP-TV-Z]{26}$/;

export function newLookId(now: number, random?: () => number): string {
  return `lk_${ulid(now, random)}`;
}

export function newFrameId(now: number, random?: () => number): string {
  return `fr_${ulid(now, random)}`;
}
