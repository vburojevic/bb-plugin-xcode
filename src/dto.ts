/**
 * Run → wire shape.
 *
 * Every surface reads runs through this one mapper, so the panel, the banner
 * and the agent tools cannot disagree about what a run is. It lives outside
 * `server.ts` because it is the shape of the plugin's API, not its wiring.
 */

import type { Collector } from "./collector";
import { destinationLabel } from "./destination";
import type { Engine } from "./engine";
import { durationMs, type Run } from "./model";
import type { Store } from "./store";
import type { BuildPhase } from "./types";

export interface RunDto {
  id: string;
  status: Run["status"];
  kind: Run["kind"];
  scheme: string | null;
  container: string | null;
  configuration: string | null;
  destination: string | null;
  projectId: string | null;
  projectName: string | null;
  root: string | null;
  cwd: string | null;
  pid: number | null;
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
  branch: string | null;
  worktree: string | null;
  threadId: string | null;
  destinationLabel: string | null;
  workerCount: number | null;
  // The union lives in `types.ts` and nowhere else. Spelling it out here meant
  // adding a phase compiled everywhere except the one place that carries it.
  phase: BuildPhase | null;
  currentFile: string | null;
  typicalMs: number | null;
}

/**
 * Memo TTL for `typicalDurationMs`.
 *
 * `overview` maps up to 100 runs and each one cost a SQL aggregate; distinct
 * (root, scheme, kind) triples number a handful, so this turns ~100 queries
 * per call into ~5. A run's median moves on the timescale of builds, not of
 * repaints, so ten seconds of staleness is invisible.
 */
const TYPICAL_TTL_MS = 10_000;
const TYPICAL_MAX_ENTRIES = 500;

export class DtoMapper {
  private readonly typicalMemo = new Map<
    string,
    { at: number; value: number | null }
  >();
  private readonly projectNames = new Map<string, string>();

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
    private readonly collector: Collector,
  ) {}

  /** Re-read the collector's project list. Cheap; call before a batch. */
  refreshProjectNames(): void {
    this.projectNames.clear();
    for (const project of this.collector.getProjects()) {
      this.projectNames.set(project.id, project.name);
    }
  }

  projectName(id: string): string | null {
    return this.projectNames.get(id) ?? null;
  }

  private typicalFor(run: Run): number | null {
    const key = `${run.root}|${run.scheme}|${run.kind}`;
    const now = Date.now();
    const hit = this.typicalMemo.get(key);
    if (hit && now - hit.at < TYPICAL_TTL_MS) return hit.value;
    const value = this.store.typicalDurationMs({
      root: run.root,
      scheme: run.scheme,
      kind: run.kind,
    });
    if (this.typicalMemo.size > TYPICAL_MAX_ENTRIES) this.typicalMemo.clear();
    this.typicalMemo.set(key, { at: now, value });
    return value;
  }

  toDto(run: Run): RunDto {
    // One lookup, not three. `liveActivity` scans the engine's live map and
    // then the activity array, and this asked it the same question once for
    // the worker count, once for the phase and once for the current file.
    const activity =
      run.status === "running"
        ? this.engine.liveActivity(run.id, this.collector.getLastActivities())
        : null;

    return {
      id: run.id,
      status: run.status,
      kind: run.kind,
      scheme: run.scheme,
      container: run.container,
      configuration: run.configuration,
      destination: run.destination,
      projectId: run.projectId,
      projectName: run.projectId ? this.projectName(run.projectId) : null,
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
      destinationLabel: destinationLabel(
        run.destination,
        this.collector.getSimulators(),
      ),
      workerCount: activity?.workerCount ?? null,
      // Through the engine, not straight off the snapshot: `preparing` is only
      // true on the way in. See `Engine.livePhase`.
      phase: this.engine.livePhase(run.id, activity),
      currentFile: activity?.currentFile ?? null,
      // What a run of this shape usually costs here, so the row can show a
      // real fraction instead of an indeterminate sweep. Null until there are
      // enough successful samples to call anything "usual".
      typicalMs: this.typicalFor(run),
    };
  }
}
