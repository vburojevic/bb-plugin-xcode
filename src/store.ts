/**
 * Persistence, v2.
 *
 * The MIGRATIONS array continues the v1 list — the host applies statements by
 * array index, so the first ten entries must remain byte-identical forever.
 * The v2 statements drop the v1 tables (correlation-era data is what the old
 * bugs left behind; a clean slate is a feature of this rewrite) and create the
 * new schema.
 */

import type { Finding, Rank, Run, RunKind, RunStatus, TestCase } from "./model";

export const MIGRATIONS: readonly string[] = [
  // ---- v1 (frozen; never edit) -------------------------------------------
  `CREATE TABLE IF NOT EXISTS derived_roots (
     root           TEXT PRIMARY KEY,
     host_id        TEXT,
     project_id     TEXT,
     discovered_via TEXT NOT NULL,
     first_seen_at  INTEGER NOT NULL,
     last_seen_at   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS runs (
     id              TEXT PRIMARY KEY,
     correlation_key TEXT NOT NULL,
     host_id         TEXT,
     project_id      TEXT,
     root            TEXT,
     kind            TEXT NOT NULL,
     scheme          TEXT,
     container       TEXT,
     configuration   TEXT,
     destination     TEXT,
     status          TEXT NOT NULL,
     started_at      INTEGER NOT NULL,
     ended_at        INTEGER,
     duration_ms     INTEGER,
     error_count     INTEGER NOT NULL DEFAULT 0,
     warning_count   INTEGER NOT NULL DEFAULT 0,
     analyzer_count  INTEGER NOT NULL DEFAULT 0,
     test_total      INTEGER,
     test_failed     INTEGER,
     test_skipped    INTEGER,
     pid             INTEGER,
     cmdline         TEXT,
     cwd             TEXT,
     xcresult_path   TEXT,
     manifest_uuid   TEXT,
     source          TEXT NOT NULL,
     enriched        INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS runs_correlation_idx ON runs (correlation_key)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS runs_manifest_idx
     ON runs (manifest_uuid) WHERE manifest_uuid IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS issues (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id    TEXT NOT NULL,
     severity  TEXT NOT NULL,
     message   TEXT NOT NULL,
     file_path TEXT,
     line      INTEGER,
     col       INTEGER,
     target    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS issues_run_idx ON issues (run_id)`,
  `CREATE TABLE IF NOT EXISTS tests (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id          TEXT NOT NULL,
     suite           TEXT,
     name            TEXT NOT NULL,
     identifier      TEXT,
     status          TEXT NOT NULL,
     duration_ms     INTEGER,
     failure_message TEXT,
     target          TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS tests_run_idx ON tests (run_id)`,
  `CREATE INDEX IF NOT EXISTS tests_name_idx ON tests (name, status)`,
  // ---- v2 ----------------------------------------------------------------
  `DROP TABLE IF EXISTS runs`,
  `DROP TABLE IF EXISTS issues`,
  `DROP TABLE IF EXISTS tests`,
  `DROP TABLE IF EXISTS derived_roots`,
  `CREATE TABLE IF NOT EXISTS run (
     id             TEXT PRIMARY KEY,
     status         TEXT NOT NULL,
     status_rank    INTEGER NOT NULL DEFAULT 0,
     kind           TEXT NOT NULL,
     scheme         TEXT,
     container      TEXT,
     configuration  TEXT,
     destination    TEXT,
     project_id     TEXT,
     root           TEXT,
     cwd            TEXT,
     pid            INTEGER,
     cmdline        TEXT,
     started_at     INTEGER NOT NULL,
     ended_at       INTEGER,
     error_count    INTEGER NOT NULL DEFAULT 0,
     warning_count  INTEGER NOT NULL DEFAULT 0,
     analyzer_count INTEGER NOT NULL DEFAULT 0,
     test_total     INTEGER,
     test_failed    INTEGER,
     test_skipped   INTEGER,
     bundle_path    TEXT,
     detailed       INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS run_started_idx ON run (started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS run_status_idx ON run (status)`,
  `CREATE TABLE IF NOT EXISTS finding (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id    TEXT NOT NULL,
     severity  TEXT NOT NULL,
     message   TEXT NOT NULL,
     file_path TEXT,
     line      INTEGER,
     target    TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS finding_run_idx ON finding (run_id)`,
  `CREATE TABLE IF NOT EXISTS test_case (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id          TEXT NOT NULL,
     suite           TEXT,
     name            TEXT NOT NULL,
     status          TEXT NOT NULL,
     duration_ms     INTEGER,
     failure_message TEXT,
     target          TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS test_case_run_idx ON test_case (run_id)`,
  `CREATE INDEX IF NOT EXISTS test_case_name_idx ON test_case (name, status)`,
  `CREATE TABLE IF NOT EXISTS root (
     path           TEXT PRIMARY KEY,
     project_id     TEXT,
     discovered_via TEXT NOT NULL,
     first_seen_at  INTEGER NOT NULL,
     last_seen_at   INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seen_artifact (
     key     TEXT PRIMARY KEY,
     seen_at INTEGER NOT NULL
   )`,
  `ALTER TABLE run ADD COLUMN branch TEXT`,
  `ALTER TABLE run ADD COLUMN worktree TEXT`,
  `ALTER TABLE run ADD COLUMN thread_id TEXT`,
  `CREATE INDEX IF NOT EXISTS run_thread_idx ON run (thread_id) WHERE thread_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS run_typical_idx ON run (root, scheme, kind, started_at DESC)`,
];

