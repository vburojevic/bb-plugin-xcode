/**
 * Comparing two runs.
 *
 * ## The units, which are the whole problem
 *
 * odiff's `--parsable-stdout` prints `count;percentage` where the percentage is
 * `100 * diff_count / total`, rounded to two decimals. The per-frame threshold
 * in a sidecar is a **fraction**, 0–1. Comparing them marks essentially every
 * frame changed, and a real 0.004% diff also prints as `0.00`. So the ratio is
 * computed here from the count and the pixel dimensions, and the two quantities
 * are named `colorDelta` and `diffRatio` so nobody conflates them again.
 *
 * ## Three measured corrections to the flags
 *
 * `--parsable-stdout` prints a bare `0` — not `0;0.00` — when nothing differs.
 * A parser that splits on `;` and reads field `[1]` gets `undefined` on every
 * unchanged frame, which is the common case.
 *
 * `--fail-on-layout` is passed. Without it, odiff silently compares images of
 * different sizes: 8×8 against 8×10 returned `16;20.00` and exit 22 — a
 * fabricated 20% regression, with the percentage over the *larger* image's 80
 * pixels.
 *
 * `--antialiasing` is **not** passed, against the design's instruction. It
 * suppressed a single changed pixel entirely — `0` and exit 0 where the truth
 * was `1;1.56` — and reduced a four-pixel change to three. A hairline border, a
 * one-point offset and a thin divider are exactly what this exists to catch,
 * and these are two renders of the same view by the same renderer on the same
 * device rather than a screenshot compared across platforms. The per-frame
 * ratio threshold is the right place to absorb noise, because it is visible in
 * the Facts section and overridable per frame.
 */
import { run } from "./exec.js";
import { exceedsThreshold, thresholdFor, type VerdictStatus } from "./model.js";

/** odiff's documented exit codes. `21` only happens with `--fail-on-layout`. */
export const EXIT_IDENTICAL = 0;
export const EXIT_LAYOUT = 21;
export const EXIT_PIXELS = 22;

/**
 * The per-pixel colour delta, at odiff's documented default.
 *
 * A different quantity from the changed-pixel ratio the verdict reasons about.
 * Setting it to `0` is maximum sensitivity to encoder noise, so it stays where
 * upstream put it and all verdict work happens on the ratio.
 */
export const DEFAULT_COLOR_DELTA = 0.1;

export interface OdiffOutput {
  /** Changed pixels. `null` when odiff refused to compare. */
  count: number | null;
  layout: boolean;
  error: string | null;
}

/**
 * Parse `--parsable-stdout`.
 *
 * Handles the bare `0`, the `count;percentage` pair, and the literal `layout`.
 * The percentage is deliberately discarded: it is rounded to two decimals, so
 * it cannot express the difference between 0.004% and nothing.
 */
export function parseOdiffOutput(stdout: string, exitCode: number | null): OdiffOutput {
  const text = stdout.trim();
  if (text === "layout" || exitCode === EXIT_LAYOUT) return { count: null, layout: true, error: null };
  if (text === "" && exitCode === EXIT_IDENTICAL) return { count: 0, layout: false, error: null };

  const [first] = text.split(";");
  const count = Number.parseInt(first ?? "", 10);
  if (Number.isFinite(count)) return { count, layout: false, error: null };

  return { count: null, layout: false, error: text === "" ? `odiff exited ${exitCode ?? "?"}` : text };
}

/** `diff_count / (width * height)`, a fraction. Never odiff's percentage. */
export function ratioFrom(count: number, width: number, height: number): number {
  const total = width * height;
  if (total <= 0) return 0;
  return count / total;
}

export interface DiffInput {
  odiffPath: string;
  basePath: string;
  headPath: string;
  maskPath: string;
  /** From the head frame's IHDR, so the ratio's denominator is real. */
  width: number;
  height: number;
  signal?: AbortSignal;
}

export interface DiffOutput {
  status: Extract<VerdictStatus, "unchanged" | "changed" | "layout-changed" | "errored">;
  diffRatio: number | null;
  diffPixels: number | null;
  /** `null` when odiff wrote no mask — it only writes one when there is a diff. */
  maskWritten: boolean;
  error: string | null;
}

