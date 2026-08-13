/**
 * `bb xcode …`.
 *
 * The CLI is the agent-facing surface as much as the human one, so its output
 * is the same text `xcode_status` returns — see `present.ts`. Everything here
 * is thin: the work belongs to the store, the collector and `wrapped.ts`.
 */

import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@bb/plugin-sdk";

import type { Collector } from "./collector";
import { destinationLabel } from "./destination";
import { formatDuration } from "./duration";
import { durationMs, type Run } from "./model";
import { describeRun } from "./present";
import {
  installShim,
  isShimInstalled,
  pathExportLine,
  shimPaths,
  uninstallShim,
} from "./shim";
import type { Store } from "./store";
import {
  resolveBuildArgv,
  startWrappedBuild,
  waitForVerdict,
  type WrappedDeps,
} from "./wrapped";

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface CliContext {
  cwd?: string;
  signal?: AbortSignal;
}

export interface CliDeps {
  store: Store;
  collector: Collector;
  dataDir: string;
  projectName(id: string): string | null;
  refreshProjectNames(): void;
  rescan(): void;
  wrapped: WrappedDeps;
  onShimStateKnown(installed: boolean): void;
}

/**
 * Longest a `--wait` may block.
 *
 * The build is detached either way, so a timeout here abandons the *watching*,
 * never the build. Twenty minutes covers a cold archive; past that, `bb xcode
 * status` is the right tool.
 */
const MAX_WAIT_MS = 20 * 60_000;

export const CLI_COMMANDS = [
  {
    name: "status",
    summary: "What Xcode is doing right now",
    usage: "bb xcode status",
  },
  {
    name: "runs",
    summary: "Recent builds and test runs",
    usage: "bb xcode runs [--project <id>] [--kind build|test] [--limit N]",
  },
  { name: "show", summary: "Detail for one run", usage: "bb xcode show <run-id>" },
  { name: "roots", summary: "Discovered DerivedData roots", usage: "bb xcode roots" },
  { name: "rescan", summary: "Force a discovery + sweep", usage: "bb xcode rescan" },
  {
    name: "run",
    summary: "Start xcodebuild with live tracking, detached from this command",
    usage: "bb xcode run [--wait] -- xcodebuild -scheme App build",
  },
  {
    name: "wait",
    summary: "Block until a tracked run reports its verdict",
    usage: "bb xcode wait <run-id> [--timeout <seconds>]",
  },
  {
    name: "stop",
    summary: "Stop a running tracked build",
    usage: "bb xcode stop <run-id>",
  },
  {
    name: "shim",
    summary: "PATH shim so every xcodebuild records real pass/fail",
    usage: "bb xcode shim [status|install|uninstall]",
  },
] as const;