/** Minimal structural type for the better-sqlite3 handle the host provides. */
export interface Db {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

interface RunRowRaw {
  id: string;
  status: RunStatus;
  status_rank: Rank;
  kind: RunKind;
  scheme: string | null;
  container: string | null;
  configuration: string | null;
  destination: string | null;
  project_id: string | null;
  root: string | null;
  cwd: string | null;
  pid: number | null;
  cmdline: string | null;
  started_at: number;
  ended_at: number | null;
  error_count: number;
  warning_count: number;
  analyzer_count: number;
  test_total: number | null;
  test_failed: number | null;
  test_skipped: number | null;
  bundle_path: string | null;
  detailed: number;
  branch: string | null;
  worktree: string | null;
  thread_id: string | null;
}

function toRun(raw: RunRowRaw): Run {
  return {
    id: raw.id,
    status: raw.status,
    statusRank: raw.status_rank,
    kind: raw.kind,
    scheme: raw.scheme,
    container: raw.container,
    configuration: raw.configuration,
    destination: raw.destination,
    projectId: raw.project_id,
    root: raw.root,
    cwd: raw.cwd,
    pid: raw.pid,
    cmdline: raw.cmdline,
    startedAt: raw.started_at,
    endedAt: raw.ended_at,
    errorCount: raw.error_count,
    warningCount: raw.warning_count,
    analyzerCount: raw.analyzer_count,
    testTotal: raw.test_total,
    testFailed: raw.test_failed,
    testSkipped: raw.test_skipped,
    bundlePath: raw.bundle_path,
    detailed: raw.detailed === 1,
    branch: raw.branch,
    worktree: raw.worktree,
    threadId: raw.thread_id,
  };
}

/** All reads and writes go through this class; the engine is its only writer. */
export class Store {
  constructor(private readonly db: Db) {}

  insertRun(run: Run): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO run (
           id, status, status_rank, kind, scheme, container, configuration,
           destination, project_id, root, cwd, pid, cmdline, started_at,
           ended_at, error_count, warning_count, analyzer_count, test_total,
           test_failed, test_skipped, bundle_path, detailed, branch, worktree,
           thread_id
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.id,
        run.status,
        run.statusRank,
        run.kind,
        run.scheme,
        run.container,
        run.configuration,
        run.destination,
        run.projectId,
        run.root,
        run.cwd,
        run.pid,
        run.cmdline,
        run.startedAt,
        run.endedAt,
        run.errorCount,
        run.warningCount,
        run.analyzerCount,
        run.testTotal,
        run.testFailed,
        run.testSkipped,
        run.bundlePath,
        run.detailed ? 1 : 0,
        run.branch,
        run.worktree,
        run.threadId,
      );
  }