/**
 * The third rung of the ladder: run odiff.
 *
 * The first two rungs live in `compareFrames` and eliminate roughly 130 of 148
 * previews before this is called at all.
 */
export async function runOdiff(input: DiffInput): Promise<DiffOutput> {
  let result;
  try {
    result = await run(
      input.odiffPath,
      [
        input.basePath,
        input.headPath,
        input.maskPath,
        "--parsable-stdout",
        // Only this emits "changed pixels over a transparent background". The
        // default output is the comparison image with changed pixels painted
        // in, and overlaying that at 40% renders a washed-out second copy of
        // the frame rather than a highlight.
        "--diff-mask",
        // So odiff and the IHDR pre-check agree rather than merely not
        // contradicting each other.
        "--fail-on-layout",
      ],
      { timeoutMs: 60_000, signal: input.signal },
    );
  } catch (error) {
    return {
      status: "errored",
      diffRatio: null,
      diffPixels: null,
      maskWritten: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = parseOdiffOutput(result.stdout, result.code);
  if (parsed.layout) {
    return { status: "layout-changed", diffRatio: null, diffPixels: null, maskWritten: false, error: null };
  }
  if (parsed.error !== null) {
    return { status: "errored", diffRatio: null, diffPixels: null, maskWritten: false, error: parsed.error };
  }
  const count = parsed.count ?? 0;
  return {
    status: count === 0 ? "unchanged" : "changed",
    diffRatio: ratioFrom(count, input.width, input.height),
    diffPixels: count,
    maskWritten: count > 0,
    error: null,
  };
}

export interface FramePair {
  identity: string;
  base: { contentHash: string; width: number; height: number; relPath: string } | null;
  head: { contentHash: string; width: number; height: number; relPath: string; diffThreshold: number | null } | null;
}

export type Rung = "hash" | "dimensions" | "odiff" | "none";

export interface Comparison {
  identity: string;
  status: VerdictStatus;
  diffRatio: number | null;
  diffPixels: number | null;
  /** Which rung decided it, for the log and for the tests. */
  rung: Rung;
}

/**
 * The first two rungs, which are free.
 *
 * Identical `content_hash` → `unchanged`. Different dimensions →
 * `layout-changed`, with no mask, because odiff produces none for a dimension
 * mismatch and a fabricated one would be a lie. At 148 previews the first rung
 * usually eliminates 130.
 *
 * Returns `null` when the pair needs odiff.
 */
export function compareCheaply(pair: FramePair, missing: ReadonlySet<string>): Comparison | null {
  if (missing.has(pair.identity)) {
    // In the manifest and not on disk. Never `removed`: "you deleted this
    // preview" and "this preview crashed" are opposite facts.
    return { identity: pair.identity, status: "missing", diffRatio: null, diffPixels: null, rung: "none" };
  }
  if (pair.head === null) {
    return { identity: pair.identity, status: "removed", diffRatio: null, diffPixels: null, rung: "none" };
  }
  if (pair.base === null) {
    return { identity: pair.identity, status: "added", diffRatio: null, diffPixels: null, rung: "none" };
  }
  if (pair.base.contentHash === pair.head.contentHash) {
    return { identity: pair.identity, status: "unchanged", diffRatio: 0, diffPixels: 0, rung: "hash" };
  }
  if (pair.base.width !== pair.head.width || pair.base.height !== pair.head.height) {
    return {
      identity: pair.identity,
      status: "layout-changed",
      diffRatio: null,
      diffPixels: null,
      rung: "dimensions",
    };
  }
  return null;
}

/**
 * Apply the threshold to an odiff result.
 *
 * The per-frame threshold is this plugin's, not the diff engine's: odiff runs
 * at its defaults and reports everything, and the decision happens here.
 */
export function applyThreshold(
  output: DiffOutput,
  frameThreshold: number | null,
  globalThreshold: number,
): Extract<VerdictStatus, "unchanged" | "changed" | "layout-changed" | "errored"> {
  if (output.status !== "changed") return output.status;
  const threshold = thresholdFor(frameThreshold, globalThreshold);
  return exceedsThreshold(output.diffRatio ?? 0, threshold) ? "changed" : "unchanged";
}
