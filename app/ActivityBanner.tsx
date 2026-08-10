/**
 * Live Xcode activity, in the prompt stack above the composer. The plugin's
 * only build-status surface, and the only one it has ever needed.
 *
 * This replaced a delivery mechanism that asked the AGENT to echo a
 * `::xcode{…}` directive after starting a build. That handoff had three
 * failure modes, all of them observed in production:
 *
 *  - the injected prompt 409s when the thread is awaiting a user interaction
 *    (a permission prompt fires exactly when a build starts), and nothing
 *    retried — so the build ran to completion with no card at all;
 *  - the model re-emitted the directive in later messages, so one build grew
 *    three independent live cards that disagreed with each other;
 *  - every `xcodebuild -find <tool>` lookup spent a turn asking for a card
 *    nobody wanted.
 *
 * A banner has none of those: the host mounts it, it reads the thread's active
 * runs straight from the tracker, and it renders nothing when nothing is
 * building. Zero, one, or five builds all render correctly without the model
 * being involved or even aware. The directive is gone entirely, renderer
 * included — nothing this plugin shows can be changed by what a model says.
 * Finished runs live in the nav panel and `bb xcode status`, not in chat.
 *
 * The frame is `.bbx-stack-card` — a copy of the host's PromptStackCard driven
 * by the host's own CSS variables. We draw it ourselves rather than take
 * `chrome: "card"` because the host mounts plugin banners under a
 * `display: contents` wrapper, and the stack spaces itself with `space-y-2`;
 * a contents box drops that margin, so a host-framed banner sits flush against
 * the card below it. Owning the frame lets us own the 8px too.
 *
 * ## Several builds at once
 *
 * Concurrent runs are normal here, not an edge case: one `build_app.sh` can
 * spawn xcodebuild several times, and a thread commonly builds while a test
 * run is still going. So every live run gets its OWN expandable row inside one
 * card, rather than a headline run plus a "+N more" tally nobody can open.
 *
 * Three rules keep that from turning into a wall above the composer:
 *
 *  - rows are ordered by start time ASCENDING, so a new build appends at the
 *    bottom and no existing row moves under the pointer;
 *  - at most `MAX_ROWS` are drawn; the rest collapse into one counted line,
 *    because past a handful the individual identities stop being useful and
 *    the only question left is "how many";
 *  - detail is fetched per row, on expand, so N collapsed rows still cost the
 *    single banner-wide request they always did.
 */

import { useComposerView } from "@bb/plugin-sdk/app";

import { cn } from "@/lib/utils";

import { XcodeActivityRow } from "./ActivityRow";
import { activityMetaClass, runActivityState } from "./activity-styles";
import { RunDetail } from "./RunDetail";
import { isLive, statusClass, type RunDto } from "./status-types";
import { useChatStatus, useLiveTick } from "./useChatStatus";

/** `PROMPT_STACK_CARD_ROW_HEIGHT` in the host's PromptStackCard. */
const PROMPT_STACK_CARD_ROW_HEIGHT = 32;

/**
 * Rows drawn before the rest become a tally. Four keeps the card shorter than
 * the composer it sits above even when every row is a full-width build.
 */
const MAX_ROWS = 4;

export function XcodeActivityBanner() {
  const view = useComposerView();
  if (view.scope.kind !== "thread") return null;
  return <XcodeActivityBannerLoaded threadId={view.scope.threadId} />;
}

function XcodeActivityBannerLoaded({ threadId }: { threadId: string }) {
  const { data } = useChatStatus(threadId, null);
  const runs = liveRuns(data?.run ?? null, data?.active ?? []);
  useLiveTick(runs.length > 0);

  // Nothing live renders nothing at all — frame included, so the stack closes
  // up rather than keeping an empty card above the composer.
  if (runs.length === 0) return null;

  const shown = runs.slice(0, MAX_ROWS);
  const overflow = runs.length - shown.length;

  return (
    <section
      aria-label="Xcode activity"
      className={cn("bbx-stack-card bbx-tinted", statusClass(dominant(runs).status))}
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      {shown.map((run, index) => (
        // A hairline between rows, never above the first — the card's own
        // border already closes that edge.
        <div key={run.id} className={cn(index > 0 && "border-t border-border/60")}>
          <XcodeActivityRow run={run}>
            <RunDetailForRun threadId={threadId} run={run} />
          </XcodeActivityRow>
        </div>
      ))}
      {overflow > 0 ? (
        <div
          className={activityMetaClass(
            "muted",
            "border-t border-border/60 px-3 py-1 text-xs",
          )}
        >
          +{overflow} more running
        </div>
      ) : null}
    </section>
  );
}

/**
 * `chatStatus` only returns findings for the run it focused, so an expanded
 * row asks for its own. Mounted by the disclosure, which means the extra rpc
 * is paid only by rows someone actually opened.
 */
function RunDetailForRun({ threadId, run }: { threadId: string; run: RunDto }) {
  const { data } = useChatStatus(threadId, run.id);
  const detailed = data?.run?.id === run.id ? data.run : run;
  return (
    <RunDetail
      run={detailed}
      findings={data?.findings ?? []}
      failedTests={data?.failedTests ?? []}
    />
  );
}

/**
 * Which run's status colours the card. Trouble outranks progress: if anything
 * in this card is failing, the frame says so even when four other builds are
 * happily compiling.
 */
function dominant(runs: readonly RunDto[]): RunDto {
  const order: Record<string, number> = {
    failed: 0,
    running: 1,
    finishing: 2,
    warnings: 3,
    passed: 4,
  };
  return [...runs].sort(
    (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9),
  )[0]!;
}

/**
 * Not everything xcodebuild does is a build worth a row.
 *
 * `xcodebuild -find <tool>` and `-version` are toolchain lookups the SDK fires
 * constantly — measured on this machine, a third of all attributed runs, in
 * bursts of ten, several of them 0ms. They are real xcodebuild processes, so
 * the tracker is right to record them; they are not work anyone is waiting on,
 * so the banner is right to ignore them. They are recognisable by having no
 * scheme and no derived-data root — a real build always resolves at least one.
 *
 * `package` and `index` match the store's own noise definition (store.ts).
 */
function isNoise(run: RunDto): boolean {
  if (run.kind === "package" || run.kind === "index") return true;
  return run.kind === "unknown" && run.scheme === null && run.root === null;
}

/**
 * `chatStatus` returns a focused run plus the rest of the scope's unresolved
 * runs, and the focused one may be a finished run when nothing is live. The
 * banner shows in-flight work only — a finished build belongs in the history
 * panel, not pinned above the composer forever.
 */
function liveRuns(focus: RunDto | null, active: readonly RunDto[]): RunDto[] {
  const out: RunDto[] = [];
  const seen = new Set<string>();
  for (const run of [focus, ...active]) {
    if (!run || seen.has(run.id) || !isLive(run) || isNoise(run)) continue;
    seen.add(run.id);
    out.push(run);
  }
  // Oldest first: a new build appends at the bottom instead of shoving the
  // rows you were reading downward.
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
