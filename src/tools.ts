/**
 * The agent-facing tools.
 *
 * The plugin's instructions tell a model to prefer a tracked build over
 * grepping build output. That advice is only as good as the tools behind it,
 * which is why `xcode_build` exists: telling an agent to start a detached build
 * and then check on it is telling it to write a poll loop, and `engine.ts` then
 * has to recognise those loops and refuse to believe their exit codes.
 */

import { z } from "zod";

import type { Collector } from "./collector";
import { describeRun, verdictSentence, type PresentOptions } from "./present";
import type { Run } from "./model";
import { scopeFilter, type ThreadScope } from "./scopes";
import type { Store } from "./store";
import type { BuildPhase } from "./types";
import {
  resolveBuildArgv,
  startWrappedBuild,
  verdictFromOutcome,
  waitForVerdict,
  type WrappedDeps,
} from "./wrapped";

/** Findings and failed tests returned to a tool call. */
const DETAIL_LIMIT = 40;

/** Default and maximum wall-clock a blocking build may occupy. */
const DEFAULT_BUILD_TIMEOUT_S = 900;
const MAX_BUILD_TIMEOUT_S = 3_600;

/** Grace after the process exits for a verdict to land in the store. */
const VERDICT_GRACE_MS = 25_000;

export const AGENT_INSTRUCTIONS =
  "When an Xcode build or test is needed, prefer the `xcode_build` tool — it runs xcodebuild, waits, and returns a real pass/fail verdict with the errors and failed tests. " +
  "If you start a build another way, `bb xcode run -- xcodebuild …` tracks it and `bb xcode wait <run-id>` blocks for its verdict; never write your own poll loop. " +
  "Use xcode_status instead of parsing build logs when checking whether a run passed. " +
  "Live builds render themselves in the prompt stack above the composer, so never announce that a build started and never paste build status into chat — the user is already looking at it.";

export interface ToolDeps {
  store: Store;
  collector: Collector;
  dataDir: string;
  wrapped: WrappedDeps;
  refreshProjectNames(): void;
  projectName(id: string): string | null;
  /** What a live run is doing right now; null for anything settled. */
  phaseFor(run: Run): BuildPhase | null;
  /** Cached scope, or one bounded resolve. Never blocks on a slow SDK call. */
  scopeFor(threadId: string): Promise<ThreadScope | null>;
  showRun(id: string): { stdout?: string; stderr?: string };
}

