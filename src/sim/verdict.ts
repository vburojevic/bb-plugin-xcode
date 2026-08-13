/**
 * Turning a run into one sentence and an ordered list.
 *
 * **An empty set is never allowed to mean success**, and the rule applies in
 * four places rather than one:
 *
 * - *"Everything looks the same"* renders only when `manifest_ran = 1 AND
 *   expected_count > 0 AND frame_count = expected_count`. Any other empty
 *   result renders "nothing rendered — here is why".
 * - A failed `simctl list` is not "no devices exist".
 * - A first run against a device class with no baseline is not 148
 *   regressions.
 * - A failed thread-link read renders **no banner** and logs. The banner is an
 *   offer; the panel is the surface that must never lie.
 */
import { compareForDisplay, detectTruncation, looksLikeRekey, mayClaimUnchanged, shortShaOf, type Look, type VerdictStatus } from "./model.js";

/** Missing rows are capped, then the rest collapse into one line. */
export const MISSING_ROW_CAP = 10;

export interface VerdictRow {
  identity: string;
  displayName: string;
  groupName: string;
  status: VerdictStatus;
  diffRatio: number | null;
  flaky: boolean;
  /** `changed in 3 of the last 5 runs` — the fact, not the word. */
  flakyDetail: string | null;
}

export interface RunSummary {
  /** The one sentence at the top, sticky. */
  sentence: string;
  /** Set when the run looks like a re-key rather than 112 regressions. */
  rekey: { changed: number; total: number; realCount: number } | null;
  /** Set when the runner stopped partway and the tail is contiguous. */
  truncation: { stoppedAfter: string; neverReached: number } | null;
  /** Rows in failure-first order. */
  rows: VerdictRow[];
  counts: Record<VerdictStatus, number>;
  /** Rows beyond the missing cap, collapsed into a count. */
  missingOverflow: number;
  /** True when odiff was absent: the run rendered but compared nothing. */
  undiffed: boolean;
}

export interface SummaryInput {
  look: Look;
  rows: VerdictRow[];
  /** The sorted manifest, for the truncation heuristic. */
  manifest: readonly string[];
  baseCommit: string | null;
  /** True when there was nothing to compare against. */
  firstRun: boolean;
  undiffed: boolean;
}

