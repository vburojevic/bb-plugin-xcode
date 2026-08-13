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
import { MIGRATIONS as SIMULATOR_MIGRATIONS } from "./sim/store";

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
  /**
   * Bundle path is an identity, so look runs up by it.
   *
   * Three call sites used to answer "which run owns this bundle?" by scanning
   * the newest 50-100 runs and comparing in JS. A build that outlives that
   * window — a long test suite on a machine where agents are also building —
   * fell out of it, and then: the wrapped exit's verdict was dropped, the
   * bundle fold lost its by-path preference, and the sweep no longer knew the
   * bundle's producer was still `running`, so it parsed a half-written bundle
   * and spent its corrupt-bundle retry budget on it.
   */
  `CREATE INDEX IF NOT EXISTS run_bundle_idx ON run (bundle_path) WHERE bundle_path IS NOT NULL`,

  // ---- Simulators (frozen from here down) ---------------------------------
  // Spliced in, never interleaved. `bb.storage.migrate` applies statements by
  // index across the whole plugin, so the Simulators half cannot own its own
  // array — its statements live in `src/sim/store.ts` for readability and are
  // appended here, after everything above, permanently.
  ...SIMULATOR_MIGRATIONS,
];

/**
 * Escape a value for use as a LIKE prefix pattern.
 *
 * `_` is a single-character wildcard in SQL LIKE, and it is an ordinary and
 * common character in a checkout path (`env_q29t…`, `my_project`). Without
 * escaping, scoping a thread to `/w/my_project` also matched `/w/myXproject`.
 */
export function likePrefix(base: string): string {
  return `${base.replace(/[\\%_]/g, (char) => `\\${char}`)}/%`;
}

/** A compiled statement, as better-sqlite3 hands them back. */
export interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Minimal structural type for the better-sqlite3 handle the host provides. */
export interface Db {
  prepare(sql: string): Statement;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

/**
 * A run's scope: the thread that owns a checkout, and the checkout itself.
 *
 * Mirrors `runMatchesScope` in `scopes.ts` — deliberately, because the two must
 * agree. This is the SQL half, used to filter BEFORE the limit; that one is the
 * in-memory half, used on collections we already hold.
 */
export interface RunScope {
  threadId: string;
  path: string;
  branch: string | null;
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
  /**
   * Compiled statements, keyed by their SQL text.
   *
   * better-sqlite3 compiles on every `prepare` — it keeps no cache of its own.
   * This class prepared inside each method, so the hot paths recompiled their
   * SQL on every call: `hasSeen`/`markSeen` once per manifest entry and once
   * per bundle candidate on every sweep, `getRun`/`updateRun` once per fold,
   * `listUnresolved` twice per probe tick. Keying on the text means the
   * dynamically-built queries below cache per *shape*, of which there are a
   * handful.
   */
  private readonly compiled = new Map<string, Statement>();

  constructor(private readonly db: Db) {}

  private sql(text: string): Statement {
    let statement = this.compiled.get(text);
    if (!statement) {
      statement = this.db.prepare(text);
      this.compiled.set(text, statement);
    }
    return statement;
  }

