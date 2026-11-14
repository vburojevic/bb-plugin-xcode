/**
 * `bb xcode …`.
 *
 * The CLI is the agent-facing surface as much as the human one, so its output
 * is the same text `xcode_status` returns — see `present.ts`. Everything here
 * is thin: the work belongs to the store, the collector and `wrapped.ts`.
 */

import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@get-bb/plugin-sdk";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { Collector } from "./collector";
import { destinationLabel } from "./destination";
import { formatDuration } from "./duration";
import type { BuildLauncher } from "./launcher";
import { durationMs, type Run } from "./model";
import { describeRun, type PresentOptions } from "./present";
import {
  installShim,
  isShimInstalled,
  pathExportLine,
  shimPaths,
  uninstallShim,
} from "./shim";
import { isHostBuildRun, type Store } from "./store";
import type { BuildPhase } from "./types";
import { pathIsUnder, runMatchesScope, type ThreadScope } from "./scopes";
import { resolveBuildArgv, waitForVerdict } from "./wrapped";

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface CliContext {
  cwd?: string;
  threadId?: string;
  projectId?: string;
  signal?: AbortSignal;
}

export interface CliDeps {
  store: Store;
  collector: Collector;
  dataDir: string;
  projectName(id: string): string | null;
  /** What a live run is doing right now; null for anything settled. */
  phaseFor(run: Run): BuildPhase | null;
  refreshProjectNames(): void;
  /** Resolve the invoking thread's checkout before host-side execution. */
  scopeFor(threadId: string): Promise<ThreadScope | null>;
  /** Starts tracked builds on whichever Mac holds the thread's checkout. */
  launcher: BuildLauncher;
  /** Display name of an enrolled Mac, when known. */
  machineName(hostId: string): string | null;
  onShimStateKnown(installed: boolean): void;
  confirmHostAction(
    threadId: string,
    consent: { title: string; facts: string[]; confirmLabel: string },
  ): Promise<boolean>;
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
  const present: PresentOptions = {
    projectName: (id: string) => deps.projectName(id),
    phaseFor: (run: Run) => deps.phaseFor(run),
    machineName: (hostId: string) => deps.machineName(hostId),
  };

  /** `undefined` is reserved for direct, internal calls such as showRun. */
  type InvocationScope = ThreadScope | null | undefined;

  const scopeForInvocation = async (
    ctx: CliContext,
  ): Promise<ThreadScope | null> => {
    // PluginCliContext is forwarded from the invoking process. Treat its ids as
    // routing hints, not as identity: a claimed thread must agree with the
    // checkout the process is actually standing in before it can read that
    // thread's build history or signal one of its processes.
    if (ctx.threadId === undefined || ctx.cwd === undefined) return null;
    const scope = await deps.scopeFor(ctx.threadId);
    if (scope === null) return null;
    if (ctx.projectId !== undefined && scope.projectId !== ctx.projectId) return null;
    // Compare real paths. The OS reports the invoking process's cwd
    // physically, so a checkout bb knows through a symlink (`/tmp` on macOS,
    // a symlinked `~/Git`) never matched its own builds. A path that does not
    // exist on this machine (a checkout on another host) keeps its resolved
    // form, exactly as before.
    const cwd = await physicalPath(ctx.cwd);
    const root = await physicalPath(scope.path);
    return pathIsUnder(cwd, root) ? scope : null;
  };

  const mayReadRun = (run: Run | null, scope: InvocationScope): run is Run =>
    run !== null &&
    (scope === undefined ||
      (scope !== null && runMatchesScope(run, scope)));

