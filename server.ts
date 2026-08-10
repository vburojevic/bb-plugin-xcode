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
import { ThreadScopes, runMatchesScope, type ThreadScope } from "./src/scopes";

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

  const scopes = new ThreadScopes();

  // Engine and collector reference each other (engine asks the collector for
  // project attribution); a late-bound holder breaks the cycle for TS.
  let collectorRef: Collector | null = null;
  const engine: Engine = new Engine(store, {
    projectFor: (signals): string | null =>
      collectorRef ? collectorRef.projectFor(signals) : null,
    threadFor: (signals): string | null => scopes.threadFor(signals),
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

  // -------------------------------------------------------- thread scopes
  //
  // There is no event for "an agent ran xcodebuild"; what bb DOES tell us is
  // when a thread starts a turn, and its environment names the exact checkout
  // any build it launches will run from. Registering that path as a scope
  // lets the probe attribute a new build to its thread on first sighting, and
  // lets the chat card / agent tools answer for "this thread's build" instead
  // of the whole machine.

  const scopeResolvedAt = new Map<string, number>();

  const refreshThreadScope = async (
    threadId: string,
    active: boolean,
  ): Promise<ThreadScope | null> => {
    const now = Date.now();
    const last = scopeResolvedAt.get(threadId) ?? 0;
    // Within the throttle window, answer from the registry (null for a thread
    // that resolved to no checkout — retrying an env-less side chat every
    // event would be two SDK calls per turn for nothing).
    if (now - last < 30_000) return scopes.get(threadId);
    if (scopeResolvedAt.size > 1000) scopeResolvedAt.clear();
    scopeResolvedAt.set(threadId, now);
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const environmentId =
        (thread as { environmentId?: string | null }).environmentId ?? null;
      if (!environmentId) return null;
      const env = await bb.sdk.environments.get({ environmentId });
      if (!env.path) return null;
      scopes.upsert(
        {
          threadId,
          projectId: env.projectId ?? null,
          environmentId,
          path: env.path,
          branch: env.branchName ?? null,
          active,
        },
        Date.now(),
      );
      // A build the probe saw before this scope existed: claim it now.
      const backfilled = store.attributeRunsToThread(
        threadId,
        env.path,
        Date.now() - 6 * 3_600_000,
      );
      if (backfilled > 0) publish();
      return scopes.get(threadId);
    } catch (error: unknown) {
      bb.log.debug(`thread scope resolve failed (${threadId}): ${String(error)}`);
      return null;
    }
  };

  bb.events.on("thread.active", ({ thread }) => {
    const existing = scopes.get(thread.id);
    if (existing) {
      scopes.upsert({ ...existing, active: true }, Date.now());
    }
    void refreshThreadScope(thread.id, true);
    scopes.prune(Date.now());
  });
  bb.events.on("thread.idle", ({ thread }) => {
    scopes.deactivate(thread.id, Date.now());
  });
  bb.events.on("thread.failed", ({ thread }) => {
    scopes.deactivate(thread.id, Date.now());
  });
  bb.events.on("thread.archived", ({ thread }) => {
    scopes.remove(thread.id);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    scopes.remove(thread.id);
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
    threadId: run.threadId,
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

    async chatStatus({ threadId, runId }) {
      refreshProjectNames();

      let scope: ThreadScope | null = null;
      if (threadId) {
        scope = scopes.get(threadId) ?? (await refreshThreadScope(threadId, false));
      }
      const scopeDto = scope
        ? {
            threadId: scope.threadId,
            path: scope.path,
            branch: scope.branch,
            worktree: shortName(scope.path),
          }
        : null;
      const inScope = (run: Run): boolean =>
        !scope || runMatchesScope(run, scope);

      const unresolved = store.listUnresolved().filter(inScope);
      const finished = store
        .listRuns({ limit: 100 })
        .filter((run) => run.status !== "running" && run.status !== "finishing")
        .filter(inScope)
        .slice(0, 5);

      const pinned = runId ? store.getRun(runId) : null;
      const run = pinned ?? unresolved[0] ?? finished[0] ?? null;

      const problems =
        run !== null &&
        (run.status === "failed" ||
          run.errorCount > 0 ||
          (run.testFailed ?? 0) > 0);
      return {
        run: run ? toDto(run) : null,
        active: unresolved
          .filter((entry) => entry.id !== run?.id)
          .map(toDto),
        recent: finished.filter((entry) => entry.id !== run?.id).map(toDto),
        scope: scopeDto,
        findings: problems
          ? store
              .listFindings(run.id)
              .filter((finding) => finding.severity === "error")
              .slice(0, 10)
              .map((finding) => ({
                severity: finding.severity,
                message: finding.message,
                filePath: finding.filePath,
                line: finding.line,
                target: finding.target,
              }))
          : [],
        failedTests: problems
          ? store
              .listTests(run.id)
              .filter((test) => test.status === "failed")
              .slice(0, 10)
              .map((test) => ({
                suite: test.suite,
                name: test.name,
                status: test.status,
                durationMs: test.durationMs,
                failureMessage: test.failureMessage,
                target: test.target,
              }))
          : [],
      };
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
        summary:
          "Start xcodebuild with live tracking, detached from this command (returns a run id + chat directive)",
        usage: "bb xcode run -- xcodebuild -scheme App build",
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
        case "stop":
          return cliStop(rest[0]);
        case "shim":
          return cliShim(rest[0] ?? "status");
        default:
          return {
            exitCode: 1,
            stderr: `Unknown command '${command}'. Try: status, runs, show, roots, rescan, run, stop, shim\n`,
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

  /**
   * Start a wrapped xcodebuild and return as soon as the tracker has adopted
   * it. DELIBERATELY DETACHED from the CLI request: holding the request open
   * for a whole build meant bb's CLI proxy timeout (~5 min, measured live on
   * a Packerly build) aborted ctx.signal, which SIGTERM'd xcodebuild mid-
   * build and left an unfinalized result bundle. A build's lifetime belongs
   * to the build; `bb xcode stop <id>` is the cancellation path.
   */
  async function cliRun(
    args: string[],
    ctx: { cwd?: string },
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

    let bundlePath: string | null = null;
    const started = new Promise<void>((resolve) => {
      void runWrapped({
        argv,
        cwd: ctx.cwd,
        onStart: (info) => {
          bundlePath = info.bundlePath;
          resolve();
        },
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
      })
        .then(async (result) => {
          engine.foldWrappedExit(
            result.bundlePath,
            {
              exitCode: result.exitCode,
              signal: result.signal,
              errors: result.progress.errors,
              warnings: result.progress.warnings,
            },
            Date.now(),
          );
          await collector.fullScan();
          publish();
          bb.log.info(
            `wrapped build ${describeExit(result.exitCode, result.signal)}: ${result.bundlePath}`,
          );
        })
        .catch((error: unknown) => {
          resolve();
          bb.log.warn(`wrapped build failed to run: ${String(error)}`);
        });
    });
    await started;
    if (!bundlePath) {
      return { exitCode: 1, stderr: "Failed to start the build.\n" };
    }

    // Give the probe a moment to adopt the process so we can hand back a
    // run id (and thus a chat card) instead of just a bundle path.
    let tracked: Run | undefined;
    for (let attempt = 0; attempt < 8 && !tracked; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await collector.probeTick().catch(() => false);
      tracked = store
        .listRuns({ limit: 25 })
        .find((run) => run.bundlePath === bundlePath);
    }
    publish();

    const lines = [
      `Build started${tracked ? ` and tracked as ${tracked.id}` : ""}.`,
      `It keeps running if this command disconnects; stop it with: bb xcode stop ${tracked?.id ?? "<run-id>"}`,
      `Watch it: bb xcode status, or emit this directive on its own line in chat (not in a code fence):`,
      tracked ? `::xcode{run="${tracked.id}"}` : "::xcode{}",
      "",
      `result bundle: ${bundlePath}`,
    ];
    return { exitCode: 0, stdout: capOutput(`${lines.join("\n")}\n`) };
  }

  function cliStop(id: string | undefined): {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  } {
    if (!id) return { exitCode: 1, stderr: "Usage: bb xcode stop <run-id>\n" };
    const run = store.getRun(id);
    if (!run) return { exitCode: 1, stderr: `No run with id '${id}'.\n` };
    if (run.status !== "running" || run.pid === null) {
      return { exitCode: 1, stderr: `Run ${id} is not running.\n` };
    }
    try {
      process.kill(run.pid, "SIGTERM");
    } catch {
      return { exitCode: 1, stderr: `Process ${run.pid} is already gone.\n` };
    }
    return { exitCode: 0, stdout: `Sent SIGTERM to ${run.pid} (${id}).\n` };
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

  const directiveHint = (runId: string | null): string =>
    "\n\nTo render a live status card in chat, emit this directive on its own line (never inside a code fence):\n" +
    (runId ? `::xcode{run="${runId}"}` : "::xcode{}") +
    (runId
      ? "\nBare ::xcode{} instead shows this thread's current Xcode activity."
      : "");

  bb.agents.registerTool({
    name: "xcode_status",
    description:
      "Report Xcode build/test activity: what is running now and how recent runs finished, scoped to this thread's checkout when possible. Use instead of grepping build logs.",
    instructions:
      "Prefer xcode_status over parsing xcodebuild output when the user asks whether a build or test run passed. " +
      'After starting or checking an Xcode build or test run, emit `::xcode{}` (or `::xcode{run="<id>"}` for one specific run) on its own line, never inside a code fence — bb renders it as a live status card that updates as the build progresses.',
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
    async execute({ limit, machineWide }, { threadId }) {
      refreshProjectNames();
      const scope = machineWide
        ? null
        : (scopes.get(threadId) ?? (await refreshThreadScope(threadId, false)));
      const inScope = (run: Run): boolean =>
        !scope || runMatchesScope(run, scope);

      const open = store.listUnresolved().filter(inScope);
      const recent = store.listRuns({ limit: limit ?? 5 }).filter(inScope);
      const header = scope
        ? `Scope: this thread's checkout ${scope.path}${scope.branch ? ` @${scope.branch}` : ""}.`
        : "Scope: whole machine (thread has no resolvable checkout).";
      const parts: string[] = [
        header,
        open.length
          ? `Active (${open.length}):\n${open.map(describeRun).join("\n")}`
          : "Nothing is building right now.",
      ];
      if (recent.length) {
        parts.push(`Recent:\n${recent.map(describeRun).join("\n")}`);
      } else if (scope) {
        parts.push(
          "No recorded runs for this checkout yet. Pass machineWide: true to see all Xcode activity.",
        );
      }
      const focus = open[0] ?? recent[0] ?? null;
      return parts.join("\n\n") + directiveHint(focus ? focus.id : null);
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
      machineWide: z
        .boolean()
        .optional()
        .describe("Ignore this thread's checkout scope and search all runs."),
    }),
    async execute({ projectId, machineWide }, { threadId }) {
      refreshProjectNames();
      const scope = machineWide
        ? null
        : (scopes.get(threadId) ?? (await refreshThreadScope(threadId, false)));
      const failed = store
        .listRuns({ projectId: projectId ?? null, onlyProblems: true, limit: 25 })
        .filter((run) => !scope || runMatchesScope(run, scope))[0];
      if (!failed) {
        return scope
          ? "No failed Xcode runs recorded for this thread's checkout. Pass machineWide: true to search all runs."
          : "No failed Xcode runs recorded.";
      }
      const detail = cliShow(failed.id);
      return (
        (detail.stdout ?? detail.stderr ?? "No detail available.") +
        directiveHint(failed.id)
      );
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
