/**
 * The `::xcode{…}` chat directive: a live build/test status card inside a
 * bb conversation.
 *
 * Two forms, resolved server-side by the `chatStatus` rpc:
 *  - `::xcode{run="<id>"}` pins one run — live while it runs, settling into
 *    its final verdict (with errors / failed tests) once resolved;
 *  - bare `::xcode{}` shows the enclosing thread's current Xcode activity,
 *    scoped to the thread's checkout, machine-wide when no scope resolves.
 *
 * The card refetches on every tracker publish (XCODE_CHANNEL), so it updates
 * in place while xcodebuild runs, and renders correctly from the store on
 * reload. Status colors are Xcode's own vocabulary blended with the live
 * theme tokens (`.bbx-status-*` in app.css). Attributes are untrusted model
 * output — `run` is only ever passed to the rpc as an opaque id.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@bb/plugin-sdk/app";

import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import { XCODE_CHANNEL } from "../src/channel";
import type { rpcContract } from "../src/contract";
import {
  formatDuration,
  formatLocation,
  formatRelative,
  kindLabel,
  runTitle,
  statusHint,
  statusIcon,
  statusLabel,
} from "./format";

// Shape of the `chatStatus` rpc output (the contract infers the same thing;
// named locally so the component reads without generic gymnastics).
type ChatStatus = {
  run: RunDto | null;
  active: RunDto[];
  recent: RunDto[];
  scope: {
    threadId: string;
    path: string;
    branch: string | null;
    worktree: string | null;
  } | null;
  findings: Array<{
    severity: "error" | "warning" | "analyzer";
    message: string;
    filePath: string | null;
    line: number | null;
    target: string | null;
  }>;
  failedTests: Array<{
    suite: string | null;
    name: string;
    status: string;
    durationMs: number | null;
    failureMessage: string | null;
    target: string | null;
  }>;
};

type RunDto = {
  id: string;
  status:
    | "running"
    | "finishing"
    | "passed"
    | "warnings"
    | "failed"
    | "cancelled"
    | "ended";
  kind:
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
  scheme: string | null;
  container: string | null;
  destination: string | null;
  destinationLabel: string | null;
  root: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  errorCount: number;
  warningCount: number;
  testTotal: number | null;
  testFailed: number | null;
  branch: string | null;
  worktree: string | null;
  workerCount: number | null;
  projectName: string | null;
};

const LIVE = new Set(["running", "finishing"]);

const DEMO_STATUSES = new Set<RunDto["status"]>([
  "running",
  "finishing",
  "passed",
  "warnings",
  "failed",
  "cancelled",
  "ended",
]);

/**
 * `::xcode{demo="failed"}` renders a synthetic card for that state — no rpc,
 * no real process. Exists so card states can be reviewed (and documented) in
 * chat without staging seven real builds.
 */
function makeDemo(status: RunDto["status"], now: number): ChatStatus {
  const isLive = LIVE.has(status);
  const failedKind = status === "failed";
  const run: RunDto = {
    id: `demo:${status}`,
    status,
    kind: failedKind ? "test" : "build",
    scheme: "Packerly",
    container: null,
    destination: null,
    destinationLabel: "iPhone 16 · iOS 26.0",
    root: null,
    startedAt: isLive ? now - 83_000 : now - 420_000,
    endedAt: isLive ? null : now - 120_000,
    durationMs: isLive ? null : status === "cancelled" ? 62_000 : 292_000,
    errorCount: failedKind ? 2 : 0,
    warningCount: status === "warnings" ? 59 : failedKind ? 3 : 0,
    testTotal: failedKind ? 312 : status === "passed" ? 312 : null,
    testFailed: failedKind ? 2 : status === "passed" ? 0 : null,
    branch: "main",
    worktree: "Packerly",
    workerCount: status === "running" ? 12 : null,
    projectName: "Packerly",
  };
  return {
    run,
    active: [],
    recent: [],
    scope: null,
    findings: failedKind
      ? [
          {
            severity: "error",
            message: "Cannot find 'PackingListStore' in scope",
            filePath: "App/Sources/PackingListView.swift",
            line: 42,
            target: "Packerly",
          },
          {
            severity: "error",
            message:
              "Value of optional type 'Trip?' must be unwrapped to refer to member 'items'",
            filePath: "PackerlyKit/Sources/TripPlanner.swift",
            line: 118,
            target: "PackerlyKit",
          },
        ]
      : [],
    failedTests: failedKind
      ? [
          {
            suite: "TripPlannerTests",
            name: "testPackingListSyncsAcrossDevices",
            status: "failed",
            durationMs: 1_840,
            failureMessage: "XCTAssertEqual failed: (3) is not equal to (4)",
            target: "PackerlyTests",
          },
          {
            suite: "TripPlannerTests",
            name: "testWeatherAwareSuggestions",
            status: "failed",
            durationMs: 903,
            failureMessage: "Async expectation timed out after 5.0s",
            target: "PackerlyTests",
          },
        ]
      : [],
  };
}