export function createCli(deps: CliDeps) {
  const present = { projectName: (id: string) => deps.projectName(id) };

  function show(id: string | undefined): CliResult {
    if (!id) return { exitCode: 1, stderr: "Usage: bb xcode show <run-id>\n" };
    const run = deps.store.getRun(id);
    if (!run) return { exitCode: 1, stderr: `No run with id '${id}'.\n` };

    const lines = [
      `id           ${run.id}`,
      `status       ${run.status}`,
      `kind         ${run.kind}`,
      `scheme       ${run.scheme ?? "—"}`,
      `project      ${run.projectId ? (deps.projectName(run.projectId) ?? run.projectId) : "—"}`,
      `destination  ${destinationLabel(run.destination, deps.collector.getSimulators()) ?? "—"}`,
      `branch       ${run.branch ?? "—"}${run.worktree ? ` (${run.worktree})` : ""}`,
      `root         ${run.root ?? "—"}`,
      `started      ${new Date(run.startedAt).toISOString()}`,
      `duration     ${formatDuration(durationMs(run))}`,
      `counts       ${run.errorCount}E ${run.warningCount}W ${run.analyzerCount}A`,
    ];
    if (run.testTotal !== null) {
      lines.push(
        `tests        ${run.testTotal} total, ${run.testFailed ?? 0} failed, ${run.testSkipped ?? 0} skipped`,
      );
    }
    if (run.cmdline) lines.push(`command      ${run.cmdline.slice(0, 500)}`);

    const findings = deps.store.listFindings(id).slice(0, 50);
    if (findings.length) {
      lines.push("", "issues:");
      for (const finding of findings) {
        const where = finding.filePath
          ? `${finding.filePath}${finding.line ? `:${finding.line}` : ""}`
          : "";
        lines.push(`  ${finding.severity.padEnd(8)} ${where} ${finding.message}`);
      }
    }
    const failures = deps.store
      .listTests(id)
      .filter((test) => test.status === "failed")
      .slice(0, 50);
    if (failures.length) {
      lines.push("", "failed tests:");
      for (const test of failures) {
        lines.push(
          `  ${test.suite ? `${test.suite}/` : ""}${test.name}${test.failureMessage ? ` — ${test.failureMessage}` : ""}`,
        );
      }
    }
    const recorded = deps.store.countTestsByStatus(id, "recorded");
    if (recorded > 0) {
      lines.push(
        "",
        `${recorded} snapshot baseline(s) were RECORDED, not failed — record mode`,
        "reports a written baseline by failing the test. They are excluded from",
        "the failure count above.",
      );
    }
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  }

  async function run(args: string[], ctx: CliContext): Promise<CliResult> {
    const wait = args.includes("--wait");
    const separator = args.indexOf("--");
    const commandArgs = separator === -1
      ? args.filter((arg) => arg !== "--wait")
      : args.slice(separator + 1);
    if (commandArgs.length === 0) {
      return {
        exitCode: 1,
        stderr: "Usage: bb xcode run [--wait] -- xcodebuild -scheme App build\n",
      };
    }

    const started = await startWrappedBuild(deps.wrapped, {
      argv: resolveBuildArgv(commandArgs),
      ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
    });
    if (!started) return { exitCode: 1, stderr: "Failed to start the build.\n" };

    if (!wait) {
      const lines = [
        "Build started; the background probe will assign its run id.",
        "It keeps running if this command disconnects.",
        "Watch it with: bb xcode status (then stop it with: bb xcode stop <run-id>).",
        "It also appears in the live row above the composer.",
        "",
        `result bundle: ${started.bundlePath}`,
      ];
      return { exitCode: 0, stdout: capOutput(`${lines.join("\n")}\n`) };
    }

    // Waiting never owns the build: if this request disconnects, or the wait
    // runs long, the build carries on and only the watching stops.
    await Promise.race([
      started.completed,
      abortPromise(ctx.signal),
      sleep(MAX_WAIT_MS),
    ]);
    const settled = await waitForVerdict(
      deps.store,
      { bundlePath: started.bundlePath },
      {
        timeoutMs: 20_000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      },
    );
    if (!settled) {
      return {
        exitCode: 0,
        stdout: capOutput(
          `Build finished, but no tracked run matched it yet.\nresult bundle: ${started.bundlePath}\n`,
        ),
      };
    }
    const detail = show(settled.id);
    return {
      exitCode: settled.status === "failed" ? 1 : 0,
      stdout: capOutput(detail.stdout ?? `${describeRun(settled, present)}\n`),
    };
  }

  async function waitFor(args: string[], ctx: CliContext): Promise<CliResult> {
    const id = args.find((arg) => !arg.startsWith("--"));
    if (!id) {
      return {
        exitCode: 1,
        stderr: "Usage: bb xcode wait <run-id> [--timeout <seconds>]\n",
      };
    }
    if (!deps.store.getRun(id)) {
      return { exitCode: 1, stderr: `No run with id '${id}'.\n` };
    }
    const seconds = Number(flag(args, "timeout"));
    const timeoutMs = Number.isFinite(seconds) && seconds > 0
      ? Math.min(seconds * 1000, MAX_WAIT_MS)
      : MAX_WAIT_MS;

    const settled = await waitForVerdict(
      deps.store,
      { runId: id },
      { timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );
    if (!settled) return { exitCode: 1, stderr: `No run with id '${id}'.\n` };
    if (settled.status === "running" || settled.status === "finishing") {
      return {
        exitCode: 2,
        stderr: `Timed out after ${Math.round(timeoutMs / 1000)}s; ${settled.id} is still ${settled.status}.\n`,
      };
    }
    const detail = show(settled.id);
    return {
      exitCode: settled.status === "failed" ? 1 : 0,
      stdout: capOutput(detail.stdout ?? `${describeRun(settled, present)}\n`),
    };
  }

  function stop(id: string | undefined): CliResult {
    if (!id) return { exitCode: 1, stderr: "Usage: bb xcode stop <run-id>\n" };
    const target = deps.store.getRun(id);
    if (!target) return { exitCode: 1, stderr: `No run with id '${id}'.\n` };
    if (target.status !== "running" || target.pid === null) {
      return { exitCode: 1, stderr: `Run ${id} is not running.\n` };
    }
    /**
     * Only signal a pid the probe can still see.
     *
     * A row can say `running` while its process is long gone — bb killed
     * mid-build leaves exactly that — and by then the OS may have handed the
     * pid to something else entirely. Checking the live snapshot first means
     * the worst case is refusing to stop a build, not SIGTERMing a stranger.
     */
    const alive = deps.collector
      .getLastActivities()
      .some((activity) => activity.pid === target.pid);
    if (!alive) {
      return {
        exitCode: 1,
        stderr: `Run ${id} claims pid ${target.pid}, but no such Xcode process is running.\n`,
      };
    }
    try {
      process.kill(target.pid, "SIGTERM");
    } catch {
      return { exitCode: 1, stderr: `Process ${target.pid} is already gone.\n` };
    }
    return { exitCode: 0, stdout: `Sent SIGTERM to ${target.pid} (${id}).\n` };
  }

  async function shim(action: string): Promise<CliResult> {
    const paths = shimPaths(deps.dataDir);
    switch (action) {
      case "install": {
        await installShim(deps.dataDir);
        deps.onShimStateKnown(true);
        return {
          exitCode: 0,
          stdout:
            `Shim installed at ${paths.script}\n\n` +
            `Add to your shell profile, then restart your shell:\n\n` +
            `  ${pathExportLine(paths.binDir)}\n\n` +
            `Every xcodebuild build/test then records a result bundle and this\n` +
            `plugin reports real pass/fail. Queries pass through untouched.\n`,
        };
      }
      case "uninstall": {
        const removed = await uninstallShim(deps.dataDir);
        deps.onShimStateKnown(false);
        return {
          exitCode: 0,
          stdout: removed
            ? "Shim removed. Drop the PATH line from your profile.\n"
            : "Shim was not installed.\n",
        };
      }
      default: {
        const installed = await isShimInstalled(deps.dataDir);
        deps.onShimStateKnown(installed);
        const active = (process.env.PATH ?? "").includes(paths.binDir);
        const lines = [
          `installed  ${installed ? "yes" : "no"}`,
          `on PATH    ${active ? "yes" : "no (add the export line and restart your shell)"}`,
          `script     ${paths.script}`,
          `bundles    ${paths.bundleDir}`,
        ];
        if (!installed) {
          lines.push(
            "",
            "Xcode writes no build log for CLI builds; pass/fail is only",
            "recoverable from a result bundle. Install with: bb xcode shim install",
          );
        }
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }
    }
  }

  return {
    show,
    async dispatch(argv: string[], ctx: CliContext): Promise<CliResult> {
      const [command = "status", ...rest] = argv;
      deps.refreshProjectNames();

      switch (command) {
        case "status": {
          const open = deps.store.listUnresolved();
          if (open.length === 0) {
            const last = deps.store.listRuns({ limit: 1 })[0];
            return {
              exitCode: 0,
              stdout: `No Xcode activity running.${last ? `\nLast: ${describeRun(last, present)}` : ""}\n`,
            };
          }
          return {
            exitCode: 0,
            stdout: `${open.length} active:\n${open.map((entry) => describeRun(entry, present)).join("\n")}\n`,
          };
        }
        case "runs": {
          const limitRaw = Number(flag(rest, "limit"));
          const rows = deps.store.listRuns({
            projectId: flag(rest, "project"),
            kind: (flag(rest, "kind") as Run["kind"] | null) ?? undefined,
            limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 25,
          });
          return {
            exitCode: 0,
            stdout: rows.length
              ? `${rows.map((entry) => describeRun(entry, present)).join("\n")}\n`
              : "No runs recorded yet.\n",
          };
        }
        case "show":
          return show(rest[0]);
        case "roots": {
          const roots = deps.store.listRoots();
          if (!roots.length) {
            return {
              exitCode: 0,
              stdout:
                "No DerivedData roots yet — they are learned from running builds.\n",
            };
          }
          const lines = roots.map(
            (root) =>
              `${root.discoveredVia.padEnd(13)} ${
                root.projectId
                  ? (deps.projectName(root.projectId) ?? root.projectId)
                  : "—"
              }`.padEnd(32) + root.path,
          );
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        case "rescan": {
          // Detached, like the rpc method: a sweep can spawn xcresulttool with
          // a 60s timeout per bundle, and holding the CLI handler open for
          // that is what put xcode on perf-watch's slow-handler list.
          deps.rescan();
          return {
            exitCode: 0,
            stdout: `Scanning in the background. ${deps.store.listRoots().length} DerivedData root(s) known so far.\n`,
          };
        }
        case "run":
          return run(rest, ctx);
        case "wait":
          return waitFor(rest, ctx);
        case "stop":
          return stop(rest[0]);
        case "shim":
          return shim(rest[0] ?? "status");
        default:
          return {
            exitCode: 1,
            // `sim` is dispatched by `server.ts` before this ever runs, so it
            // is not in `CLI_COMMANDS` — and a hint that omits half the
            // commands is how people conclude a feature does not exist.
            stderr: `Unknown command '${command}'. Try: ${[...CLI_COMMANDS.map((entry) => entry.name), "sim"].join(", ")}\n`,
          };
      }
    },
  };
}

function flag(args: readonly string[], name: string): string | null {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1]! : null;
}

export function capOutput(text: string): string {
  return Buffer.byteLength(text, "utf8") <= PLUGIN_CLI_OUTPUT_MAX_BYTES - 1024
    ? text
    : `${text.slice(0, 200_000)}\n… truncated …\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function abortPromise(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
