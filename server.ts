/**
 * Xcode activity tracker — backend, v2.
 *
 * Pure wiring. The rules live in `src/model.ts`, state in `src/store.ts`,
 * reconciliation in `src/engine.ts`, and I/O in `src/collector.ts`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { PLUGIN_CLI_OUTPUT_MAX_BYTES, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import { XCODE_CHANNEL } from "./src/channel";
import { rpcContract } from "./src/contract";
import { Collector, type CollectorProject } from "./src/collector";
import { Engine } from "./src/engine";
import { durationMs, type Run } from "./src/model";
import { describeExit, runWrapped } from "./src/runner";
import {
  installShim,
  isShimInstalled,
  pathExportLine,
  pruneShimBundles,
  shimPaths,
  uninstallShim,
} from "./src/shim";
import { MIGRATIONS, Store, type Db } from "./src/store";
import { destinationLabel } from "./src/destination";

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    scanIntervalSeconds: {
      type: "string",
      label: "Process scan interval (seconds)",
      default: "2",
    },
    retentionDays: {
      type: "string",
      label: "Keep history for (days)",
      default: "30",
    },
    scanProjects: {
      type: "boolean",
      label: "Scan project worktrees for DerivedData",
      default: true,
    },
    extraRoots: {
      type: "string",
      label: "Extra DerivedData roots (comma separated)",
      default: "",
    },
  });

  const dataDir = join(homedir(), ".bb", "plugins", bb.pluginId);
  const db = bb.storage.database() as unknown as Db;
  bb.storage.migrate(db as never, [...MIGRATIONS]);
  const store = new Store(db);

  const readSettings = async () => {
    const values = await settings.get();
    const interval = Number(values.scanIntervalSeconds);
    const retention = Number(values.retentionDays);
    return {
      scanIntervalMs:
        Number.isFinite(interval) && interval >= 1
          ? Math.min(interval, 60) * 1000
          : 2000,
      retentionDays:
        Number.isFinite(retention) && retention >= 1 ? retention : 30,
      scanProjects: values.scanProjects,
      extraRoots: values.extraRoots
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    };
  };

  let current = await readSettings();

  const publish = (): void => {
    bb.realtime.publish(XCODE_CHANNEL, { at: Date.now() });
  };

  const listProjects = async (): Promise<CollectorProject[]> => {
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const out: CollectorProject[] = [];
    for (const project of projects) {
      const sources =
        (project as { sources?: Array<{ path?: string }> }).sources ?? [];
      for (const source of sources) {
        if (source.path) {
          out.push({ id: project.id, name: project.name, path: source.path });
        }
      }
    }
    return out;
  };

  // Engine and collector reference each other (engine asks the collector for
  // project attribution); a late-bound holder breaks the cycle for TS.
  let collectorRef: Collector | null = null;
  const engine: Engine = new Engine(store, {
    projectFor: (signals): string | null =>
      collectorRef ? collectorRef.projectFor(signals) : null,
    log: (message) => bb.log.debug(message),
  });
  const collector = new Collector(
    { store, engine, listProjects, log: bb.log, dataDir },
    current,
  );
  collectorRef = collector;
  engine.hydrate(Date.now());

  settings.onChange(async () => {
    current = await readSettings();
    collector.updateSettings(current);
  });

  // ------------------------------------------------------------------ DTOs

  const projectNames = new Map<string, string>();
  const refreshProjectNames = (): void => {
    projectNames.clear();
    for (const project of collector.getProjects()) {
      projectNames.set(project.id, project.name);
    }
  };

  const toDto = (run: Run) => ({
    id: run.id,
    status: run.status,
    kind: run.kind,
    scheme: run.scheme,
    container: run.container,
    configuration: run.configuration,
    destination: run.destination,
    projectId: run.projectId,
    projectName: run.projectId
      ? (projectNames.get(run.projectId) ?? null)
      : null,
    root: run.root,
    cwd: run.cwd,
    pid: run.pid,
    cmdline: run.cmdline,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: durationMs(run),
    errorCount: run.errorCount,
    warningCount: run.warningCount,
    analyzerCount: run.analyzerCount,
    testTotal: run.testTotal,
    testFailed: run.testFailed,
    testSkipped: run.testSkipped,
    bundlePath: run.bundlePath,
    detailed: run.detailed,
    branch: run.branch,
    worktree: run.worktree,
    destinationLabel: destinationLabel(run.destination, collector.getSimulators()),
    workerCount:
      run.status === "running"
        ? engine.liveWorkerCount(run.id, collector.getLastActivities())
        : null,
  });

  // ------------------------------------------------------------------- RPC

  bb.rpc.register(rpcContract, {
    async overview(input) {
      refreshProjectNames();
      const query = {
        projectId: input.projectId ?? null,
        kind: input.kind ?? null,
        limit: input.limit ?? 100,
      };
      const unique = new Map<string, CollectorProject>();
      for (const project of collector.getProjects()) {
        if (!unique.has(project.id)) unique.set(project.id, project);
      }
      const shim = shimPaths(dataDir);
      return {
        runs: store.listRuns(query).map(toDto),
        total: store.countRuns(query),
        projects: [...unique.values()],
        rootCount: store.listRoots().length,
        lastScanAt: collector.getLastScanAt(),
        xcodeAvailable: await collector.isXcodeAvailable(),
        shimActive:
          (await isShimInstalled(dataDir)) &&
          (process.env.PATH ?? "").includes(shim.binDir),
        simulators: collector.getBootedSimulators(),
      };
    },

    runDetail({ id }) {
      refreshProjectNames();
      const run = store.getRun(id);
      return {
        run: run ? toDto(run) : null,
        findings: store.listFindings(id).map((finding) => ({
          severity: finding.severity,
          message: finding.message,
          filePath: finding.filePath,
          line: finding.line,
          target: finding.target,
        })),
        tests: store.listTests(id).map((test) => ({
          suite: test.suite,
          name: test.name,
          status: test.status,
          durationMs: test.durationMs,
          failureMessage: test.failureMessage,
          target: test.target,
        })),
      };
    },

    trends(input) {
      const since = Date.now() - (input.days ?? 30) * 86_400_000;
      return store.trends(input.projectId ?? null, since);
    },

    async rescan() {
      // Detached: a full sweep can spawn xcresulttool with a 60s timeout per
      // bundle plus a sync JSON.parse of tens of MB — far too slow to hold an
      // RPC handler (and the shared event loop) open for.
      void collector
        .fullScan()
        .then((changed) => {
          if (changed) publish();
        })
        .catch(() => {});
      return { ok: true, rootCount: store.listRoots().length };
    },
  });

  // -------------------------------------------------------------- services

  bb.background.service("probe", {
    async start(signal) {
      await collector.isXcodeAvailable().catch(() => false);
      await collector.fullScan().catch((error: unknown) => {
        bb.log.warn(`initial scan failed: ${String(error)}`);
      });
      publish();

      let sinceSweep = 0;
      // The moment a run leaves `running`, sweep soon after: the log store and
      // shim bundle land within a couple of seconds of process exit.
      let pendingVerdicts = false;

      let failures = 0;
      while (!signal.aborted) {
        try {
          const changed = await collector.probeTick();
          // A sweep can run for a minute; without these re-checks a reload
          // mid-sweep lets the publish below fire on a disposed handle.
          if (signal.aborted) break;
          if (changed) publish();

          const open = engine.hasOpenRuns();
          sinceSweep += current.scanIntervalMs;
          const due = pendingVerdicts
            ? sinceSweep >= 4_000
            : sinceSweep >= 30_000;
          if (due) {
            sinceSweep = 0;
            const swept = await collector.fullScan();
            if (signal.aborted) break;
            if (swept) publish();
            pendingVerdicts = engine.hasOpenRuns();
          } else if (open) {
            pendingVerdicts = true;
          }
          failures = 0;
        } catch (error: unknown) {
          failures = Math.min(failures + 1, 5);
          bb.log.warn(`probe tick failed: ${String(error)}`);
        }
        await sleep(
          failures > 0
            ? Math.min(current.scanIntervalMs * 2 ** failures, 60_000)
            : current.scanIntervalMs,
          signal,
        );
      }
    },
  });

  bb.background.schedule("discover", "*/10 * * * *", async () => {
    const changed = await collector.fullScan();
    if (changed) publish();
  });

  bb.background.schedule("prune", "23 4 * * *", async () => {
    await pruneShimBundles(dataDir, current.retentionDays * 86_400_000, Date.now());
    const cutoff = Date.now() - current.retentionDays * 86_400_000;
    const removed = store.prune(cutoff);
    // Roots were never pruned (stale ones make every sweep slower forever),
    // and the WAL was never checkpointed — the visible "4.8MB db" was 82% WAL.
    db.prepare(`DELETE FROM root WHERE last_seen_at < ?`).run(cutoff);
    db.prepare(`PRAGMA wal_checkpoint(TRUNCATE)`).get();
    if (removed > 0) {
      bb.log.info(`pruned ${removed} run(s) past retention`);
      publish();
    }
  });

  // ------------------------------------------------------------------- CLI

  function formatDuration(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  }

  function shortName(path: string | null): string | null {
    if (!path) return null;
    const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
    const index = trimmed.lastIndexOf("/");
    return index === -1 ? trimmed : trimmed.slice(index + 1);
  }

  function describeRun(run: Run): string {
    const name = run.scheme ?? shortName(run.container) ?? shortName(run.root) ?? "—";
    const project = run.projectId
      ? (projectNames.get(run.projectId) ?? run.projectId)
      : "—";
    const counts: string[] = [];
    if (run.errorCount) counts.push(`${run.errorCount}E`);
    if (run.warningCount) counts.push(`${run.warningCount}W`);
    if (run.testFailed) counts.push(`${run.testFailed} failed`);
    const suffix = counts.length ? `  [${counts.join(" ")}]` : "";
    const at = run.branch ? ` @${run.branch}` : "";
    const time =
      run.status === "running"
        ? `running ${formatDuration(Date.now() - run.startedAt)}`
        : formatDuration(durationMs(run));
    return `${run.status.padEnd(9)} ${run.kind.padEnd(7)} ${(name + at).padEnd(30)} ${project.padEnd(14)} ${time}${suffix}  ${run.id}`;
  }

  bb.cli.register({
    name: "xcode",
    summary: "Track Xcode builds, tests and other Xcode activity",
    commands: [
      { name: "status", summary: "What Xcode is doing right now", usage: "bb xcode status" },
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
        summary: "Run xcodebuild with live tracking (adds result bundle + stream)",
        usage: "bb xcode run -- xcodebuild -scheme App build",
      },
      {
        name: "shim",
        summary: "PATH shim so every xcodebuild records real pass/fail",
        usage: "bb xcode shim [status|install|uninstall]",
      },
    ],
    async run(argv, ctx) {
      const [command = "status", ...rest] = argv;
      refreshProjectNames();

      switch (command) {
        case "status": {
          const open = store.listUnresolved();
          if (open.length === 0) {
            const last = store.listRuns({ limit: 1 })[0];
            return {
              exitCode: 0,
              stdout: `No Xcode activity running.${last ? `\nLast: ${describeRun(last)}` : ""}\n`,
            };
          }
          return {
            exitCode: 0,
            stdout: `${open.length} active:\n${open.map(describeRun).join("\n")}\n`,
          };
        }
        case "runs": {
          const flag = (name: string): string | null => {
            const index = rest.indexOf(`--${name}`);
            return index !== -1 && rest[index + 1] ? rest[index + 1]! : null;
          };
          const limitRaw = Number(flag("limit"));
          const rows = store.listRuns({
            projectId: flag("project"),
            kind: (flag("kind") as Run["kind"] | null) ?? undefined,
            limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 25,
          });
          return {
            exitCode: 0,
            stdout: rows.length
              ? `${rows.map(describeRun).join("\n")}\n`
              : "No runs recorded yet.\n",
          };
        }
        case "show":
          return cliShow(rest[0]);
        case "roots": {
          const roots = store.listRoots();
          if (!roots.length) {
            return {
              exitCode: 0,
              stdout: "No DerivedData roots yet — they are learned from running builds.\n",
            };
          }
          const lines = roots.map(
            (root) =>
              `${root.discoveredVia.padEnd(13)} ${
                root.projectId
                  ? (projectNames.get(root.projectId) ?? root.projectId)
                  : "—"
              }`.padEnd(32) + root.path,
          );
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        case "rescan": {
          const changed = await collector.fullScan();
          if (changed) publish();
          return {
            exitCode: 0,
            stdout: `Scanned. ${store.listRoots().length} DerivedData root(s) known.\n`,
          };
        }
        case "run":
          return cliRun(rest, ctx);
        case "shim":
          return cliShim(rest[0] ?? "status");
        default:
          return {
            exitCode: 1,
            stderr: `Unknown command '${command}'. Try: status, runs, show, roots, rescan, run, shim\n`,
          };
      }
    },
  });

  function cliShow(id: string | undefined): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  } {
    if (!id) return { exitCode: 1, stderr: "Usage: bb xcode show <run-id>\n" };
    const run = store.getRun(id);
    if (!run) return { exitCode: 1, stderr: `No run with id '${id}'.\n` };

    const lines = [
      `id           ${run.id}`,
      `status       ${run.status}`,
      `kind         ${run.kind}`,
      `scheme       ${run.scheme ?? "—"}`,
      `project      ${run.projectId ? (projectNames.get(run.projectId) ?? run.projectId) : "—"}`,
      `destination  ${destinationLabel(run.destination, collector.getSimulators()) ?? "—"}`,
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

    const findings = store.listFindings(id).slice(0, 50);
    if (findings.length) {
      lines.push("", "issues:");
      for (const finding of findings) {
        const where = finding.filePath
          ? `${finding.filePath}${finding.line ? `:${finding.line}` : ""}`
          : "";
        lines.push(`  ${finding.severity.padEnd(8)} ${where} ${finding.message}`);
      }
    }
    const failures = store
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
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  }

  let lastLivePublishAt = 0;
  async function cliRun(
    args: string[],
    ctx: { cwd?: string; signal?: AbortSignal },
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
    const separator = args.indexOf("--");
    const commandArgs = separator === -1 ? args : args.slice(separator + 1);
    if (commandArgs.length === 0) {
      return {
        exitCode: 1,
        stderr: "Usage: bb xcode run -- xcodebuild -scheme App build\n",
      };
    }
    const argv =
      commandArgs[0] === "xcodebuild"
        ? ["/usr/bin/xcodebuild", ...commandArgs.slice(1)]
        : commandArgs;

    const result = await runWrapped({
      argv,
      cwd: ctx.cwd,
      signal: ctx.signal,
      onEvent: (_event, progress) => {
        // Throttled: xcodebuild can emit hundreds of events per build, and
        // every publish makes each open panel refetch the full overview —
        // N events × M panels of amplification.
        const at = Date.now();
        if (at - lastLivePublishAt < 500) return;
        lastLivePublishAt = at;
        bb.realtime.publish(XCODE_CHANNEL, {
          at,
          live: {
            section: progress.currentSection,
            opened: progress.sectionsOpened,
            closed: progress.sectionsClosed,
            errors: progress.errors,
            warnings: progress.warnings,
          },
        });
      },
    });

    await collector.fullScan();
    publish();

    const summary =
      `${describeExit(result.exitCode)} — ${result.progress.sectionsOpened} sections, ` +
      `${result.progress.errors} error(s), ${result.progress.warnings} warning(s)\n` +
      `result bundle: ${result.bundlePath}\n`;
    return {
      exitCode: result.exitCode,
      stdout: capOutput(summary),
      stderr:
        result.exitCode === 0 ? undefined : result.stderrTail.slice(-4000) || undefined,
    };
  }

  async function cliShim(
    action: string,
  ): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
    const paths = shimPaths(dataDir);
    switch (action) {
      case "install": {
        await installShim(dataDir);
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
        const removed = await uninstallShim(dataDir);
        return {
          exitCode: 0,
          stdout: removed
            ? "Shim removed. Drop the PATH line from your profile.\n"
            : "Shim was not installed.\n",
        };
      }
      default: {
        const installed = await isShimInstalled(dataDir);
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

  function capOutput(text: string): string {
    return Buffer.byteLength(text, "utf8") <= PLUGIN_CLI_OUTPUT_MAX_BYTES - 1024
      ? text
      : `${text.slice(0, 200_000)}\n… truncated …\n`;
  }

  // ----------------------------------------------------------- agent tools

  bb.agents.registerTool({
    name: "xcode_status",
    description:
      "Report Xcode build/test activity on this machine: what is running now and how recent runs finished. Use instead of grepping build logs.",
    instructions:
      "Prefer xcode_status over parsing xcodebuild output when the user asks whether a build or test run passed.",
    experimental_statusLabels: {
      pending: "Checking Xcode activity",
      completed: "Checked Xcode activity",
    },
    parameters: z.object({
      limit: z.number().int().min(1).max(25).optional(),
    }),
    execute({ limit }) {
      refreshProjectNames();
      const open = store.listUnresolved();
      const recent = store.listRuns({ limit: limit ?? 5 });
      const parts: string[] = [
        open.length
          ? `Active (${open.length}):\n${open.map(describeRun).join("\n")}`
          : "Nothing is building right now.",
      ];
      if (recent.length) {
        parts.push(`\nRecent:\n${recent.map(describeRun).join("\n")}`);
      }
      return parts.join("\n");
    },
  });

  bb.agents.registerTool({
    name: "xcode_last_failure",
    description:
      "Return the errors and failed tests from the most recent failed Xcode run, with file paths and line numbers.",
    experimental_statusLabels: {
      pending: "Reading last Xcode failure",
      completed: "Read last Xcode failure",
    },
    parameters: z.object({
      projectId: z.string().optional(),
    }),
    execute({ projectId }) {
      refreshProjectNames();
      const failed = store
        .listRuns({ projectId: projectId ?? null, onlyProblems: true, limit: 1 })[0];
      if (!failed) return "No failed Xcode runs recorded.";
      const detail = cliShow(failed.id);
      return detail.stdout ?? detail.stderr ?? "No detail available.";
    },
  });

  bb.onDispose(() => {
    bb.log.debug("xcode tracker disposed");
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