/** Xcode status vocabulary → theme-blended color class (app.css). */
function statusClass(status: RunDto["status"]): string {
  switch (status) {
    case "running":
      return "bbx-status-run";
    case "finishing":
      return "bbx-status-run";
    // Warnings are a SUCCESS state: green verdict, yellow count chip. The
    // caution lives on the chip, never on the verdict itself.
    case "passed":
    case "warnings":
      return "bbx-status-pass";
    case "failed":
      return "bbx-status-fail";
    default:
      return "bbx-status-muted";
  }
}

export function XcodeChatCard({
  attributes,
  message,
}: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const runId = attributes.run?.trim() || null;
  const machineWide = attributes.scope === "machine";
  const threadId = machineWide ? null : message.threadId;
  const demoRaw = attributes.demo?.trim() || null;
  const demo =
    demoRaw && DEMO_STATUSES.has(demoRaw as RunDto["status"])
      ? (demoRaw as RunDto["status"])
      : null;

  const [data, setData] = useState<ChatStatus | null>(null);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    if (demo) {
      setData((current) => current ?? makeDemo(demo, Date.now()));
      return;
    }
    // One fetch at a time; a publish landing mid-fetch queues exactly one more.
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const result = await rpc.call("chatStatus", { threadId, runId });
      setData(result as ChatStatus);
      setError(false);
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      if (pending.current) {
        pending.current = false;
        void load();
      }
    }
  }, [rpc, threadId, runId, demo]);

  useEffect(() => {
    void load();
  }, [load]);
  useRealtime(XCODE_CHANNEL, () => void load());

  // Tick the elapsed time each second while the shown run is live.
  const live = data?.run ? LIVE.has(data.run.status) : false;
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);

  if (error || !data) {
    return (
      <Shell className="bbx-status-muted">
        <div className="flex items-center gap-2 px-3.5 py-3 text-sm text-muted-foreground">
          <Icon
            name="Toolbox"
            className={cn("size-4", !error && "animate-pulse")}
            aria-hidden
          />
          {error ? "Xcode status unavailable." : "Loading Xcode status…"}
        </div>
      </Shell>
    );
  }

  const { run, active, scope, findings, failedTests } = data;
  if (!run) {
    return (
      <Shell className="bbx-status-muted">
        <div className="flex items-center gap-2 px-3.5 py-3 text-sm text-muted-foreground">
          <Icon name="Toolbox" className="size-4" aria-hidden />
          {scope
            ? `No Xcode activity for ${scope.worktree ?? "this checkout"}${scope.branch ? ` @${scope.branch}` : ""} yet.`
            : "No Xcode activity recorded yet."}
        </div>
      </Shell>
    );
  }

  const isLive = LIVE.has(run.status);
  const elapsed = isLive ? Date.now() - run.startedAt : run.durationMs;
  const testsBadge =
    run.testTotal !== null
      ? (run.testFailed ?? 0) > 0
        ? {
            label: `${run.testFailed} of ${run.testTotal} tests failed`,
            cls: "bbx-status-fail",
          }
        : { label: `${run.testTotal} tests passed`, cls: "bbx-status-pass" }
      : null;
  const problems = findings.length > 0 || failedTests.length > 0;

  return (
    <Shell className={statusClass(run.status)}>
      {/* Header */}
      <div className="flex items-start gap-2.5 px-3.5 pt-3 pb-2.5">
        <StatusMark status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-sm font-semibold leading-tight text-foreground">
              {runTitle(run)}
            </span>
            <Badge
              variant="outline"
              className="bbx-chip h-5 rounded-full border px-2 py-0 text-[11px] font-medium capitalize"
            >
              {kindLabel(run.kind)}
            </Badge>
            {run.destinationLabel ? (
              <Badge
                variant="outline"
                className="h-5 rounded-full border-border px-2 py-0 text-[11px] font-normal text-muted-foreground"
              >
                {run.destinationLabel}
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
            <span className="bbx-text font-medium">
              {statusLabel(run.status)}
            </span>
            {run.worktree || run.branch ? (
              <span className="inline-flex max-w-56 items-baseline gap-1 truncate">
                {run.worktree ? <span>{run.worktree}</span> : null}
                {run.branch ? (
                  <span className="inline-flex items-baseline gap-0.5">
                    <Icon
                      name="GitBranch"
                      className="size-3 self-center opacity-70"
                      aria-hidden
                    />
                    {run.branch}
                  </span>
                ) : null}
              </span>
            ) : run.projectName ? (
              <span>{run.projectName}</span>
            ) : null}
            {isLive && run.workerCount ? (
              <span>{run.workerCount} compilers</span>
            ) : null}
            {!isLive && run.endedAt ? (
              <span>{formatRelative(run.endedAt)}</span>
            ) : null}
          </div>
        </div>
        <span className="flex shrink-0 flex-col items-end gap-0.5 pt-0.5">
          <span
            className={cn(
              "text-sm font-medium tabular-nums",
              isLive ? "bbx-text" : "text-muted-foreground",
            )}
          >
            {formatDuration(elapsed)}
          </span>
          {demo ? (
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              demo
            </span>
          ) : null}
        </span>
      </div>

      {/* States whose one-word label under-explains get their sentence. */}
      {statusHint(run.status) ? (
        <div className="flex items-start gap-1.5 px-3.5 pb-3 text-xs text-muted-foreground">
          <Icon name="Info" className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{statusHint(run.status)!.replaceAll("`", "")}</span>
        </div>
      ) : null}

      {/* Live progress: comet sweep while building, breath while finishing. */}
      {isLive ? (
        <div className="px-3.5 pb-3">
          <Progress
            indeterminate
            aria-label={`${statusLabel(run.status)} ${runTitle(run)}`}
            className="bbx-progress-track h-1"
            indicatorClassName={
              run.status === "running"
                ? "bbx-progress-comet"
                : "bbx-progress-breath w-full"
            }
          />
        </div>
      ) : null}

      {/* Counts */}
      {run.errorCount > 0 || run.warningCount > 0 || testsBadge ? (
        <>
          <Separator />
          <div className="flex flex-wrap items-center gap-1.5 px-3.5 py-2.5">
            {run.errorCount > 0 ? (
              <CountChip
                cls="bbx-status-fail"
                icon="CircleX"
                label={`${run.errorCount} error${run.errorCount === 1 ? "" : "s"}`}
              />
            ) : null}
            {run.warningCount > 0 ? (
              <CountChip
                cls="bbx-status-warn"
                icon="AlertTriangle"
                label={`${run.warningCount} warning${run.warningCount === 1 ? "" : "s"}`}
              />
            ) : null}
            {testsBadge ? (
              <CountChip
                cls={testsBadge.cls}
                icon={
                  (run.testFailed ?? 0) > 0 ? "CircleX" : "CircleCheck"
                }
                label={testsBadge.label}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {/* Failure detail */}
      {problems ? (
        <>
          <Separator />
          <ul className="space-y-1.5 px-3.5 py-2.5">
            {findings.map((finding, index) => (
              <li
                key={`f${index}`}
                className="bbx-status-fail flex items-baseline gap-2 text-xs"
              >
                <span className="bbx-text shrink-0 font-mono text-[11px] font-medium">
                  {formatLocation(finding.filePath, finding.line) ?? "error"}
                </span>
                <span className="min-w-0 truncate text-muted-foreground">
                  {finding.message}
                </span>
              </li>
            ))}
            {failedTests.map((test, index) => (
              <li
                key={`t${index}`}
                className="bbx-status-fail flex items-baseline gap-2 text-xs"
              >
                <span className="bbx-text shrink-0 font-mono text-[11px] font-medium">
                  {test.suite ? `${test.suite}/` : ""}
                  {test.name}
                </span>
                {test.failureMessage ? (
                  <span className="min-w-0 truncate text-muted-foreground">
                    {test.failureMessage}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/* Other active runs in the same scope */}
      {active.length > 0 ? (
        <>
          <Separator />
          <div className="flex flex-col gap-1 px-3.5 py-2.5">
            {active.map((entry) => (
              <div
                key={entry.id}
                className={cn(
                  "flex items-center gap-2 text-xs text-muted-foreground",
                  statusClass(entry.status),
                )}
              >
                <StatusMark status={entry.status} small />
                <span className="truncate">
                  {runTitle(entry)} · {kindLabel(entry.kind)}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">
                  {formatDuration(Date.now() - entry.startedAt)}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Shell>
  );
}

/**
 * Card frame: theme card surface whose 1px border carries a quiet status
 * tint. The border's eased color transition IS the card's motion moment —
 * a verdict landing reads as the frame settling from activity to outcome.
 */
function Shell({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "bbx-frame my-1.5 max-w-xl overflow-hidden rounded-lg border bg-card shadow-xs",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The status mark: a pulsing dot while live (Xcode-blue blended with the
 * theme accent), a static verdict icon once resolved. Colors flow from the
 * enclosing `.bbx-status-*` scope.
 */
function StatusMark({
  status,
  small,
}: {
  status: RunDto["status"];
  small?: boolean;
}) {
  if (LIVE.has(status)) {
    return (
      <span
        className={cn(
          "bbx-dot relative flex shrink-0 items-center justify-center",
          small ? "size-3.5" : "mt-0.5 size-4",
        )}
        aria-hidden
      >
        <span
          className={cn(
            "bb-xcode-ping absolute rounded-full opacity-60",
            small ? "size-2" : "size-2.5",
          )}
        />
        <span
          className={cn(
            "relative rounded-full",
            small ? "size-2" : "size-2.5",
            status === "finishing" && "opacity-60",
          )}
        />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "bbx-text flex shrink-0 items-center justify-center",
        small ? "size-3.5" : "mt-0.5 size-4",
      )}
      aria-hidden
    >
      <Icon
        name={statusIcon(status)}
        className={cn(!small && "bbx-verdict-in", small ? "size-3.5" : "size-4")}
      />
    </span>
  );
}

function CountChip({
  cls,
  icon,
  label,
}: {
  cls: string;
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        cls,
        "bbx-chip inline-flex h-5 items-center gap-1 rounded-full border px-2 py-0 text-[11px] font-medium",
      )}
    >
      <Icon name={icon} className="size-3" aria-hidden />
      {label}
    </Badge>
  );
}