  getRun(id: string): Run | null {
    const raw = this.db.prepare(`SELECT * FROM run WHERE id = ?`).get(id) as
      | RunRowRaw
      | undefined;
    return raw ? toRun(raw) : null;
  }

  updateRun(run: Run): void {
    this.db
      .prepare(
        `UPDATE run SET
           status = ?, status_rank = ?, kind = ?, scheme = ?, container = ?,
           configuration = ?, destination = ?, project_id = ?, root = ?,
           cwd = ?, cmdline = ?, started_at = ?, ended_at = ?, error_count = ?,
           warning_count = ?, analyzer_count = ?, test_total = ?,
           test_failed = ?, test_skipped = ?, bundle_path = ?, detailed = ?,
           branch = COALESCE(?, branch), worktree = COALESCE(?, worktree),
           thread_id = COALESCE(?, thread_id)
         WHERE id = ?`,
      )
      .run(
        run.status,
        run.statusRank,
        run.kind,
        run.scheme,
        run.container,
        run.configuration,
        run.destination,
        run.projectId,
        run.root,
        run.cwd,
        run.cmdline,
        run.startedAt,
        run.endedAt,
        run.errorCount,
        run.warningCount,
        run.analyzerCount,
        run.testTotal,
        run.testFailed,
        run.testSkipped,
        run.bundlePath,
        run.detailed ? 1 : 0,
        run.branch,
        run.worktree,
        run.threadId,
        run.id,
      );
  }

  /**
   * Backfill thread attribution for runs already recorded under a scope's
   * path — a build the probe saw before the thread's scope was registered
   * (the thread.active resolution races the first probe tick).
   */
  attributeRunsToThread(threadId: string, path: string, since: number): number {
    const base = path.endsWith("/") ? path.slice(0, -1) : path;
    if (!base) return 0;
    const prefix = `${base}/%`;
    const result = this.db
      .prepare(
        `UPDATE run SET thread_id = ?
          WHERE thread_id IS NULL AND started_at >= ?
            AND (cwd = ? OR cwd LIKE ? OR container = ? OR container LIKE ?)`,
      )
      .run(threadId, since, base, prefix, base, prefix) as { changes?: number };
    return result?.changes ?? 0;
  }

