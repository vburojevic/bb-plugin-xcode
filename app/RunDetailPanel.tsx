/**
 * Detail for the selected run, beside the list (never over it).
 */

import { useEffect, useState } from "react";
import { useRpc } from "@bb/plugin-sdk/app";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import type { rpcContract } from "../src/contract";
import {
  type RunKind,
  type RunStatus,
  formatClock,
  formatDuration,
  formatLocation,
  kindLabel,
  runTitle,
  statusLabel,
  tildify,
} from "./format";
import { EmptyState, StatusGlyph, SweepBar } from "./primitives";
import { useNow } from "./RunLog";

interface DetailRun {
  id: string;
  status: RunStatus;
  kind: RunKind;
  scheme: string | null;
  container: string | null;
  configuration: string | null;
  destination: string | null;
  destinationLabel: string | null;
  projectName: string | null;
  branch: string | null;
  worktree: string | null;
  root: string | null;
  cwd: string | null;
  cmdline: string | null;
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  errorCount: number;
  warningCount: number;
  analyzerCount: number;
  testTotal: number | null;
  testFailed: number | null;
  testSkipped: number | null;
  bundlePath: string | null;
  detailed: boolean;
}

interface Finding {
  severity: "error" | "warning" | "analyzer";
  message: string;
  filePath: string | null;
  line: number | null;
  target: string | null;
}

interface TestResult {
  suite: string | null;
  name: string;
  /**
   * `recorded` is ours: a snapshot baseline written in record mode. The
   * contract has always been able to return it and this type could not name
   * it, so the pane rendered a written baseline as an anonymous grey row with
   * a failure message attached — exactly the reading the reclassification
   * exists to prevent.
   */
  status:
    | "passed"
    | "failed"
    | "skipped"
    | "expected-failure"
    | "recorded"
    | "unknown";
  durationMs: number | null;
  failureMessage: string | null;
  target: string | null;
}

