/**
 * Retention is one policy, stated once.
 *
 * `retainLooks` (default 20) runs **per scope and per kind**, and
 * `diskBudgetMb` (default 2048) runs **across every scope** — checked *before*
 * a run writes as well as after, because a budget only enforced afterwards is
 * a budget that is always exceeded for the duration of the run that exceeds it.
 *
 * Per kind, not just per scope, because captures and preview runs are different
 * budgets: twenty captures should not evict the preview baseline you have been
 * comparing against all week.
 *
 * Eviction order: oldest unprotected first, then oldest baselined beyond the
 * newest per `(scope, device)`. Protected means baselined, pointed at by an
 * identity baseline, or linked to a thread — the three ways a person has said
 * "this one matters".
 *
 * **Pruning deletes frames, not looks.** The look row and its verdicts survive,
 * which costs almost nothing and is what lets the `::xcode-simulators`
 * directive render a tombstone that still says what it was rather than just
 * that something used to be there.
 */
import type { Db } from "./store.js";
import { checkpoint } from "./store.js";
import { allLooks, evictionCandidates, updateLook } from "./frames.js";
import type { FrameStore } from "./framestore.js";
import type { Look } from "./model.js";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export interface PrunePlan {
  /** Looks whose frames would be deleted, oldest first. */
  evict: Look[];
  bytesFreed: number;
  reason: "count" | "budget" | "both" | "nothing";
}

export interface PruneInput {
  db: Db;
  retainLooks: number;
  diskBudgetBytes: number;
  /** Extra bytes a run is about to write, when checking before rather than after. */
  incomingBytes?: number;
}

/**
 * Decide what to evict. Pure with respect to the filesystem, so the whole
 * policy is testable against a database and nothing else.
 */
export function planPrune(input: PruneInput): PrunePlan {
  const looks = allLooks(input.db).filter((look) => look.bytesTotal > 0);
  const evict: Look[] = [];
  const seen = new Set<string>();

  // ── by count, per scope and per kind ───────────────────────────────────
  const byGroup = new Map<string, Look[]>();
  for (const look of looks) {
    const key = `${look.scopeKey}|${look.kind}`;
    const group = byGroup.get(key) ?? [];
    group.push(look);
    byGroup.set(key, group);
  }
  const protectedIds = new Set(
    looks.map((look) => look.id).filter((id) => !isEvictable(input.db, id)),
  );
  for (const group of byGroup.values()) {
    // Newest first, so the ones kept are the ones you would look at.
    const ordered = [...group].sort((a, b) => b.startedAt - a.startedAt);
    let kept = 0;
    for (const look of ordered) {
      if (protectedIds.has(look.id)) continue;
      kept += 1;
      if (kept > input.retainLooks && !seen.has(look.id)) {
        seen.add(look.id);
        evict.push(look);
      }
    }
  }
  const byCount = evict.length;

  // ── by byte budget, across every scope ─────────────────────────────────
  let total =
    looks.reduce((sum, look) => sum + look.bytesTotal, 0) + (input.incomingBytes ?? 0);
  const freeing = evict.reduce((sum, look) => sum + look.bytesTotal, 0);
  total -= freeing;

  if (total > input.diskBudgetBytes) {
    const unprotected = evictionCandidates(input.db, null).filter((look) => !seen.has(look.id));
    for (const look of unprotected) {
      if (total <= input.diskBudgetBytes) break;
      if (look.bytesTotal === 0) continue;
      seen.add(look.id);
      evict.push(look);
      total -= look.bytesTotal;
    }
  }
  // There is deliberately no second tier. One existed on paper — "baselined
  // looks beyond the newest per (scope, device)" — but the baselines table's
  // primary key IS (scope_key, device_key), so that set is empty by schema
  // and the tier never evicted a byte in its life. The honest property is:
  // protected looks (baselines, thread links) are never evicted, and a budget
  // exceeded purely by protected looks stays exceeded until a person purges
  // or moves the baseline.

  const byBudget = evict.length - byCount;
  return {
    evict,
    bytesFreed: evict.reduce((sum, look) => sum + look.bytesTotal, 0),
    reason:
      byCount > 0 && byBudget > 0
        ? "both"
        : byCount > 0
          ? "count"
          : byBudget > 0
            ? "budget"
            : "nothing",
  };
}

/** Baselined, identity-baselined or thread-linked: the three ways to matter. */
function isEvictable(db: Db, lookId: string): boolean {
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM baselines WHERE look_id = ?) +
         (SELECT COUNT(*) FROM identity_baselines WHERE look_id = ?) +
         (SELECT COUNT(*) FROM thread_links WHERE look_id = ?) AS n`,
    )
    .get(lookId, lookId, lookId) as { n: number };
  return row.n === 0;
}

export interface PruneResult extends PrunePlan {
  removed: number;
}

export async function applyPrune(
  db: Db,
  store: FrameStore,
  plan: PrunePlan,
): Promise<PruneResult> {
  let removed = 0;
  for (const look of plan.evict) {
    await store.removeLook(look.scopeKey, look.id);
    // The look row and its verdicts stay: that is the tombstone the directive
    // renders. Only the pixels go.
    db.prepare(`DELETE FROM frames WHERE look_id = ?`).run(look.id);
    updateLook(db, look.id, { bytesTotal: 0 });
    removed += 1;
  }
  // 148 verdict rows per run times twenty runs times N projects is not nothing,
  // and the write-ahead log is ours to manage.
  if (removed > 0) checkpoint(db);
  return { ...plan, removed };
}

/**
 * serve-sim's own log files.
 *
 * Housekeeping rather than a leak fix: 0.1.45 serves helpers in-process and
 * writes only `server-<udid>.json` state files. This cleans up after an older
 * serve-sim a user may have run, and deleting week-old files from a directory
 * this plugin's own child populates is not a behaviour anyone needs to reason
 * about.
 */
export const SERVE_SIM_LOG_AGE_MS = 7 * 24 * 60 * 60_000;

export async function sweepServeSimLogs(tmpDir: string, now: number): Promise<number> {
  const { readdir, stat, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(tmpDir, "serve-sim");
  let swept = 0;
  try {
    for (const entry of await readdir(dir)) {
      if (!entry.endsWith(".log")) continue;
      const path = join(dir, entry);
      try {
        const info = await stat(path);
        if (now - info.mtimeMs < SERVE_SIM_LOG_AGE_MS) continue;
        await unlink(path);
        swept += 1;
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  } catch {
    // No directory means nothing to sweep.
  }
  return swept;
}

/** Remove the unbounded per-run result caches written by releases before this audit. */
export async function sweepLegacyStillsResults(dataDir: string): Promise<number> {
  const derived = join(dataDir, "derived");
  let scopes;
  try {
    scopes = await readdir(derived, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const scope of scopes) {
    if (!scope.isDirectory() || scope.isSymbolicLink()) continue;
    const results = join(derived, scope.name, "results");
    try {
      const info = await lstat(results);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      await rm(results, { recursive: true, force: true });
      removed += 1;
    } catch {
      // Missing or concurrently removed is already the desired state.
    }
  }
  return removed;
}

/** *"Xcode Simulators is using 1.4 GB across 6 projects."* */
export function describeUsage(bytes: number, scopes: number, format: (n: number) => string): string {
  if (scopes === 0) return "Xcode Simulators has not stored any frames yet.";
  return `Xcode Simulators is using ${format(bytes)} across ${scopes} ${scopes === 1 ? "project" : "projects"}.`;
}
