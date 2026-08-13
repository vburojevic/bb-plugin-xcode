/**
 * The panel: toolbar, day-grouped activity log, inline detail, trends.
 *
 * Master–detail on wide viewports; single pane below `lg`. Selection lives in
 * the URL on the nav-panel surface (back/forward and deep links work) and in
 * tab-local state on the thread-panel surface.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { XCODE_CHANNEL } from "../src/channel";
import type { rpcContract } from "../src/contract";
import { formatRelative } from "./format";
import { RunDetailPanel } from "./RunDetailPanel";
import { RunLog, type RunSummary, isActive } from "./RunLog";
import { Trends } from "./Trends";
import { EmptyState } from "./primitives";

interface Overview {
  runs: RunSummary[];
  total: number;
  projects: Array<{ id: string; name: string; path: string }>;
  rootCount: number;
  lastScanAt: number | null;
  xcodeAvailable: boolean;
  shimInstalled: boolean;
  shimActive: boolean;
  verdictlessRuns: number;
  simulators: Array<{ udid: string; name: string; os: string; state: string }>;
}

const ALL = "__all__";
type View = "activity" | "trends";

function XcodePanelView({
  selectedId,
  select,
}: {
  selectedId: string | null;
  select: (id: string | null) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  // The shared, listener-deduplicating hook rather than a private matchMedia
  // effect: every row, tooltip and overlay in this panel already goes through
  // it, so this adds no second browser listener.
  const wide = useMediaQuery("(min-width: 1024px)");

  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [kind, setKind] = useState<"build" | "test" | null>(null);
  const [view, setView] = useState<View>("activity");
  const [rescanning, setRescanning] = useState(false);

  const refresh = useCallback(() => {
    void rpc
      .call("overview", { projectId, kind, limit: 100 })
      .then((result) => setOverview(result as unknown as Overview))
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [rpc, projectId, kind]);

  useEffect(refresh, [refresh]);

  // Plugin signals are ephemeral; reconcile whenever the socket comes back.
  useEffect(() => {
    if (connection === "connected") refresh();
  }, [connection, refresh]);

  useRealtime(XCODE_CHANNEL, refresh);

  const runs = overview?.runs ?? [];
  const activeCount = useMemo(() => runs.filter(isActive).length, [runs]);

  // A missing id is NOT cleared: it can be legitimately absent from the list
  // (page limit, kind filter) and the detail pane fetches by id anyway. The
  // detail pane itself reports a truly deleted run.

  // Wide screens are a permanent two-pane layout. Full-bleed log rows at
  // 1400px were mostly dead space between the title and the numbers; a fixed
  // comfortable list plus an always-on detail pane spends that width on
  // something. With nothing explicitly selected, the newest run fills it.
  const effectiveId =
    selectedId ?? (wide && view === "activity" ? (runs[0]?.id ?? null) : null);
  const showDetail = effectiveId !== null;
  const showList = wide || selectedId === null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(value: string) => value && setView(value as View)}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="activity">Activity</ToggleGroupItem>
          <ToggleGroupItem value="trends">Trends</ToggleGroupItem>
        </ToggleGroup>

        {(overview?.projects.length ?? 0) > 1 ? (
          <Select
            value={projectId ?? ALL}
            onValueChange={(value) => setProjectId(value === ALL ? null : value)}
          >
            <SelectTrigger className="h-8 w-[10rem]">
              <SelectValue placeholder="All projects" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>All projects</SelectItem>
                {overview!.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}

        {view === "activity" ? (
          <Select
            value={kind ?? ALL}
            onValueChange={(value) =>
              setKind(value === ALL ? null : (value as "build" | "test"))
            }
          >
            <SelectTrigger className="h-8 w-[8rem]">
              <SelectValue placeholder="Everything" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value={ALL}>Everything</SelectItem>
                <SelectItem value="build">Builds</SelectItem>
                <SelectItem value="test">Tests</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {(overview?.simulators.length ?? 0) > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon name="Smartphone" aria-hidden />
                  <span className="tabular-nums">{overview!.simulators.length}</span>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <div className="flex flex-col gap-0.5">
                  {overview!.simulators.slice(0, 8).map((sim) => (
                    <span key={sim.udid}>
                      {sim.name} · {sim.os}
                    </span>
                  ))}
                  {overview!.simulators.length > 8 ? (
                    <span>+{overview!.simulators.length - 8} more booted</span>
                  ) : null}
                </div>
              </TooltipContent>
            </Tooltip>
          ) : null}
          {activeCount > 0 ? (
            <span className="flex items-center gap-1.5 text-xs text-primary">
              <span className="relative flex size-2">
                <span className="bb-xcode-ping absolute inline-flex size-full rounded-full bg-primary/60" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              {activeCount} active
            </span>
          ) : overview ? (
            // `total` and `lastScanAt` were both shipped in the payload and
            // both discarded, leaving a bare root count that answers a question
            // nobody has. How much history there is, and how fresh it is, are
            // the two facts that make a quiet panel trustworthy rather than
            // ambiguous — an empty list means "nothing built", not "not looking".
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {overview.total} run{overview.total === 1 ? "" : "s"}
                </span>
              </TooltipTrigger>
              <TooltipContent>
                <div className="flex flex-col gap-0.5">
                  <span>
                    {overview.rootCount} DerivedData root
                    {overview.rootCount === 1 ? "" : "s"} watched
                  </span>
                  <span>
                    {overview.lastScanAt
                      ? `Last swept ${formatRelative(overview.lastScanAt)}`
                      : "No sweep completed yet"}
                  </span>
                </div>
              </TooltipContent>
            </Tooltip>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setRescanning(true);
              void rpc
                .call("rescan")
                .then((result) => {
                  toast.success(`${result.rootCount} DerivedData root(s) tracked`);
                  refresh();
                })
                .catch(() => toast.error("Scan failed"))
                .finally(() => setRescanning(false));
            }}
            disabled={rescanning}
            aria-label="Rescan for builds"
          >
            <Icon
              name={rescanning ? "Loading" : "ArrowReloadHorizontal"}
              aria-hidden
              className={rescanning ? "animate-spin" : undefined}
            />
          </Button>
        </div>
      </div>

      {view === "trends" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <Trends projectId={projectId} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {showList ? (
            // Native scroll, not ScrollArea: radix sizes its viewport content
            // at max-content, which defeated row truncation and pushed the
            // duration/time columns out of view (measured).
            <div
              className={cn(
                "min-h-0 overflow-y-auto",
                wide && showDetail
                  ? "w-[26rem] shrink-0 border-r border-border"
                  : "flex-1",
              )}
            >
              <div className={cn("p-2", !showDetail && "mx-auto max-w-3xl")}>
              {overview && !overview.xcodeAvailable ? (
                <div className="p-2">
                  <EmptyState
                    icon="AlertTriangle"
                    title="Xcode tools not found"
                    description="`xcrun` could not locate xcresulttool. Install Xcode, or point xcode-select at it."
                  />
                </div>
              ) : loading && !overview ? (
                <div className="flex flex-col gap-1 p-1">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : runs.length === 0 ? (
                <div className="p-2">
                  <EmptyState
                    icon="Toolbox"
                    title="No Xcode activity yet"
                    description={
                      <>
                        Builds are picked up automatically — from Xcode, from{" "}
                        <code className="rounded bg-muted px-1 py-0.5 text-xs">
                          xcodebuild
                        </code>
                        , and from anything that wraps them. Start a build and
                        it appears here within seconds.
                      </>
                    }
                  />
                </div>
              ) : (
                <>
                  <ShimNudge overview={overview} />
                  <RunLog runs={runs} selectedId={effectiveId} onSelect={select} />
                </>
              )}
              </div>
            </div>
          ) : null}

          {showDetail ? (
            <RunDetailPanel
              runId={effectiveId}
              showBack={!wide}
              closable={!wide}
              onClose={() => select(null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The one thing this panel should say that it was computing and discarding.
 *
 * `shimActive` has always been in the `overview` payload and has never been
 * rendered — so the panel could show a column of runs reading "Ended" without
 * ever mentioning that a one-line install is the difference between that and a
 * real verdict. The only place it appeared was inside a single run's detail
 * pane: visible after you had already been let down, and only if you went
 * looking.
 *
 * It earns its place by being specific and by going away. It appears only when
 * runs in view actually lack verdicts, it names how many, and dismissing it is
 * remembered — a standing recommendation that cannot be silenced is an advert,
 * and this panel is a log.
 */