export function RunDetailPanel({
  runId,
  onClose,
  showBack,
  closable = true,
}: {
  runId: string;
  onClose: () => void;
  showBack: boolean;
  /** False in the permanent two-pane layout, where the pane never closes. */
  closable?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [run, setRun] = useState<DetailRun | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [tests, setTests] = useState<TestResult[]>([]);
  const [loading, setLoading] = useState(true);

  const load = (id: string, quiet = false): void => {
    if (!quiet) setLoading(true);
    void rpc
      .call("runDetail", { id })
      .then((result) => {
        setRun(result.run as DetailRun | null);
        setFindings(result.findings as Finding[]);
        setTests(result.tests as TestResult[]);
      })
      .catch(() => {
        // The pane is keyed by run id, so a failed load renders the
        // "Not found" state below rather than another run's data — and a
        // rejection must not escape as an unhandled one.
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load(runId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  const active = run?.status === "running" || run?.status === "finishing";
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => load(runId, true), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, runId]);

  const now = useNow(active);

  if (loading && !run) {
    return (
      <Shell onClose={onClose} showBack={showBack} closable={closable} title="Loading…">
        <div className="flex flex-col gap-3 p-4">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </Shell>
    );
  }

  if (!run) {
    return (
      <Shell onClose={onClose} showBack={showBack} closable={closable} title="Not found">
        <div className="p-4">
          <EmptyState icon="CircleQuestion" title="This run is no longer available" />
        </div>
      </Shell>
    );
  }

  const failedTests = tests.filter((test) => test.status === "failed");
  const elapsed =
    run.status === "running"
      ? Math.max(0, now - run.startedAt)
      : run.durationMs;

  return (
    <Shell onClose={onClose} showBack={showBack} closable={closable} title={runTitle(run)}>
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex w-full flex-col gap-2.5 border-b border-border px-4 pb-3">
          <div className="flex w-full max-w-3xl flex-col gap-2.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="flex items-center gap-2">
              <StatusGlyph status={run.status} />
              <span
                className={cn(
                  "text-sm font-medium transition-colors duration-200",
                  run.status === "failed" && "text-destructive",
                  run.status === "running" && "text-primary",
                )}
              >
                {statusLabel(run.status)}
              </span>
            </span>
            <span className="text-sm tabular-nums text-muted-foreground">
              {run.status === "finishing" ? "finishing…" : formatDuration(elapsed)}
            </span>
          </div>

          {run.status === "running" ? (
            <SweepBar label={`${kindLabel(run.kind)} in progress`} />
          ) : null}

          {run.status === "ended" ? (
            <p className="text-xs text-muted-foreground">
              This run finished, but Xcode records no pass/fail for command-line
              builds without a result bundle. Run{" "}
              <code className="rounded bg-muted px-1 py-0.5">bb xcode shim install</code>{" "}
              once to capture verdicts for every build.
            </p>
          ) : null}

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            <Field label="Kind" value={kindLabel(run.kind)} />
            <Field label="Project" value={run.projectName ?? "—"} />
            <Field
              label="Destination"
              value={run.destinationLabel ?? run.destination ?? "—"}
            />
            <Field label="Started" value={formatClock(run.startedAt)} />
            <Field label="Branch" value={run.branch ?? "—"} />
            <Field label="Worktree" value={run.worktree ?? "—"} />
          </dl>
          </div>
        </header>

        <Tabs
          defaultValue={failedTests.length ? "tests" : "issues"}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="mx-4 mt-3 self-start">
            <TabsTrigger value="issues">
              Issues
              {findings.length ? (
                <Badge variant="secondary" className="ml-1.5">
                  {findings.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="tests">
              Tests
              {failedTests.length ? (
                <Badge variant="destructive" className="ml-1.5">
                  {failedTests.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="command">Command</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="max-w-3xl px-4 pb-4 pt-3">
              <TabsContent value="issues" className="mt-0">
                <IssuesTab findings={findings} run={run} />
              </TabsContent>
              <TabsContent value="tests" className="mt-0">
                <TestsTab tests={tests} run={run} />
              </TabsContent>
              <TabsContent value="command" className="mt-0">
                <CommandTab run={run} />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </div>
    </Shell>
  );
}

function Shell({
  title,
  showBack,
  closable = true,
  onClose,
  children,
}: {
  title: string;
  showBack: boolean;
  closable?: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label="Run detail"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className="flex items-center gap-2 px-4 py-3">
        {showBack ? (
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Back to list">
            <Icon name="ChevronLeft" data-icon="inline-start" />
            Back
          </Button>
        ) : null}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{title}</h2>
        {showBack || !closable ? null : (
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close detail">
            <Icon name="X" aria-hidden />
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-foreground">{value}</dd>
    </div>
  );
}

function IssuesTab({ findings, run }: { findings: Finding[]; run: DetailRun }) {
  if (findings.length === 0) {
    const hasCounts = run.errorCount > 0 || run.warningCount > 0;
    if (!hasCounts) {
      return (
        <p className="text-sm text-muted-foreground">
          {run.status === "running"
            ? "No issues reported yet."
            : "No errors or warnings."}
        </p>
      );
    }
    return (
      <p className="text-sm text-muted-foreground">
        Xcode counted {run.errorCount} error(s) and {run.warningCount} warning(s),
        but the messages live in a result bundle this run did not produce.
        Builds made through{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">bb xcode run</code>{" "}
        or with the shim installed capture them automatically.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2" role="list">
      {findings.map((finding, index) => {
        const location = formatLocation(finding.filePath, finding.line);
        return (
          <li
            key={`${finding.filePath ?? "?"}:${finding.line ?? 0}:${index}`}
            className="flex flex-col gap-1 rounded-md border border-border p-2.5"
          >
            <p className="text-sm text-foreground">{finding.message}</p>
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <span
                className={cn(finding.severity === "error" && "text-destructive")}
              >
                {finding.severity}
              </span>
              {location ? <span className="truncate">{location}</span> : null}
              {finding.target ? (
                <span className="truncate">{finding.target}</span>
              ) : null}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function TestsTab({ tests, run }: { tests: TestResult[]; run: DetailRun }) {
  if (tests.length === 0) {
    if (run.kind !== "test") {
      return (
        <p className="text-sm text-muted-foreground">This run did not run tests.</p>
      );
    }
    return (
      <p className="text-sm text-muted-foreground">
        Per-test results exist only in a result bundle. Run tests through{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs">bb xcode run</code>{" "}
        or install the shim to capture them.
      </p>
    );
  }

  const recorded = tests.filter((test) => test.status === "recorded").length;

  return (
    <>
      {recorded > 0 ? (
        // Said once, above the list, rather than left for the reader to infer
        // from a dozen rows carrying a message that begins "Record mode is on".
        <p className="mb-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
          <span className="text-foreground">
            {recorded} snapshot baseline{recorded === 1 ? " was" : "s were"}{" "}
            recorded, not failed.
          </span>{" "}
          swift-snapshot-testing reports a written baseline by failing the test,
          because record mode has nothing to assert against yet. These are
          excluded from the failure count.
        </p>
      ) : null}
      <ul className="flex flex-col gap-1" role="list">
        {tests.map((test, index) => (
          <li
            key={`${test.suite ?? ""}/${test.name}/${index}`}
            className={cn(
              "flex flex-col gap-1 rounded-md px-2 py-1.5",
              test.status === "failed" && "border border-border",
            )}
          >
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  test.status === "failed"
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {test.suite ? (
                  <span className="text-muted-foreground">{test.suite}/</span>
                ) : null}
                {test.name}
              </span>
              {test.status === "recorded" ? (
                <Badge variant="secondary" className="shrink-0">
                  recorded
                </Badge>
              ) : null}
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatDuration(test.durationMs)}
              </span>
            </div>
            {test.failureMessage ? (
              <p className="whitespace-pre-wrap break-words rounded bg-muted px-2 py-1.5 text-xs text-foreground">
                {test.failureMessage}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

function CommandTab({ run }: { run: DetailRun }) {
  const rows: Array<[string, string]> = [
    ["Configuration", run.configuration ?? "—"],
    ["Container", tildify(run.container)],
    ["DerivedData", tildify(run.root)],
    ["Working dir", tildify(run.cwd)],
    ["Result bundle", tildify(run.bundlePath)],
  ];
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words font-mono">{value}</dd>
          </div>
        ))}
      </dl>
      {run.cmdline ? (
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2.5 text-xs">
          {run.cmdline}
        </pre>
      ) : null}
    </div>
  );
}