  function show(
    id: string | undefined,
    scope: InvocationScope = undefined,
  ): CliResult {
    if (!id) return { exitCode: 1, stderr: "Usage: bb xcode show <run-id>\n" };
    const run = deps.store.getRun(id);
    // Deliberately do not distinguish an absent run from one outside the
    // invoking thread. The distinction is itself a cross-thread oracle.
    if (!mayReadRun(run, scope)) {
      return { exitCode: 1, stderr: `No run with id '${id}'.\n` };
    }

    const lines = [
      `id           ${run.id}`,
      `status       ${run.status}`,
      `kind         ${run.kind}`,
      `scheme       ${run.scheme ?? "—"}`,
      `project      ${run.projectId ? (deps.projectName(run.projectId) ?? run.projectId) : "—"}`,
      `destination  ${destinationLabel(run.destination, deps.collector.getSimulators()) ?? "—"}`,
      `branch       ${run.branch ?? "—"}${run.worktree ? ` (${run.worktree})` : ""}`,
      ...(run.hostId !== null
        ? [`machine      ${deps.machineName(run.hostId) ?? run.hostId}`]
        : []),
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

    let argv: string[];
    try {
      argv = resolveBuildArgv(commandArgs);
    } catch (error) {
      return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
    }

    let root: string;
    let workingDir: string;
    let scope: ThreadScope;
    let target: Awaited<ReturnType<BuildLauncher["targetFor"]>>;
    try {
      if (ctx.threadId === undefined) {
        return {
          exitCode: 1,
          stderr:
            "Tracked builds require a bb thread so the checkout security boundary can be enforced.\n",
        };
      }
      const resolved = await scopeForInvocation(ctx);
      if (resolved === null) {
        return {
          exitCode: 1,
          stderr: "The invoking checkout does not match this thread, so xcodebuild was not started.\n",
        };
      }
      scope = resolved;
      // The thread's environment decides the machine: a checkout on another
      // enrolled Mac is validated and built there, by its host worker.
      target = await deps.launcher.targetFor(scope);
      root = scope.path;
      workingDir = await deps.launcher.prepare(target, {
        argv,
        root,
        ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
      });
      const machine = target.machineName;
      const approved = await deps.confirmHostAction(ctx.threadId, {
        title: machine ? `Run xcodebuild on ${machine}?` : "Run xcodebuild on the host?",
        facts: [
          ...(machine ? [`Machine: ${machine}`] : []),
          `Checkout: ${root}`,
          `Command: ${argv.join(" ").slice(0, 500)}`,
          `Xcode projects can run build phases, package plugins, compiler plugins, and tests as your user on ${machine ?? "the host"}.`,
        ],
        confirmLabel: "Run xcodebuild",
      });
      if (!approved) {
        return {
          exitCode: 1,
          stderr: "The host xcodebuild run was not confirmed.\n",
        };
      }
    } catch (error) {
      return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
    }
    const started = await deps.launcher.start(
      target,
      { argv, root, workingDir, ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}) },
      scope,
    );
    if (typeof started === "string") return { exitCode: 1, stderr: `${started}\n` };