function ShimNudge({ overview }: { overview: Overview | null }) {
  const [dismissed, setDismissed] = useState(
    () => readLocal(SHIM_NUDGE_KEY) === "1",
  );
  if (!overview || dismissed) return null;
  if (overview.shimActive || overview.verdictlessRuns === 0) return null;

  const { shimInstalled, verdictlessRuns } = overview;
  const count = `${verdictlessRuns} run${verdictlessRuns === 1 ? "" : "s"}`;

  return (
    <div className="mb-1 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs">
      <Icon
        name="Info"
        className="mt-px size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-foreground">
          {count} here ended without a pass/fail. Xcode writes no build log for
          command-line builds, so the outcome only exists in a result bundle.
        </p>
        <p className="text-muted-foreground">
          {shimInstalled ? (
            <>
              The shim is installed but not on this server&rsquo;s PATH — add the
              line from{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                bb xcode shim status
              </code>{" "}
              to your shell profile and restart your shell.
            </>
          ) : (
            <>
              Run{" "}
              <code className="rounded bg-muted px-1 py-0.5">
                bb xcode shim install
              </code>{" "}
              once to capture one for every build.
            </>
          )}
        </p>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={() => {
          setDismissed(true);
          writeLocal(SHIM_NUDGE_KEY, "1");
        }}
        className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon name="X" className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

const SHIM_NUDGE_KEY = "bb-xcode.shim-nudge-dismissed";

/**
 * Client-side only, and deliberately so. A dismissal that failed because
 * storage was unavailable should hide the notice for this session rather than
 * throw inside a render.
 */
function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode, or storage disabled */
  }
}

/**
 * Selection is plain component state, so a tap opens the detail with no router
 * involvement — routing selection *through* panel navigation made every tap a
 * full navigation round-trip, which proved unreliable (rows flashed and
 * nothing opened). The URL is synced afterwards, best-effort and with
 * `replace`, purely so a deep link to a run keeps working and a reload
 * restores the selection.
 */
export function XcodePanel({ subPath = "" }: { subPath?: string }) {
  const navigate = useBbNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    subPath ? safeDecode(subPath) : null,
  );

  const select = useCallback(
    (id: string | null): void => {
      setSelectedId(id);
      try {
        // Raw id, not encodeURIComponent(id): the host encodes the subPath
        // segment itself, so pre-encoding double-encoded it and the echo came
        // back as a bogus "r%3A…" id (measured — it made every tap show
        // "Not found").
        navigate.toPluginPanel("xcode", { subPath: id ?? "", replace: true });
      } catch {
        // URL sync is cosmetic; selection must never depend on it.
      }
    },
    [navigate],
  );

  // Host-driven subPath changes (browser back, an external deep link while
  // mounted) still update the selection.
  useEffect(() => {
    const fromUrl = subPath ? safeDecode(subPath) : null;
    setSelectedId((current) => {
      if (fromUrl === current) return current;
      // An encoding-level echo of the current id is not a new selection.
      if (fromUrl !== null && current !== null && safeDecode(fromUrl) === current) {
        return current;
      }
      return fromUrl;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subPath]);

  return <XcodePanelView selectedId={selectedId} select={select} />;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