  insertRun(run: Run): void {
    this.sql(
      `INSERT OR IGNORE INTO run (
         id, status, status_rank, kind, scheme, container, configuration,
         destination, project_id, root, cwd, pid, cmdline, started_at,
         ended_at, error_count, warning_count, analyzer_count, test_total,
         test_failed, test_skipped, bundle_path, detailed, branch, worktree,
         thread_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
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
    const raw = this.sql(`SELECT * FROM run WHERE id = ?`).get(id) as
      | RunRowRaw
      | undefined;
    return raw ? toRun(raw) : null;
  }

  /**
   * The run that owns a result bundle.
   *
   * A bundle path is an identity — one run declares it via `-resultBundlePath`
   * and no other run can claim it — so this is a point lookup against
   * `run_bundle_idx`, not a scan of whatever happens to be recent. `ORDER BY`
   * only settles the pathological case of pre-index duplicates.
   */
  getRunByBundlePath(bundlePath: string): Run | null {
    const raw = this.sql(
      `SELECT * FROM run WHERE bundle_path = ? ORDER BY started_at DESC LIMIT 1`,
    ).get(bundlePath) as RunRowRaw | undefined;
    return raw ? toRun(raw) : null;
  }

  /**
   * Bundles a run has claimed but that have not been read yet.
   *
   * `detailed` means "we extracted its contents"; the `bundle-scanned:` key
   * means "we looked at it". They are different questions, and keeping them
   * separate is what lets a deliberate re-queue actually re-read. Answered in
   * SQL so a long build's bundle cannot age out of a fixed window.
   */
  listUnscannedBundlePaths(limit = 500): string[] {
    const rows = this.sql(
      `SELECT bundle_path AS path, MAX(started_at) AS at FROM run
        WHERE bundle_path IS NOT NULL
          AND (detailed = 0
               OR NOT EXISTS (SELECT 1 FROM seen_artifact s
                               WHERE s.key = 'bundle-scanned:' || run.bundle_path))
        GROUP BY bundle_path
        ORDER BY at DESC LIMIT ?`,
    ).all(limit) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  updateRun(run: Run): void {
    this.sql(
      `UPDATE run SET
         status = ?, status_rank = ?, kind = ?, scheme = ?, container = ?,
         configuration = ?, destination = ?, project_id = ?, root = ?,
         cwd = ?, cmdline = ?, started_at = ?, ended_at = ?, error_count = ?,
         warning_count = ?, analyzer_count = ?, test_total = ?,
         test_failed = ?, test_skipped = ?, bundle_path = ?, detailed = ?,
         branch = COALESCE(?, branch), worktree = COALESCE(?, worktree),
         thread_id = COALESCE(?, thread_id)
       WHERE id = ?`,
    ).run(
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
    const prefix = likePrefix(base);
    const result = this.sql(
      `UPDATE run SET thread_id = ?
        WHERE thread_id IS NULL AND started_at >= ?
          AND (cwd = ? OR cwd LIKE ? ESCAPE '\\'
               OR container = ? OR container LIKE ? ESCAPE '\\')`,
    ).run(threadId, since, base, prefix, base, prefix) as { changes?: number };
    return result?.changes ?? 0;
  }

  listRuns(query: {
    projectId?: string | null;
    kind?: RunKind | null;
    onlyProblems?: boolean;
    includeNoise?: boolean;
    /** Runs attributed to exactly this thread when they were observed. */
    threadId?: string | null;
    /**
     * Restrict to one thread's checkout. Applied in SQL, BEFORE the limit:
     * filtering afterwards meant a thread whose newest run sat outside the
     * machine-wide top 100 got an empty answer rather than its own history.
     */
    scope?: RunScope | null;
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
    if (query.threadId) {
      where.push("thread_id = ?");
      params.push(query.threadId);
    }
    if (query.scope) {
      const clause = scopeClause(query.scope);
      where.push(clause.sql);
      params.push(...clause.params);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const offset = Math.max(query.offset ?? 0, 0);
    const rows = this.sql(
      `SELECT * FROM run ${clause} ORDER BY started_at DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as RunRowRaw[];
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
    const rows = this.sql(
      `SELECT (ended_at - started_at) AS ms FROM run
        WHERE root = ? AND scheme = ? AND kind = ?
          AND ended_at IS NOT NULL
          AND status IN ('passed', 'warnings')
        ORDER BY started_at DESC LIMIT 20`,
    ).all(query.root, query.scheme, query.kind) as Array<{ ms: number }>;

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
    const row = this.sql(`SELECT COUNT(*) AS n FROM run ${clause}`).get(
      ...params,
    ) as { n: number };
    return row?.n ?? 0;
  }

  listUnresolved(): Run[] {
    const rows = this.sql(
      `SELECT * FROM run WHERE status IN ('running','finishing')
        ORDER BY started_at DESC`,
    ).all() as RunRowRaw[];
    return rows.map(toRun);
  }

  /**
   * Is anything still running or awaiting a verdict?
   *
   * The probe asks this every tick, and it used to be answered by fetching
   * every unresolved row and mapping it to a `Run` just to read `.length` —
   * alongside `expireFinishing`, which fetches the same rows for real. This is
   * the question actually being asked.
   */
  hasUnresolved(): boolean {
    return Boolean(
      this.sql(
        `SELECT 1 FROM run WHERE status IN ('running','finishing') LIMIT 1`,
      ).get(),
    );
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
    const rows = this.sql(
      `SELECT * FROM run
        WHERE status_rank < 2
          AND kind NOT IN ('index','package')
          AND started_at <= ?
          AND COALESCE(ended_at, started_at + ?) >= ?
        ORDER BY started_at DESC LIMIT 20`,
    ).all(aroundMs + slackMs, slackMs, aroundMs - slackMs) as RunRowRaw[];
    return rows.map(toRun);
  }

  replaceFindings(runId: string, findings: Finding[]): void {
    this.sql(`DELETE FROM finding WHERE run_id = ?`).run(runId);
    const insert = this.sql(
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
    return this.sql(
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
    this.sql(`DELETE FROM test_case WHERE run_id = ?`).run(runId);
    const insert = this.sql(
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
    return this.sql(
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

  /** How many tests of a run carry each status, without loading the rows. */
  countTestsByStatus(runId: string, status: TestCase["status"]): number {
    const row = this.sql(
      `SELECT COUNT(*) AS n FROM test_case WHERE run_id = ? AND status = ?`,
    ).get(runId, status) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  upsertRoot(
    path: string,
    projectId: string | null,
    via: string,
    now: number,
  ): boolean {
    const existed = this.sql(`SELECT 1 FROM root WHERE path = ?`).get(path);
    this.sql(
      `INSERT INTO root (path, project_id, discovered_via, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         project_id = COALESCE(root.project_id, excluded.project_id)`,
    ).run(path, projectId, via, now, now);
    return !existed;
  }

  listRoots(): Array<{
    path: string;
    projectId: string | null;
    discoveredVia: string;
    firstSeenAt: number;
    lastSeenAt: number;
  }> {
    return this.sql(`SELECT * FROM root ORDER BY last_seen_at DESC`)
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
    const result = this.sql(
      `DELETE FROM seen_artifact WHERE key LIKE ? AND seen_at >= ?`,
    ).run(`${prefix}%`, since) as { changes?: number };
    return result?.changes ?? 0;
  }

  markSeen(key: string, now: number): boolean {
    const existed = this.sql(`SELECT 1 FROM seen_artifact WHERE key = ?`).get(
      key,
    );
    if (existed) return false;
    this.sql(`INSERT INTO seen_artifact (key, seen_at) VALUES (?, ?)`).run(
      key,
      now,
    );
    return true;
  }

  clearSeen(key: string): void {
    this.sql(`DELETE FROM seen_artifact WHERE key = ?`).run(key);
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
      this.sql(`SELECT 1 FROM seen_artifact WHERE key = ?`).get(key),
    );
  }

  prune(cutoff: number): number {
    this.sql(
      `DELETE FROM finding WHERE run_id IN (SELECT id FROM run WHERE started_at < ?)`,
    ).run(cutoff);
    this.sql(
      `DELETE FROM test_case WHERE run_id IN (SELECT id FROM run WHERE started_at < ?)`,
    ).run(cutoff);
    this.sql(`DELETE FROM seen_artifact WHERE seen_at < ?`).run(cutoff);
    const result = this.sql(`DELETE FROM run WHERE started_at < ?`).run(
      cutoff,
    ) as { changes?: number };
    return result?.changes ?? 0;
  }

  /**
   * Delete finding/test_case rows whose run no longer exists. `prune` deletes
   * children of runs it is about to delete, but rows orphaned by any other
   * path (crashes mid-write, pre-fix data) accumulated forever — measured at
   * 16k child rows against 404 runs.
   */
  pruneOrphans(): number {
    const findings = this.sql(
      `DELETE FROM finding WHERE run_id NOT IN (SELECT id FROM run)`,
    ).run() as { changes?: number };
    const tests = this.sql(
      `DELETE FROM test_case WHERE run_id NOT IN (SELECT id FROM run)`,
    ).run() as { changes?: number };
    return (findings?.changes ?? 0) + (tests?.changes ?? 0);
  }

  /**
   * Drop roots nothing has referenced since the cutoff.
   *
   * A stale root makes every sweep slower forever — it is a directory tree the
   * collector keeps walking for manifests that will never change again.
   */
  pruneRoots(cutoff: number): number {
    const result = this.sql(`DELETE FROM root WHERE last_seen_at < ?`).run(
      cutoff,
    ) as { changes?: number };
    return result?.changes ?? 0;
  }

  /**
   * Fold the write-ahead log back into the database file.
   *
   * Without this the WAL grows unbounded between restarts: the visible "4.8MB
   * db" was measured at 82% WAL.
   */
  checkpoint(): void {
    this.sql(`PRAGMA wal_checkpoint(TRUNCATE)`).get();
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
      this.sql(
        `SELECT started_at, ended_at, status, scheme, kind FROM run
          WHERE started_at >= ? ${projectClause}
            AND ended_at IS NOT NULL AND status NOT IN ('running','finishing')
          ORDER BY started_at ASC LIMIT 500`,
      ).all(...params) as Array<{
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
      this.sql(
        `SELECT date(started_at / 1000, 'unixepoch', 'localtime') AS day,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status IN ('passed','warnings') THEN 1 ELSE 0 END) AS passed,
                AVG(CASE WHEN ended_at IS NOT NULL THEN ended_at - started_at END) AS avg_duration
           FROM run
          WHERE started_at >= ? ${projectClause}
            AND status NOT IN ('running','finishing')
          GROUP BY day ORDER BY day ASC`,
      ).all(...params) as Array<{
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

    const flakyTests = this.sql(
      `SELECT t.name AS name, t.suite AS suite,
              SUM(CASE WHEN t.status = 'failed' THEN 1 ELSE 0 END) AS failures,
              COUNT(*) AS runs
         FROM test_case t JOIN run r ON r.id = t.run_id
        WHERE r.started_at >= ? ${projectId ? "AND r.project_id = ?" : ""}
        GROUP BY t.name, t.suite
       HAVING failures > 0 AND runs > failures
        ORDER BY failures DESC LIMIT 20`,
    ).all(...params) as Array<{
      name: string;
      suite: string | null;
      failures: number;
      runs: number;
    }>;

    return { durations, daily, flakyTests };
  }
}

/**
 * The SQL half of `runMatchesScope`.
 *
 * Kept in lockstep with `scopes.ts` by `test/scopes.test.ts`, which runs the
 * same fixtures through both. The three arms, weakest last:
 *
 *  - the run was attributed to this thread when it was observed;
 *  - one of its paths sits under the thread's checkout;
 *  - same checkout NAME and same branch, which rescues a run whose cwd was
 *    unresolvable (lsof raced the process) without letting every `main` build
 *    on the machine claim the thread.
 */
function scopeClause(scope: RunScope): { sql: string; params: unknown[] } {
  const base = scope.path.endsWith("/") ? scope.path.slice(0, -1) : scope.path;
  const prefix = likePrefix(base);
  const arms = [
    "thread_id = ?",
    "cwd = ?",
    "cwd LIKE ? ESCAPE '\\'",
    "container = ?",
    "container LIKE ? ESCAPE '\\'",
    "root = ?",
    "root LIKE ? ESCAPE '\\'",
  ];
  const params: unknown[] = [
    scope.threadId,
    base,
    prefix,
    base,
    prefix,
    base,
    prefix,
  ];
  if (scope.branch) {
    arms.push("(worktree = ? AND branch = ?)");
    params.push(base.slice(base.lastIndexOf("/") + 1), scope.branch);
  }
  return { sql: `(${arms.join(" OR ")})`, params };
}
