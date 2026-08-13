/**
 * The schema, and the one rule that governs it.
 *
 * `bb.storage.migrate` keys migrations by **statement index**, so this array is
 * append-only and a statement is never edited after release. New facts go into
 * `meta_json` / `sidecar_json` first and are promoted to a real column with an
 * appended `ALTER TABLE … ADD COLUMN` only when they need an index.
 *
 * PNG bytes never enter SQLite. They live at
 * `<pluginDataDir>/frames/<scopeKey>/<lookId>/<relPath>` and the database
 * stores relative paths only — **no absolute path is ever persisted**, because
 * a database written on one machine is read on another the moment someone
 * moves a checkout, and an absolute path is the field that makes that fail.
 *
 * Every timestamp is integer epoch milliseconds. Nothing is ever stored as a
 * formatted string.
 */
import type BetterSqlite3 from "better-sqlite3";

/** The structural type we need, so tests can hand us a plain better-sqlite3 handle. */
export type Db = BetterSqlite3.Database;

/**
 * One statement per entry, always.
 *
 * `bb.storage.migrate` applies these by index, and better-sqlite3's `prepare`
 * rejects a string holding more than one statement — so a `CREATE TABLE` and
 * its indexes packed into one template literal works against the real host and
 * throws `RangeError: The supplied SQL string contains more than one
 * statement` anywhere a test prepares them itself. Splitting is also what lets
 * an index be added later without editing a frozen entry.
 */
export const MIGRATIONS: string[] = [
  // [0] Looks: one run of one mode against one device.
  `CREATE TABLE looks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     scope_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     commit_sha TEXT, branch TEXT,
     device_key TEXT NOT NULL,
     device_udid TEXT, device_name TEXT, os_version TEXT, scale REAL,
     started_at INTEGER NOT NULL, ended_at INTEGER,
     frame_count INTEGER NOT NULL DEFAULT 0,
     expected_count INTEGER,
     manifest_ran INTEGER NOT NULL DEFAULT 0,
     bytes_total INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     meta_json TEXT NOT NULL DEFAULT '{}'
   )`,
  `CREATE INDEX looks_scope ON looks(scope_key, kind, started_at DESC)`,
  // [1] Frames: one PNG with an identity, a device and a provenance.
  `CREATE TABLE frames (
     id TEXT PRIMARY KEY,
     look_id TEXT NOT NULL REFERENCES looks(id) ON DELETE CASCADE,
     identity TEXT NOT NULL,
     source TEXT NOT NULL,
     display_name TEXT NOT NULL, group_name TEXT NOT NULL DEFAULT '',
     rel_path TEXT NOT NULL, thumb_rel_path TEXT,
     width INTEGER NOT NULL, height INTEGER NOT NULL,
     content_hash TEXT NOT NULL, bytes INTEGER NOT NULL,
     diff_threshold REAL,
     sidecar_json TEXT,
     foreground_bundle_id TEXT,
     captured_at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX frames_look_identity ON frames(look_id, identity)`,
  `CREATE INDEX frames_identity ON frames(identity, captured_at DESC)`,
  // [2] Verdicts: the comparison of one identity against its base.
  `CREATE TABLE verdicts (
     look_id TEXT NOT NULL REFERENCES looks(id) ON DELETE CASCADE,
     base_look_id TEXT, identity TEXT NOT NULL,
     status TEXT NOT NULL,
     diff_ratio REAL, diff_pixels INTEGER,
     mask_rel_path TEXT, error TEXT,
     PRIMARY KEY (look_id, identity)
   )`,
  // [3] Run baselines: the whole-run truth for a (scope, device class).
  `CREATE TABLE baselines (
     scope_key TEXT NOT NULL, device_key TEXT NOT NULL,
     look_id TEXT NOT NULL REFERENCES looks(id) ON DELETE CASCADE,
     set_at INTEGER NOT NULL, set_by TEXT NOT NULL,
     PRIMARY KEY (scope_key, device_key)
   )`,
  // [4] Thread links: which thread asked for this look, and what it has seen.
  `CREATE TABLE thread_links (
     thread_id TEXT NOT NULL,
     look_id TEXT NOT NULL REFERENCES looks(id) ON DELETE CASCADE,
     linked_at INTEGER NOT NULL, dismissed_json TEXT,
     PRIMARY KEY (thread_id, look_id)
   )`,
  // [5] Per-identity baselines. Run-level baselining is all-or-nothing, and the
  // ordinary workflow — you intentionally moved the padding on three screens and
  // one real regression rode along — otherwise forces you to accept all 148
  // previews' worth of new truth to clear the three you meant.
  `CREATE TABLE identity_baselines (
     scope_key TEXT NOT NULL, device_key TEXT NOT NULL, identity TEXT NOT NULL,
     look_id TEXT NOT NULL REFERENCES looks(id) ON DELETE CASCADE,
     set_at INTEGER NOT NULL, set_by TEXT NOT NULL,
     PRIMARY KEY (scope_key, device_key, identity)
   )`,
];

/**
 * `ON DELETE CASCADE` is declarative only until foreign keys are switched on,
 * and the pragma is per-connection rather than per-database. Pruning a look
 * relies on the cascade to take its frames, verdicts, baselines and links with
 * it, so this runs on every handle before any statement does.
 */
export function prepareConnection(db: Db): void {
  db.pragma("foreign_keys = ON");
}

/** Checkpoint the write-ahead log. Run after a prune, when the file has actually shrunk. */
export function checkpoint(db: Db): void {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // A busy database will checkpoint on its own schedule. Nothing to report.
  }
}
