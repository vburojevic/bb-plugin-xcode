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
import type { BuildLauncher } from "./launcher";
import { describeRun, verdictSentence, type PresentOptions } from "./present";
import type { Run } from "./model";
import { scopeFilter, type ThreadScope } from "./scopes";
import type { Store } from "./store";
import type { BuildPhase } from "./types";
import {
  resolveBuildArgv,
  verdictFromOutcome,
  waitForVerdict,
  type WrappedOutcome,
} from "./wrapped";

/** Findings and failed tests returned to a tool call. */
const DETAIL_LIMIT = 40;

/** Default and maximum wall-clock a blocking build may occupy. */
const DEFAULT_BUILD_TIMEOUT_S = 900;
const MAX_BUILD_TIMEOUT_S = 3_600;

/** Grace after the process exits for a verdict to land in the store. */
const VERDICT_GRACE_MS = 25_000;

/**
 * How long a stopped build may take to report its exit before the tool stops
 * waiting. A local build always reports within the runner's SIGKILL grace; a
 * build on another Mac reports only if that Mac is still reachable, and one
 * that dropped off the network must not hold the tool call forever.
 */
const STOPPED_REPORT_GRACE_MS = 30_000;

export const AGENT_INSTRUCTIONS =
  "When an Xcode build or test is needed, prefer the `xcode_build` tool — it runs xcodebuild, waits, and returns a real pass/fail verdict with the errors and failed tests. " +
  "If you start a build another way, `bb xcode run -- xcodebuild …` tracks it and `bb xcode wait <run-id>` blocks for its verdict; never write your own poll loop. " +
  "Use xcode_status instead of parsing build logs when checking whether a run passed. " +
  "Live builds render themselves in the prompt stack above the composer, so never announce that a build started and never paste build status into chat — the user is already looking at it.";

