/**
 * The composer banner's state, as a pure function.
 *
 * At most two rows, in this priority:
 *
 * 1. **A failed run.** A run you kicked off and walked away from must tell you
 *    when it dies, in the surface whose whole purpose is telling you about work
 *    you are not watching. Dismissible, watermarked on the look id, because
 *    there is no changed-identity set to watermark.
 * 2. **A run in flight or freshly settled in this thread.** Dismissible, and
 *    the watermark is the **set of changed identities** rather than a
 *    timestamp: dismiss it and it stays gone through re-renders of the same
 *    twelve, and returns the moment a thirteenth changes.
 * 3. **An active exposure.** Not dismissible. A trust indicator you can hide is
 *    not one.
 *
 * The live stream is deliberately not in the banner. A 60fps video underneath
 * the text you are typing, in a stack already competing with bb's own context,
 * todo and workflow cards, is a worse place for it than a panel you chose to
 * open.
 */
import { isDismissed, shortShaOf, watermarkOf, type Look, type VerdictStatus } from "./model.js";
import { formatRemaining } from "./format.js";

export type BannerTone = "neutral" | "dead" | "exposed";

export interface BannerRow {
  id: string;
  kind: "failure" | "run" | "exposure";
  sentence: string;
  tone: BannerTone;
  dismissible: boolean;
  /** The look this row is about, for the dismissal and for "open the panel". */
  lookId: string | null;
  /** The watermark a dismissal would write. */
  watermark: string | null;
}

export interface BannerInput {
  look: (Look & { changedIdentities: readonly string[]; baseCommit: string | null }) | null;
  /** The dismissal already recorded for this thread and look, if any. */
  dismissed: string | null;
  /** `null` when nothing is exposed. */
  exposure: { msLeft: number } | null;
  /** Off when the user turned `postChangedPreviews` off. */
  offerRuns: boolean;
}

/** At most two rows, so the prompt stack does not become a dashboard. */
export const MAX_ROWS = 2;

export function bannerRows(input: BannerInput): BannerRow[] {
  const rows: BannerRow[] = [];
  const look = input.look;

  if (look !== null && input.offerRuns) {
    if (look.status === "failed") {
      const watermark = `failed:${look.id}`;
      if (!isDismissedFailure(input.dismissed, watermark)) {
        rows.push({
          id: `failure:${look.id}`,
          kind: "failure",
          sentence: failureSentence(look),
          tone: "dead",
          dismissible: true,
          lookId: look.id,
          watermark,
        });
      }
    } else if (look.status === "running") {
      rows.push({
        id: `run:${look.id}`,
        kind: "run",
        sentence:
          look.expectedCount === null
            ? "Rendering previews…"
            : `Rendering previews — ${look.frameCount}/${look.expectedCount}`,
        tone: "neutral",
        // A progress row is not something you dismiss; it goes when it is done.
        dismissible: false,
        lookId: look.id,
        watermark: null,
      });
    } else if (look.status === "ok" && look.changedIdentities.length > 0) {
      const watermark = watermarkOf(look.changedIdentities);
      if (!isDismissed(input.dismissed, look.changedIdentities)) {
        const base = shortShaOf(look.baseCommit);
        rows.push({
          id: `run:${look.id}`,
          kind: "run",
          sentence: `${look.changedIdentities.length} ${
            look.changedIdentities.length === 1 ? "preview" : "previews"
          } moved${base === null ? "" : ` since \`${base}\``}`,
          tone: "neutral",
          dismissible: true,
          lookId: look.id,
          watermark,
        });
      }
    }
  }

  if (input.exposure !== null) {
    rows.push({
      id: "exposure",
      kind: "exposure",
      sentence: `Simulator exposed to your bb account — ${formatRemaining(input.exposure.msLeft)}`,
      tone: "exposed",
      // A trust indicator you can hide is not one.
      dismissible: false,
      lookId: null,
      watermark: null,
    });
  }

  // The exposure outranks a run, because a trust state outranks a liveness one.
  return rows.sort((a, b) => rank(b) - rank(a)).slice(0, MAX_ROWS);
}

function rank(row: BannerRow): number {
  switch (row.kind) {
    case "exposure":
      return 2;
    case "failure":
      return 1;
    case "run":
      return 0;
  }
}

/** A failure row is watermarked on the look id: there is no changed set. */
function isDismissedFailure(dismissed: string | null, watermark: string): boolean {
  return dismissed === watermark;
}

export function failureSentence(look: Look): string {
  const error = look.error ?? "";
  if (/no snapshot target|SnapshottingTests/i.test(error)) {
    return "Preview render failed — this project has no snapshot target.";
  }
  if (/Build failed|exit 65|did not compile/i.test(error)) {
    return "Preview render failed — the build did not compile.";
  }
  if (error === "") return "Preview render failed.";
  // The first line only: the banner is a notice, and the panel has the rest.
  return `Preview render failed — ${error.split("\n")[0]!.slice(0, 120)}`;
}

/** Identities the banner counts as "moved". */
export function changedIdentitiesOf(
  verdicts: ReadonlyArray<{ identity: string; status: VerdictStatus }>,
): string[] {
  return verdicts
    .filter((verdict) => verdict.status === "changed" || verdict.status === "layout-changed")
    .map((verdict) => verdict.identity)
    .sort();
}