    if (!wait) {
      const lines =
        target.kind === "remote"
          ? [
              `Build started on ${target.machineName} as ${started.runId}.`,
              "It keeps running if this command disconnects.",
              `Wait for it with: bb xcode wait ${started.runId} (stop it with: bb xcode stop ${started.runId}).`,
              "It also appears in the live row above the composer.",
              "",
              `result bundle (on ${target.machineName}): ${started.bundlePath}`,
            ]
          : [
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
      // A build on another Mac is found by its run id: its bundle path names
      // a file on that Mac, and the same path could exist here.
      started.runId !== null ? { runId: started.runId } : { bundlePath: started.bundlePath },
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
    const scope = await scopeForInvocation(ctx);
    if (!mayReadRun(deps.store.getRun(id), scope)) {
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
    const detail = show(settled.id, scope);
    return {
      exitCode: settled.status === "failed" ? 1 : 0,
      stdout: capOutput(detail.stdout ?? `${describeRun(settled, present)}\n`),
    };
  }

  async function stop(
    id: string | undefined,
    ctx: CliContext,
  ): Promise<CliResult> {
    if (!id) return { exitCode: 1, stderr: "Usage: bb xcode stop <run-id>\n" };
    const scope = await scopeForInvocation(ctx);
    const target = deps.store.getRun(id);
    if (!mayReadRun(target, scope)) {
      return { exitCode: 1, stderr: `No run with id '${id}'.\n` };
    }
    if (target.status !== "running" || target.pid === null) {
      return { exitCode: 1, stderr: `Run ${id} is not running.\n` };
    }
    if (target.hostId !== null) {
      if (isHostBuildRun(target)) return stopRemote(target, ctx);
      // Watched, not run: this plugin started nothing there to stop, and it
      // will not signal a process on another Mac it did not start.
      const machine = deps.machineName(target.hostId) ?? target.hostId;
      return {
        exitCode: 1,
        stderr: `Run ${id} is a build this plugin only watches on ${machine}; stop it there (Xcode's Stop button, or Ctrl-C in its terminal).\n`,
      };
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
    if (ctx.threadId === undefined) {
      return {
        exitCode: 1,
        stderr:
          "Stopping a host build requires a bb thread so a person can confirm it.\n",
      };
    }
    const approved = await deps.confirmHostAction(ctx.threadId, {
      title: "Stop this host Xcode build?",
      facts: [
        `Run: ${target.id}`,
        `Process: ${target.pid}`,
        `Checkout: ${target.cwd ?? target.container ?? target.root ?? "unknown"}`,
      ],
      confirmLabel: "Stop build",
    });
    if (!approved) {
      return { exitCode: 1, stderr: `Stopping ${id} was not confirmed.\n` };
    }
    try {
      process.kill(target.pid, "SIGTERM");
    } catch {
      return { exitCode: 1, stderr: `Process ${target.pid} is already gone.\n` };
    }
    return { exitCode: 0, stdout: `Sent SIGTERM to ${target.pid} (${id}).\n` };
  }

  /**
   * Stop a build on another Mac. Its worker proves the pid is still that
   * build (start time + marker) before it signals anything, which is the
   * remote equivalent of the live-snapshot check above.
   */
  async function stopRemote(target: Run, ctx: CliContext): Promise<CliResult> {
    if (ctx.threadId === undefined) {
      return {
        exitCode: 1,
        stderr:
          "Stopping a host build requires a bb thread so a person can confirm it.\n",
      };
    }
    const machine = deps.machineName(target.hostId!) ?? target.hostId!;
    const approved = await deps.confirmHostAction(ctx.threadId, {
      title: `Stop this Xcode build on ${machine}?`,
      facts: [
        `Run: ${target.id}`,
        `Machine: ${machine}`,
        `Process: ${target.pid}`,
        `Checkout: ${target.cwd ?? target.container ?? target.root ?? "unknown"}`,
      ],
      confirmLabel: "Stop build",
    });
    if (!approved) {
      return { exitCode: 1, stderr: `Stopping ${target.id} was not confirmed.\n` };
    }
    const result = await deps.launcher.stopRemote(target);
    return result.stopped
      ? { exitCode: 0, stdout: `${result.message}\n` }
      : { exitCode: 1, stderr: `${result.message}\n` };
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
          const scope = await scopeForInvocation(ctx);
          const open = deps.store
            .listUnresolved()
            .filter((run) => mayReadRun(run, scope));
          if (open.length === 0) {
            const last = scope === undefined
              ? deps.store.listRuns({ limit: 1 })[0]
              : scope
                ? deps.store.listRuns({ limit: 1, scope })[0]
                : undefined;
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
          const scope = await scopeForInvocation(ctx);
          const limitRaw = Number(flag(rest, "limit"));
          const rows = scope === null
            ? []
            : deps.store.listRuns({
                projectId: flag(rest, "project"),
                kind:
                  (flag(rest, "kind") as Run["kind"] | null) ?? undefined,
                limit:
                  Number.isFinite(limitRaw) && limitRaw > 0
                    ? Math.min(Math.floor(limitRaw), 100)
                    : 25,
                ...(scope ? { scope } : {}),
              });
          return {
            exitCode: 0,
            stdout: rows.length
              ? `${rows.map((entry) => describeRun(entry, present)).join("\n")}\n`
              : "No runs recorded yet.\n",
          };
        }
        case "show": {
          const scope = await scopeForInvocation(ctx);
          return show(rest[0], scope);
        }
        case "roots": {
          const scope = await scopeForInvocation(ctx);
          const roots = deps.store.listRoots().filter((root) =>
            scope === undefined
              ? true
              : scope !== null &&
                scope.projectId !== null &&
                root.projectId === scope.projectId,
          );
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
        case "run":
          return run(rest, ctx);
        case "wait":
          return waitFor(rest, ctx);
        case "stop":
          return stop(rest[0], ctx);
        case "shim": {
          const action = rest[0] ?? "status";
          if ((action === "install" || action === "uninstall") && ctx.threadId === undefined) {
            return {
              exitCode: 1,
              stderr:
                "Shim changes require a bb thread so a person can confirm them.\n",
            };
          }
          if (action === "install" || action === "uninstall") {
            if ((await scopeForInvocation(ctx)) === null) {
              return {
                exitCode: 1,
                stderr: "The invoking checkout does not match this thread, so the host shim was not changed.\n",
              };
            }
            const approved = await deps.confirmHostAction(
              ctx.threadId!,
              {
                title:
                  action === "install"
                    ? "Install the host-wide xcodebuild shim?"
                    : "Remove the host-wide xcodebuild shim?",
                facts:
                  action === "install"
                    ? [
                        "This writes a wrapper into the Xcode plugin data directory.",
                        "It affects xcodebuild only after you add the shown directory to PATH.",
                      ]
                    : [
                        "This removes the wrapper from the Xcode plugin data directory.",
                        "Existing builds keep running, but new shell builds will no longer be wrapped.",
                      ],
                confirmLabel:
                  action === "install" ? "Install shim" : "Remove shim",
              },
            );
            if (!approved) {
              return {
                exitCode: 1,
                stderr: `Shim ${action} was not confirmed.\n`,
              };
            }
          }
          return shim(action);
        }
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

/** The real path when it exists here, otherwise the resolved one. */
async function physicalPath(path: string): Promise<string> {
  const resolved = resolve(path);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
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