export function createTools(deps: ToolDeps) {
  const present: PresentOptions = {
    projectName: (id: string) => deps.projectName(id),
    phaseFor: (run: Run) => deps.phaseFor(run),
  };

  const status = {
    name: "xcode_status",
    description:
      "Report Xcode build/test activity: what is running now and how recent runs finished, scoped to this thread's checkout when possible. Use instead of grepping build logs.",
    instructions: AGENT_INSTRUCTIONS,
    experimental_statusLabels: {
      pending: "Checking Xcode activity",
      completed: "Checked Xcode activity",
    },
    parameters: z.object({
      limit: z.number().int().min(1).max(25).optional(),
      machineWide: z
        .boolean()
        .optional()
        .describe("Ignore this thread's checkout scope and report everything."),
    }),
    async execute(
      { limit, machineWide }: { limit?: number; machineWide?: boolean },
      { threadId }: { threadId: string },
    ): Promise<string> {
      deps.refreshProjectNames();
      const scope = machineWide ? null : await deps.scopeFor(threadId);
      // `machineWide` is the caller's explicit request; an unresolvable thread
      // scope is not a licence to answer for the whole machine.
      const inScope = scopeFilter<Run>(scope, machineWide);

      const open = deps.store.listUnresolved().filter(inScope);
      // Scope in SQL, so a thread whose runs sit outside the machine-wide
      // recent window still sees its own history.
      const recent = machineWide
        ? deps.store.listRuns({ limit: limit ?? 5 })
        : scope
          ? deps.store.listRuns({ limit: limit ?? 5, scope })
          : [];
      const header = scope
        ? `Scope: this thread's checkout ${scope.path}${scope.branch ? ` @${scope.branch}` : ""}.`
        : machineWide
          ? "Scope: whole machine (explicitly requested)."
          : "Scope: this thread has no resolvable checkout yet, so nothing is attributed to it.";
      const parts: string[] = [
        header,
        open.length
          ? `Active (${open.length}):\n${open.map((run) => describeRun(run, present)).join("\n")}`
          : "Nothing is building right now.",
      ];
      if (recent.length) {
        parts.push(
          `Recent:\n${recent.map((run) => describeRun(run, present)).join("\n")}`,
        );
      } else {
        parts.push(
          "No recorded runs for this checkout yet. Pass machineWide: true to see all Xcode activity.",
        );
      }
      return parts.join("\n\n");
    },
  };

  const lastFailure = {
    name: "xcode_last_failure",
    description:
      "Return the errors and failed tests from the most recent failed Xcode run, with file paths and line numbers.",
    experimental_statusLabels: {
      pending: "Reading last Xcode failure",
      completed: "Read last Xcode failure",
    },
    parameters: z.object({
      projectId: z.string().optional(),
      machineWide: z
        .boolean()
        .optional()
        .describe("Ignore this thread's checkout scope and search all runs."),
    }),
    async execute(
      { projectId, machineWide }: { projectId?: string; machineWide?: boolean },
      { threadId }: { threadId: string },
    ): Promise<string> {
      deps.refreshProjectNames();
      const scope = machineWide ? null : await deps.scopeFor(threadId);
      if (!scope && !machineWide) {
        return "This thread has no resolvable checkout, so no run can be attributed to it. Pass machineWide: true to search all runs.";
      }
      // Scoped in SQL. Filtering after a LIMIT 25 meant a thread whose failure
      // sat outside the newest 25 problem runs machine-wide was told, with
      // confidence, that it had none.
      const failed = deps.store.listRuns({
        projectId: projectId ?? null,
        onlyProblems: true,
        limit: 1,
        ...(scope ? { scope } : {}),
      })[0];
      if (!failed) {
        return scope
          ? "No failed Xcode runs recorded for this thread's checkout. Pass machineWide: true to search all runs."
          : "No failed Xcode runs recorded.";
      }
      const detail = deps.showRun(failed.id);
      return detail.stdout ?? detail.stderr ?? "No detail available.";
    },
  };

  const build = {
    name: "xcode_build",
    description:
      "Run xcodebuild and WAIT for it, returning a real pass/fail verdict with errors and failed tests. Prefer this over running xcodebuild through a shell: it captures a result bundle, so the outcome is read from Xcode's own artifact rather than inferred from log text. Do not poll xcode_status after calling this — it has already waited.",
    instructions: AGENT_INSTRUCTIONS,
    experimental_statusLabels: {
      pending: "Running Xcode build",
      completed: "Xcode build finished",
    },
    parameters: z.object({
      args: z
        .array(z.string())
        .min(1)
        .describe(
          'Arguments passed to xcodebuild, without the program name. Example: ["-scheme","App","-destination","platform=macOS","test"]',
        ),
      cwd: z
        .string()
        .optional()
        .describe("Directory to run in. Defaults to this thread's checkout."),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(MAX_BUILD_TIMEOUT_S)
        .optional(),
    }),
    async execute(
      {
        args,
        cwd,
        timeoutSeconds,
      }: { args: string[]; cwd?: string; timeoutSeconds?: number },
      { threadId, signal }: { threadId: string; signal: AbortSignal },
    ): Promise<string> {
      deps.refreshProjectNames();
      const scope = await deps.scopeFor(threadId);
      const workingDir = cwd ?? scope?.path;
      const timeoutMs =
        (timeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_S) * 1000;

      const killer = new AbortController();
      const timer = setTimeout(() => killer.abort(), timeoutMs);
      // A torn-down tool call must not leave an orphan build running for an
      // hour; this is the one caller allowed to end the child.
      const onAbort = (): void => killer.abort();
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const started = await startWrappedBuild(deps.wrapped, {
          // `xcodebuild` is implied, and stripping a leading one the model
          // added anyway is kinder than erroring on it.
          argv: resolveBuildArgv(
            args[0] === "xcodebuild" ? args : ["xcodebuild", ...args],
          ),
          ...(workingDir ? { cwd: workingDir } : {}),
          killSignal: killer.signal,
        });
        if (!started) {
          return "Failed to start xcodebuild. Check the arguments and the working directory.";
        }

        const outcome = await started.completed;
        const settled = await waitForVerdict(
          deps.store,
          { bundlePath: started.bundlePath },
          { timeoutMs: VERDICT_GRACE_MS },
        );

        const timedOut = killer.signal.aborted && !signal.aborted;
        const header = timedOut
          ? `TIMED OUT after ${Math.round(timeoutMs / 1000)}s — the build was stopped.`
          : verdictSentence(
              settled?.status ?? verdictFromOutcome(outcome),
              {
                errorCount: settled?.errorCount ?? outcome.errors,
                testFailed: settled?.testFailed ?? null,
                testTotal: settled?.testTotal ?? null,
              },
            );

        // A build shorter than the probe interval can finish before `ps` ever
        // sees it, so there may be no run row at all. The wrapper still knows
        // how the process died, and saying that is better than saying nothing.
        if (!settled) {
          return [
            header,
            `xcodebuild exited ${outcome.exitCode ?? `on ${outcome.signal ?? "an unknown signal"}`}.`,
            `${outcome.errors} error(s), ${outcome.warnings} warning(s) seen on the live stream.`,
            `result bundle: ${started.bundlePath}`,
          ].join("\n");
        }

        return [header, "", detailFor(deps, settled)].join("\n");
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    },
  };

  return { status, lastFailure, build };
}

/** Everything a model needs about a settled run, and nothing it does not. */
function detailFor(deps: ToolDeps, run: Run): string {
  const lines = [describeRun(run, { projectName: deps.projectName })];

  const findings = deps.store
    .listFindings(run.id)
    .filter((finding) => finding.severity === "error")
    .slice(0, DETAIL_LIMIT);
  if (findings.length) {
    lines.push("", "errors:");
    for (const finding of findings) {
      const where = finding.filePath
        ? `${finding.filePath}${finding.line ? `:${finding.line}` : ""} `
        : "";
      lines.push(`  ${where}${finding.message}`);
    }
  }

  const failures = deps.store
    .listTests(run.id)
    .filter((test) => test.status === "failed")
    .slice(0, DETAIL_LIMIT);
  if (failures.length) {
    lines.push("", "failed tests:");
    for (const test of failures) {
      lines.push(
        `  ${test.suite ? `${test.suite}/` : ""}${test.name}${test.failureMessage ? ` — ${test.failureMessage}` : ""}`,
      );
    }
  }

  const recorded = deps.store.countTestsByStatus(run.id, "recorded");
  if (recorded > 0) {
    lines.push(
      "",
      `${recorded} snapshot baseline(s) were RECORDED, not failed: swift-snapshot-testing`,
      "signals a written baseline by failing the test. They are already excluded",
      "from the failure count above — do not report them as broken tests.",
    );
  }

  if (run.bundlePath) lines.push("", `result bundle: ${run.bundlePath}`);
  return lines.join("\n");
}
