/**
 * The RPC surface the panel and the composer banner read.
 *
 * Three questions, and they are not the same question:
 *
 *  - `overview` is machine-wide history, for the nav panel;
 *  - `chatStatus` is ONE THREAD's activity, for the banner above its composer;
 *  - `runDetail` / `trends` are drill-downs on the first.
 *
 * The distinction is load-bearing. A thread-scoped surface that quietly widens
 * to the whole machine shows somebody else's build as your result, which is the
 * one error this plugin treats as unrecoverable.
 */

import type { Collector } from "./collector";
import type { DtoMapper, RunDto } from "./dto";
import {
  isEphemeralRun,
  isNoiseRun,
  VERDICT_STATUSES,
  type Run,
} from "./model";
import { shortName } from "./present";
import type { ScopeSync } from "./scope-sync";
import { scopeFilter } from "./scopes";
import { shimPaths } from "./shim";
import type { Store } from "./store";

/**
 * Findings and failed tests returned to the activity card.
 *
 * Ten was a card-sized number back when this fed a two-line summary; the
 * disclosure is a scrollable panel and a broken build routinely has more than
 * ten errors, where seeing only the first ten is actively misleading about the
 * scale of the breakage.
 */
const FINDING_LIMIT = 40;

/**
 * Settled runs read per `chatStatus`, before slicing.
 *
 * Scoped in SQL, so twenty of the thread's OWN runs — not twenty of the
 * machine's, of which a given thread may own none.
 */
const SCOPED_HISTORY = 20;

export interface RpcDeps {
  store: Store;
  collector: Collector;
  dto: DtoMapper;
  scopeSync: ScopeSync;
  dataDir: string;
  dismissedRuns: Set<string>;
  persistDismissedRuns(): Promise<void>;
  shimInstalledCached(): boolean;
  rescan(): void;
  publishSoon(): void;
  detach(work: () => Promise<unknown>): void;
}