function countBy(rows: readonly VerdictRow[]): Record<VerdictStatus, number> {
  const counts: Record<VerdictStatus, number> = {
    unchanged: 0,
    changed: 0,
    "layout-changed": 0,
    added: 0,
    removed: 0,
    missing: 0,
    errored: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

export function summarize(input: SummaryInput): RunSummary {
  const counts = countBy(input.rows);
  const rows = [...input.rows].sort(compareForDisplay);
  const changed = counts.changed + counts["layout-changed"];
  const total = input.look.expectedCount ?? input.rows.length;
  const missing = new Set(input.rows.filter((row) => row.status === "missing").map((row) => row.identity));

  const truncation = detectTruncation(
    input.manifest.map((name) => `preview:${name}`),
    missing,
  );

  const rekey =
    looksLikeRekey(changed, total) && total > 0
      ? { changed, total, realCount: Math.max(0, changed - counts.added - counts.removed) }
      : null;

  const base = shortShaOf(input.baseCommit);

  let sentence: string;
  if (input.look.status === "running") {
    sentence = "Rendering previews…";
  } else if (input.look.status === "failed") {
    sentence = input.look.error ?? "The preview render failed.";
  } else if (input.undiffed) {
    // Rendering without diffing is useful; failing the run is not.
    sentence = `Rendered ${input.look.frameCount} previews. odiff is missing, so nothing was compared.`;
  } else if (input.firstRun) {
    sentence = `First run on ${input.look.deviceName ?? "this device"} — ${input.look.frameCount} previews rendered, nothing to compare against yet.`;
  } else if (counts.missing > 0 || counts.errored > 0) {
    const broken = counts.missing + counts.errored;
    sentence = `${broken} of ${total} previews did not render.`;
  } else if (changed > 0) {
    sentence = `${changed} of ${total} previews changed${base === null ? "" : ` since \`${base}\``}.`;
  } else if (counts.added > 0 || counts.removed > 0) {
    // Nothing *changed*, but the set did. Falling through to the unchanged
    // claim here printed "Everything looks the same as `f54fefe`" above a list
    // of three previews that did not exist in `f54fefe` — technically about the
    // pixels of the previews they had in common, and read by everyone as a
    // claim about the whole run.
    sentence = `${describeSetChange(counts.added, counts.removed)}. Nothing else changed${base === null ? "" : ` since \`${base}\``}.`;
  } else if (mayClaimUnchanged(input.look)) {
    sentence = `Everything looks the same${base === null ? "" : ` as \`${base}\``}.`;
  } else {
    // The load-bearing branch: an empty result that has not earned the claim.
    sentence = describeEmpty(input.look);
  }

  return {
    sentence,
    rekey,
    truncation,
    rows,
    counts,
    missingOverflow: Math.max(0, counts.missing - MISSING_ROW_CAP),
    undiffed: input.undiffed,
  };
}

/** "3 new previews", "1 preview is gone", "3 new previews and 1 gone". */
export function describeSetChange(added: number, removed: number): string {
  const newOnes = added === 1 ? "1 new preview" : `${added} new previews`;
  if (added > 0 && removed > 0) return `${newOnes} and ${removed} gone`;
  if (added > 0) return newOnes;
  return removed === 1 ? "1 preview is gone" : `${removed} previews are gone`;
}

/**
 * Why an empty run is empty.
 *
 * Every branch names something specific, because "nothing rendered" with no
 * reason is indistinguishable from success to anyone who has not read the code.
 */
export function describeEmpty(look: Look): string {
  if (!look.manifestRan) {
    return "Nothing rendered, and the manifest pass did not report how many previews there are — so this cannot tell you whether that is right.";
  }
  if (look.expectedCount === 0) {
    return "The manifest pass found no previews at all. Check that the test target is hosted by your app: an unhosted logic test never loads the app binary, so the preview scan finds nothing.";
  }
  if (look.frameCount === 0) {
    return `The manifest pass found ${look.expectedCount} previews and none of them rendered.`;
  }
  return `${look.frameCount} of ${look.expectedCount} previews rendered.`;
}

/**
 * The re-key line, which gets its own primary action.
 *
 * Preview identity is the filename, and the filename breaks when a file moves,
 * when an anonymous `#Preview` shifts by a line, when a `PreviewProvider`
 * preview shifts by an ordinal, or when two previews share a display name. The
 * state where you are least sure what happened is not the state to promote an
 * irreversible action to primary — so the primary becomes *"Show me the N that
 * actually moved"*, not *"Accept as new baseline"*.
 */
export function rekeySentence(rekey: NonNullable<RunSummary["rekey"]>): string {
  return `${rekey.changed} of ${rekey.total} previews changed — that usually means previews were re-keyed rather than that the UI moved. Did a file move?`;
}

export function rekeyPrimaryLabel(rekey: NonNullable<RunSummary["rekey"]>): string {
  return `Show me the ${rekey.realCount} that actually moved`;
}

/**
 * The truncation line.
 *
 * One trapping preview takes the whole XCTest runner down and every later
 * preview in that class is lost, leaving a truncated but perfectly valid-looking
 * export. Sixty-one rows saying "did not render" describe the symptom; one line
 * naming where it stopped describes the cause.
 */
export function truncationSentence(truncation: NonNullable<RunSummary["truncation"]>): string {
  const name = truncation.stoppedAfter.replace(/^preview:/, "").replace(/\.png$/, "");
  return `The test runner stopped after \`${name}\` — ${truncation.neverReached} later previews were never reached.`;
}

/** *"`LoginView / Dark Mode` did not render."* */
export function missingSentence(row: VerdictRow): string {
  const name = row.groupName === "" ? row.displayName : `${row.groupName} / ${row.displayName}`;
  return `\`${name}\` did not render.`;
}
