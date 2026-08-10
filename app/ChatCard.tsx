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
 * reload. Attributes are untrusted model output — `run` is only ever passed
 * to the rpc as an opaque id.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@bb/plugin-sdk/app";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

import { XCODE_CHANNEL } from "../src/channel";
import type { rpcContract } from "../src/contract";
import {
  formatDuration,
  formatLocation,
  formatRelative,
  kindLabel,
  runTitle,
  statusLabel,
  statusTone,
} from "./format";
import { StatusGlyph, SweepBar } from "./primitives";

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

export function XcodeChatCard({
  attributes,
  message,
}: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const runId = attributes.run?.trim() || null;
  const machineWide = attributes.scope === "machine";
  const threadId = machineWide ? null : message.threadId;

  const [data, setData] = useState<ChatStatus | null>(null);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
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
  }, [rpc, threadId, runId]);

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

  if (error) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon name="Toolbox" className="size-4" aria-hidden />
          Xcode status unavailable.
        </div>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon name="Toolbox" className="size-4 animate-pulse" aria-hidden />
          Loading Xcode status…
        </div>
      </Card>
    );
  }

  const { run, active, scope, findings, failedTests } = data;
  if (!run) {
    return (
      <Card>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon name="Toolbox" className="size-4" aria-hidden />
          {scope
            ? `No Xcode activity for ${scope.worktree ?? "this checkout"}${scope.branch ? ` @${scope.branch}` : ""} yet.`
            : "No Xcode activity recorded yet."}
        </div>
      </Card>
    );
  }

  const elapsed = LIVE.has(run.status)
    ? Date.now() - run.startedAt
    : run.durationMs;
  const counts: string[] = [];
  if (run.errorCount > 0) counts.push(`${run.errorCount} error${run.errorCount === 1 ? "" : "s"}`);
  if (run.warningCount > 0)
    counts.push(`${run.warningCount} warning${run.warningCount === 1 ? "" : "s"}`);
  if (run.testTotal !== null) {
    counts.push(
      (run.testFailed ?? 0) > 0
        ? `${run.testFailed}/${run.testTotal} tests failed`
        : `${run.testTotal} tests passed`,
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-2.5">
        <StatusGlyph status={run.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {runTitle(run)}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {kindLabel(run.kind)}
            </span>
            {run.branch || run.worktree ? (
              <span className="truncate text-xs text-muted-foreground">
                {run.worktree ?? ""}
                {run.branch ? ` @${run.branch}` : ""}
              </span>
            ) : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
            <span className={cn("font-medium", statusTone(run.status))}>
              {statusLabel(run.status)}
            </span>
            <span>{formatDuration(elapsed)}</span>
            {run.destinationLabel ? <span>{run.destinationLabel}</span> : null}
            {counts.length ? <span>{counts.join(" · ")}</span> : null}
            {!LIVE.has(run.status) && run.endedAt ? (
              <span>{formatRelative(run.endedAt)}</span>
            ) : null}
            {LIVE.has(run.status) && run.workerCount ? (
              <span>{run.workerCount} compiler processes</span>
            ) : null}
          </div>
        </div>
      </div>

      {LIVE.has(run.status) ? (
        <SweepBar
          label={`${statusLabel(run.status)} ${runTitle(run)}`}
          className="mt-2.5"
        />
      ) : null}

      {findings.length > 0 ? (
        <ul className="mt-2.5 space-y-1 border-t border-border pt-2.5">
          {findings.map((finding, index) => (
            <li key={index} className="flex gap-2 text-xs">
              <span className="shrink-0 font-medium text-destructive">
                {formatLocation(finding.filePath, finding.line) ?? "error"}
              </span>
              <span className="min-w-0 truncate text-muted-foreground">
                {finding.message}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {failedTests.length > 0 ? (
        <ul
          className={cn(
            "mt-2.5 space-y-1 pt-2.5",
            findings.length === 0 && "border-t border-border",
          )}
        >
          {failedTests.map((test, index) => (
            <li key={index} className="flex gap-2 text-xs">
              <span className="shrink-0 font-medium text-destructive">
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
      ) : null}

      {active.length > 0 ? (
        <div className="mt-2.5 flex flex-col gap-1 border-t border-border pt-2.5">
          {active.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <StatusGlyph status={entry.status} className="size-3.5" />
              <span className="truncate">
                {runTitle(entry)} · {kindLabel(entry.kind)} ·{" "}
                {formatDuration(Date.now() - entry.startedAt)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-1.5 max-w-xl rounded-lg border border-border bg-card px-3.5 py-3">
      {children}
    </div>
  );
}