export function createRpcHandlers(deps: RpcDeps) {
  const { store, dto } = deps;

  const findingDto = (finding: {
    severity: "error" | "warning" | "analyzer";
    message: string;
    filePath: string | null;
    line: number | null;
    target: string | null;
  }) => ({
    severity: finding.severity,
    message: finding.message,
    filePath: finding.filePath,
    line: finding.line,
    target: finding.target,
  });

  const testDto = (test: {
    suite: string | null;
    name: string;
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
  }) => ({
    suite: test.suite,
    name: test.name,
    status: test.status,
    durationMs: test.durationMs,
    failureMessage: test.failureMessage,
    target: test.target,
  });

  return {
    overview(input: {
      projectId?: string | null;
      kind?: Run["kind"] | null;
      limit?: number;
    }) {
      dto.refreshProjectNames();
      const query = {
        projectId: input.projectId ?? null,
        kind: input.kind ?? null,
        limit: input.limit ?? 100,
      };
      const unique = new Map<
        string,
        { id: string; name: string; path: string }
      >();
      for (const project of deps.collector.getProjects()) {
        if (!unique.has(project.id)) unique.set(project.id, project);
      }
      const shim = shimPaths(deps.dataDir);
      const installed = deps.shimInstalledCached();
      const runs = store.listRuns(query);
      return {
        runs: runs.map((run) => dto.toDto(run)),
        total: store.countRuns(query),
        projects: [...unique.values()],
        rootCount: store.listRoots().length,
        lastScanAt: deps.collector.getLastScanAt(),
        // Sync cache only. Awaiting the resolve here spawned a cold `xcrun
        // --find` inside the RPC handler — the measured 1.69s overview right
        // after a reload. Optimistic `true` until the detached resolve lands
        // (it publishes, so the panel refetches the real answer).
        xcodeAvailable: deps.collector.xcodeAvailableSync() ?? true,
        shimInstalled: installed,
        shimActive: installed && (process.env.PATH ?? "").includes(shim.binDir),
        // What the shim would fix, counted rather than asserted: a nudge that
        // names a real number of the user's own runs is a fact; one that does
        // not is an advert.
        verdictlessRuns: runs.filter(
          (run) =>
            run.status === "ended" && !isNoiseRun(run) && !isEphemeralRun(run),
        ).length,
        simulators: deps.collector.getBootedSimulators(),
      };
    },

    runDetail({ id }: { id: string }) {
      dto.refreshProjectNames();
      const run = store.getRun(id);
      return {
        run: run ? dto.toDto(run) : null,
        findings: store.listFindings(id).map(findingDto),
        tests: store.listTests(id).map(testDto),
      };
    },

    trends(input: { projectId?: string | null; days?: number }) {
      const since = Date.now() - (input.days ?? 30) * 86_400_000;
      return store.trends(input.projectId ?? null, since);
    },

    chatStatus({
      threadId,
      runId,
    }: {
      threadId?: string | null;
      runId?: string | null;
    }) {
      dto.refreshProjectNames();

      let scope = null;
      if (threadId) {
        // Cached only — a scope miss used to cost two inline bb.sdk calls per
        // chatStatus, and the UI polls this endpoint. The detached refresh
        // publishes when the scope resolves, which makes the panel re-ask.
        scope = deps.scopeSync.get(threadId);
        if (!scope) deps.detach(() => deps.scopeSync.refresh(threadId, false));
      }
      const scopeDto = scope
        ? {
            threadId: scope.threadId,
            path: scope.path,
            branch: scope.branch,
            worktree: shortName(scope.path),
          }
        : null;
      // Thread-scoped, never machine-wide: an unresolved checkout must show
      // nothing rather than another thread's build. See `scopeFilter`.
      const inScope = scopeFilter<Run>(scope);

      const unresolved = store.listUnresolved().filter(inScope);
      // Scoped in SQL. Filtering a machine-wide LIMIT 100 afterwards meant a
      // thread whose newest run sat outside that window got an empty banner —
      // the plugin's central question, answered with silence.
      const settled = scope
        ? store
            .listRuns({ limit: SCOPED_HISTORY, scope })
            .filter(
              (run) => run.status !== "running" && run.status !== "finishing",
            )
        : [];
      const finished = settled.slice(0, 5);
      /**
       * The newest run that actually CONCLUDED something.
       *
       * `ended` is the verdict-less terminal state — the run started, it
       * stopped, and no source ever said how it went. Showing that as the
       * thread's last result puts "— no result" in the prompt stack, which
       * tells nobody anything and reads like a failure. Skipping to the last
       * run we can actually speak for is strictly more informative, and if
       * there is none the card simply stays away.
       *
       * Only ever the NEWEST settled run, and null once dismissed. Walking
       * back to the one before would answer a question nobody asked: a run
       * older than the one you just cleared is, by definition, staler news.
       */
      const newest =
        settled.find(
          (run) =>
            !isNoiseRun(run) &&
            // A finished package resolve is never "how the last thing went".
            !isEphemeralRun(run) &&
            VERDICT_STATUSES.has(run.status),
        ) ?? null;
      const lastSettled =
        newest && !deps.dismissedRuns.has(newest.id) ? newest : null;

      const pinned = runId ? store.getRun(runId) : null;
      const run = pinned ?? unresolved[0] ?? finished[0] ?? null;

      const problems =
        run !== null &&
        (run.status === "failed" ||
          run.errorCount > 0 ||
          (run.testFailed ?? 0) > 0);

      const dtoOf = (entry: Run): RunDto => dto.toDto(entry);
      return {
        run: run ? dtoOf(run) : null,
        active: unresolved.filter((entry) => entry.id !== run?.id).map(dtoOf),
        recent: finished.filter((entry) => entry.id !== run?.id).map(dtoOf),
        lastSettled: lastSettled ? dtoOf(lastSettled) : null,
        scope: scopeDto,
        findings:
          problems && run
            ? store
                .listFindings(run.id)
                .filter((finding) => finding.severity === "error")
                .slice(0, FINDING_LIMIT)
                .map(findingDto)
            : [],
        recordedSnapshots: run
          ? store.countTestsByStatus(run.id, "recorded")
          : 0,
        failedTests:
          problems && run
            ? store
                .listTests(run.id)
                .filter((test) => test.status === "failed")
                .slice(0, FINDING_LIMIT)
                .map(testDto)
            : [],
      };
    },

    async dismissRun({ runId }: { runId: string }) {
      deps.dismissedRuns.add(runId);
      await deps.persistDismissedRuns();
      deps.publishSoon();
      return { ok: true };
    },

    async rescan() {
      // Detached: a full sweep can spawn xcresulttool with a 60s timeout per
      // bundle plus a sync JSON.parse of tens of MB — far too slow to hold an
      // RPC handler (and the shared event loop) open for.
      deps.rescan();
      return { ok: true, rootCount: store.listRoots().length };
    },
  };
}