export interface ToolDeps {
  store: Store;
  collector: Collector;
  dataDir: string;
  /** Starts tracked builds on whichever Mac holds the thread's checkout. */
  launcher: BuildLauncher;
  /** Display name of an enrolled Mac, when known. */
  machineName(hostId: string): string | null;
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
    machineName: (hostId: string) => deps.machineName(hostId),
  };

  const status = {
    name: "xcode_status",
    description:
      "Report Xcode build/test activity: what is running now and how recent runs finished, scoped to this thread's checkout when possible. Use instead of grepping build logs.",
    instructions: AGENT_INSTRUCTIONS,
    presentation: {
      label: {
        pending: "Checking Xcode activity",
        completed: "Checked Xcode activity",
      },
    },
    parameters: z.object({
      limit: z.number().int().min(1).max(25).optional(),
    }),
    async execute(
      { limit }: { limit?: number },
      { threadId }: { threadId: string },
    ): Promise<string> {
      deps.refreshProjectNames();
      const scope = await deps.scopeFor(threadId);
      const inScope = scopeFilter<Run>(scope);

      const open = deps.store.listUnresolved().filter(inScope);
      // Scope in SQL, so a thread whose runs sit outside the machine-wide
      // recent window still sees its own history.
      const recent = scope
        ? deps.store.listRuns({ limit: limit ?? 5, scope })
        : [];
      const machine = scope?.hostId ? deps.machineName(scope.hostId) : null;
      const header = scope
        ? `Scope: this thread's checkout ${scope.path}${scope.branch ? ` @${scope.branch}` : ""}${machine ? ` on ${machine}` : ""}.`
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
        parts.push("No recorded runs for this checkout yet.");
      }
      return parts.join("\n\n");
    },
  };

  const lastFailure = {
    name: "xcode_last_failure",
    description:
      "Return the errors and failed tests from the most recent failed Xcode run, with file paths and line numbers.",
    presentation: {
      label: {
        pending: "Reading last Xcode failure",
        completed: "Read last Xcode failure",
      },
    },
    parameters: z.object({
      projectId: z.string().max(200).optional(),
    }),
    async execute(
      { projectId }: { projectId?: string },
      { threadId }: { threadId: string },
    ): Promise<string> {
      deps.refreshProjectNames();
      const scope = await deps.scopeFor(threadId);
      if (!scope) {
        return "This thread has no resolvable checkout, so no run can be attributed to it.";
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
        return "No failed Xcode runs recorded for this thread's checkout.";
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
    presentation: {
      label: {
        pending: "Running Xcode build",
        completed: "Xcode build finished",
      },
    },
    parameters: z.object({
      args: z
        .array(z.string().max(8192))
        .min(1)
        .max(512)
        .describe(
          'Arguments passed to xcodebuild, without the program name. Example: ["-scheme","App","-destination","platform=macOS","test"]',
        ),
      cwd: z
        .string()
        .max(4096)
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
      if (scope === null) {
        return "This thread has no resolvable checkout, so xcodebuild was not started.";
      }
      // `xcodebuild` is implied, and stripping a leading one the model
      // added anyway is kinder than erroring on it.
      let argv: string[];
      let workingDir: string;
      // The thread's environment decides the machine. A checkout on another
      // enrolled Mac is validated there, on the disk the build will use.
      const target = await deps.launcher.targetFor(scope);
      try {
        argv = resolveBuildArgv(args[0] === "xcodebuild" ? args : ["xcodebuild", ...args]);
        workingDir = await deps.launcher.prepare(target, {
          argv,
          root: scope.path,
          ...(cwd !== undefined ? { cwd } : {}),
        });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      const timeoutMs =
        (timeoutSeconds ?? DEFAULT_BUILD_TIMEOUT_S) * 1000;

      const killer = new AbortController();
      const timer = setTimeout(() => killer.abort(), timeoutMs);
      // A torn-down tool call must not leave an orphan build running for an
      // hour; this is the one caller allowed to end the child.
      const onAbort = (): void => killer.abort();
      signal.addEventListener("abort", onAbort, { once: true });

      try {
        const started = await deps.launcher.start(
          target,
          { argv, root: scope.path, workingDir, ...(cwd !== undefined ? { cwd } : {}) },
          scope,
          killer.signal,
        );
        if (typeof started === "string") {
          return target.kind === "local"
            ? "Failed to start xcodebuild. Check the arguments and the working directory."
            : started;
        }

        const outcome = await completedOrGiveUp(
          started.completed,
          killer.signal,
          started.bundlePath,
        );
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
            `result bundle${target.kind === "remote" ? ` (on ${target.machineName})` : ""}: ${started.bundlePath}`,
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

/**
 * The build's own report, or — once it has been told to stop and has not
 * answered within `STOPPED_REPORT_GRACE_MS` — an honest non-answer.
 */
function completedOrGiveUp(
  completed: Promise<WrappedOutcome>,
  stopped: AbortSignal,
  bundlePath: string,
): Promise<WrappedOutcome> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onStop: (() => void) | null = null;
  const giveUp = new Promise<WrappedOutcome>((resolve) => {
    onStop = (): void => {
      timer = setTimeout(
        () =>
          resolve({ exitCode: null, signal: null, bundlePath, errors: 0, warnings: 0, failed: true }),
        STOPPED_REPORT_GRACE_MS,
      );
    };
    if (stopped.aborted) onStop();
    else stopped.addEventListener("abort", onStop, { once: true });
  });
  return Promise.race([completed, giveUp]).finally(() => {
    if (timer) clearTimeout(timer);
    if (onStop) stopped.removeEventListener("abort", onStop);
  });
}

/** Everything a model needs about a settled run, and nothing it does not. */
function detailFor(deps: ToolDeps, run: Run): string {
  const lines = [
    describeRun(run, { projectName: deps.projectName, machineName: deps.machineName }),
  ];

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

  if (run.bundlePath) {
    const machine = run.hostId !== null ? (deps.machineName(run.hostId) ?? run.hostId) : null;
    lines.push("", `result bundle${machine ? ` (on ${machine})` : ""}: ${run.bundlePath}`);
  }
  return lines.join("\n");
}