  listRuns(query: {
    projectId?: string | null;
    kind?: RunKind | null;
    onlyProblems?: boolean;
    includeNoise?: boolean;
    limit?: number;
    offset?: number;
  }): Run[] {
    const where: string[] = [];
    const params: unknown[] = [];
    // Package resolves and index builds are real activity but not what anyone
    // opens this panel for; they drowned the list (8 of 25 visible rows on a
    // real day). Hidden unless asked for explicitly via the kind filter.
    if (!query.kind && !query.includeNoise) {
      where.push("kind NOT IN ('package','index')");
    }
    if (query.projectId) {
      where.push("project_id = ?");
      params.push(query.projectId);
    }
    if (query.kind) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.onlyProblems) {
      where.push("(status = 'failed' OR error_count > 0 OR test_failed > 0)");
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM run ${clause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as RunRowRaw[];
    return rows.map(toRun);
  }

  /**
   * How long this kind of run usually takes in this checkout.
   *
   * The median of recent SUCCESSFUL runs of the same scheme and kind — median
   * rather than mean because one 20-minute cold build after a clean would drag
   * a mean far off every warm build that follows. Only successes count: a build
   * that failed in 8 seconds says nothing about how long a real one takes, and
   * a cancelled one says less.
   *
   * This is what makes a determinate progress bar possible at all. llbuild's
   * own task ledger would be exact, but it stays inside one open transaction
   * for the whole build, so elapsed-against-typical is the honest alternative.
   */
  typicalDurationMs(query: {
    root: string | null;
    scheme: string | null;
    kind: RunKind;
  }): number | null {
    if (!query.root || !query.scheme) return null;
    const rows = this.db
      .prepare(
        `SELECT (ended_at - started_at) AS ms FROM run
          WHERE root = ? AND scheme = ? AND kind = ?
            AND ended_at IS NOT NULL
            AND status IN ('passed', 'warnings')
          ORDER BY started_at DESC LIMIT 20`,
      )
      .all(query.root, query.scheme, query.kind) as Array<{ ms: number }>;

    const samples = rows
      .map((row) => row.ms)
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .sort((a, b) => a - b);
    // Two samples is the least that can be called "usual"; one is an anecdote.
    if (samples.length < 2) return null;
    const mid = Math.floor(samples.length / 2);
    return samples.length % 2 === 0
      ? Math.round((samples[mid - 1]! + samples[mid]!) / 2)
      : samples[mid]!;
  }

  countRuns(query: { projectId?: string | null; kind?: RunKind | null }): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!query.kind) where.push("kind NOT IN ('package','index')");
    if (query.projectId) {
      where.push("project_id = ?");
      params.push(query.projectId);
    }
    if (query.kind) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM run ${clause}`)
      .get(...params) as { n: number };
    return row?.n ?? 0;
  }

  listUnresolved(): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM run WHERE status IN ('running','finishing')
          ORDER BY started_at DESC`,
      )
      .all() as RunRowRaw[];
    return rows.map(toRun);
  }

  /**
   * Runs an outcome artifact (manifest entry, bundle) might belong to: window
   * overlap, eligible kind, and no *verified* verdict yet.
   *
   * Deliberately NOT filtered on `bundle_path IS NULL`: a shim-wrapped run has
   * its bundle path from argv the moment it starts, and excluding it here made
   * the log-store entry spawn a duplicate standalone row (measured live).
   * The rank lattice already guards against a lower-rank source overwriting a
   * verified verdict; the filter's only job is candidacy, not protection.
   */
  findVerdictCandidates(aroundMs: number, slackMs: number): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM run
          WHERE status_rank < 2
            AND kind NOT IN ('index','package')
            AND started_at <= ?
            AND COALESCE(ended_at, started_at + ?) >= ?
          ORDER BY started_at DESC LIMIT 20`,
      )
      .all(aroundMs + slackMs, slackMs, aroundMs - slackMs) as RunRowRaw[];
    return rows.map(toRun);
  }

  replaceFindings(runId: string, findings: Finding[]): void {
    this.db.prepare(`DELETE FROM finding WHERE run_id = ?`).run(runId);
    const insert = this.db.prepare(
      `INSERT INTO finding (run_id, severity, message, file_path, line, target)
       VALUES (?,?,?,?,?,?)`,
    );
    for (const finding of findings) {
      insert.run(
        runId,
        finding.severity,
        finding.message,
        finding.filePath,
        finding.line,
        finding.target,
      );
    }
  }

  listFindings(runId: string): Finding[] {
    return this.db
      .prepare(
        `SELECT run_id, severity, message, file_path, line, target
           FROM finding WHERE run_id = ?
          ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                   file_path, line`,
      )
      .all(runId)
      .map((raw) => {
        const row = raw as {
          run_id: string;
          severity: Finding["severity"];
          message: string;
          file_path: string | null;
          line: number | null;
          target: string | null;
        };
        return {
          runId: row.run_id,
          severity: row.severity,
          message: row.message,
          filePath: row.file_path,
          line: row.line,
          target: row.target,
        };
      });
  }

  replaceTests(runId: string, tests: TestCase[]): void {
    this.db.prepare(`DELETE FROM test_case WHERE run_id = ?`).run(runId);
    const insert = this.db.prepare(
      `INSERT INTO test_case (run_id, suite, name, status, duration_ms, failure_message, target)
       VALUES (?,?,?,?,?,?,?)`,
    );
    for (const test of tests) {
      insert.run(
        runId,
        test.suite,
        test.name,
        test.status,
        test.durationMs,
        test.failureMessage,
        test.target,
      );
    }
  }

  listTests(runId: string): TestCase[] {
    return this.db
      .prepare(
        `SELECT run_id, suite, name, status, duration_ms, failure_message, target
           FROM test_case WHERE run_id = ?
          ORDER BY CASE status WHEN 'failed' THEN 0 ELSE 1 END, suite, name`,
      )
      .all(runId)
      .map((raw) => {
        const row = raw as {
          run_id: string;
          suite: string | null;
          name: string;
          status: TestCase["status"];
          duration_ms: number | null;
          failure_message: string | null;
          target: string | null;
        };
        return {
          runId: row.run_id,
          suite: row.suite,
          name: row.name,
          status: row.status,
          durationMs: row.duration_ms,
          failureMessage: row.failure_message,
          target: row.target,
        };
      });
  }

  upsertRoot(
    path: string,
    projectId: string | null,
    via: string,
    now: number,
  ): boolean {
    const existed = this.db
      .prepare(`SELECT 1 FROM root WHERE path = ?`)
      .get(path);
    this.db
      .prepare(
        `INSERT INTO root (path, project_id, discovered_via, first_seen_at, last_seen_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(path) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           project_id = COALESCE(root.project_id, excluded.project_id)`,
      )
      .run(path, projectId, via, now, now);
    return !existed;
  }

  listRoots(): Array<{
    path: string;
    projectId: string | null;
    discoveredVia: string;
    firstSeenAt: number;
    lastSeenAt: number;
  }> {
    return this.db
      .prepare(`SELECT * FROM root ORDER BY last_seen_at DESC`)
      .all()
      .map((raw) => {
        const row = raw as {
          path: string;
          project_id: string | null;
          discovered_via: string;
          first_seen_at: number;
          last_seen_at: number;
        };
        return {
          path: row.path,
          projectId: row.project_id,
          discoveredVia: row.discovered_via,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
        };
      });
  }

  /**
   * Idempotence ledger for external artifacts (manifest entries, bundles).
   * A key is recorded once; folding the same artifact twice is a no-op.
   */
  /** Forget artifacts recorded since `since`, so a sweep reconsiders them. */
  clearSeenSince(prefix: string, since: number): number {
    const result = this.db
      .prepare(`DELETE FROM seen_artifact WHERE key LIKE ? AND seen_at >= ?`)
      .run(`${prefix}%`, since) as { changes?: number };
    return result?.changes ?? 0;
  }

  markSeen(key: string, now: number): boolean {
    const existed = this.db
      .prepare(`SELECT 1 FROM seen_artifact WHERE key = ?`)
      .get(key);
    if (existed) return false;
    this.db
      .prepare(`INSERT INTO seen_artifact (key, seen_at) VALUES (?, ?)`)
      .run(key, now);
    return true;
  }

  clearSeen(key: string): void {
    this.db.prepare(`DELETE FROM seen_artifact WHERE key = ?`).run(key);
  }

  /**
   * Peek without consuming.
   *
   * `markSeen` conflates "have we handled this?" with "we are handling it
   * now", which is only safe when the caller is certain it can act. The
   * manifest fold is not — it may arrive before the run it describes has left
   * `running` — so it looks with this, declines, and comes back.
   */
  hasSeen(key: string): boolean {
    return Boolean(
      this.db.prepare(`SELECT 1 FROM seen_artifact WHERE key = ?`).get(key),
    );
  }

  prune(cutoff: number): number {
    this.db
      .prepare(
        `DELETE FROM finding WHERE run_id IN (SELECT id FROM run WHERE started_at < ?)`,
      )
      .run(cutoff);
    this.db
      .prepare(
        `DELETE FROM test_case WHERE run_id IN (SELECT id FROM run WHERE started_at < ?)`,
      )
      .run(cutoff);
    this.db.prepare(`DELETE FROM seen_artifact WHERE seen_at < ?`).run(cutoff);
    const result = this.db
      .prepare(`DELETE FROM run WHERE started_at < ?`)
      .run(cutoff) as { changes?: number };
    return result?.changes ?? 0;
  }

  /**
   * Delete finding/test_case rows whose run no longer exists. `prune` deletes
   * children of runs it is about to delete, but rows orphaned by any other
   * path (crashes mid-write, pre-fix data) accumulated forever — measured at
   * 16k child rows against 404 runs.
   */
  pruneOrphans(): number {
    const findings = this.db
      .prepare(`DELETE FROM finding WHERE run_id NOT IN (SELECT id FROM run)`)
      .run() as { changes?: number };
    const tests = this.db
      .prepare(`DELETE FROM test_case WHERE run_id NOT IN (SELECT id FROM run)`)
      .run() as { changes?: number };
    return (findings?.changes ?? 0) + (tests?.changes ?? 0);
  }

  trends(projectId: string | null, sinceMs: number): {
    durations: Array<{
      at: number;
      durationMs: number;
      status: RunStatus;
      scheme: string | null;
      kind: RunKind;
    }>;
    daily: Array<{
      day: string;
      total: number;
      failed: number;
      passed: number;
      avgDurationMs: number | null;
    }>;
    flakyTests: Array<{
      name: string;
      suite: string | null;
      failures: number;
      runs: number;
    }>;
  } {
    const projectClause = projectId ? "AND project_id = ?" : "";
    const params: unknown[] = projectId ? [sinceMs, projectId] : [sinceMs];

    const durations = (
      this.db
        .prepare(
          `SELECT started_at, ended_at, status, scheme, kind FROM run
            WHERE started_at >= ? ${projectClause}
              AND ended_at IS NOT NULL AND status NOT IN ('running','finishing')
            ORDER BY started_at ASC LIMIT 500`,
        )
        .all(...params) as Array<{
        started_at: number;
        ended_at: number;
        status: RunStatus;
        scheme: string | null;
        kind: RunKind;
      }>
    ).map((row) => ({
      at: row.started_at,
      durationMs: Math.max(0, row.ended_at - row.started_at),
      status: row.status,
      scheme: row.scheme,
      kind: row.kind,
    }));

    const daily = (
      this.db
        .prepare(
          `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
                  COUNT(*) AS total,
                  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                  SUM(CASE WHEN status IN ('passed','warnings') THEN 1 ELSE 0 END) AS passed,
                  AVG(CASE WHEN ended_at IS NOT NULL THEN ended_at - started_at END) AS avg_duration
             FROM run
            WHERE started_at >= ? ${projectClause}
              AND status NOT IN ('running','finishing')
            GROUP BY day ORDER BY day ASC`,
        )
        .all(...params) as Array<{
        day: string;
        total: number;
        failed: number;
        passed: number;
        avg_duration: number | null;
      }>
    ).map((row) => ({
      day: row.day,
      total: row.total,
      failed: row.failed,
      passed: row.passed,
      avgDurationMs: row.avg_duration === null ? null : Math.round(row.avg_duration),
    }));

    const flakyTests = this.db
      .prepare(
        `SELECT t.name AS name, t.suite AS suite,
                SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failures,
                COUNT(*) AS runs
           FROM test_case t JOIN run r ON r.id = t.run_id
          WHERE r.started_at >= ? ${projectId ? "AND r.project_id = ?" : ""}
          GROUP BY t.name, t.suite
         HAVING failures > 0 AND runs > failures
          ORDER BY failures DESC LIMIT 20`,
      )
      .all(...params) as Array<{
      name: string;
      suite: string | null;
      failures: number;
      runs: number;
    }>;

    return { durations, daily, flakyTests };
  }
}
