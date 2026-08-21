/**
 * All SQL, and the only place JSON crosses the database boundary.
 *
 * The forward-compatibility rule lives here: **every field added after v1 is
 * optional at the parse boundary regardless of what the interface claims.** A
 * baselined look is read months after it was written, bb validates RPC output
 * against the contract, and a row missing a newly-required key would take down
 * the whole card rather than one field. `parseLookMeta` and `parseSidecar` are
 * the only two functions allowed to interpret stored JSON.
 */
import { createHash } from "node:crypto";
import type { Db } from "./store.js";
import type { Frame, FrameSource, Look, LookKind, LookStatus, Verdict, VerdictStatus } from "./model.js";

// ---------------------------------------------------------------------------
// Row shapes, exactly as SQLite hands them back
// ---------------------------------------------------------------------------

interface LookRow {
  id: string;
  project_id: string;
  scope_key: string;
  kind: string;
  status: string;
  commit_sha: string | null;
  branch: string | null;
  device_key: string;
  device_udid: string | null;
  device_name: string | null;
  os_version: string | null;
  scale: number | null;
  started_at: number;
  ended_at: number | null;
  frame_count: number;
  expected_count: number | null;
  manifest_ran: number;
  bytes_total: number;
  error: string | null;
  meta_json: string;
}

interface FrameRow {
  id: string;
  look_id: string;
  identity: string;
  source: string;
  display_name: string;
  group_name: string;
  rel_path: string;
  thumb_rel_path: string | null;
  width: number;
  height: number;
  content_hash: string;
  bytes: number;
  diff_threshold: number | null;
  sidecar_json: string | null;
  foreground_bundle_id: string | null;
  captured_at: number;
}

interface VerdictRow {
  look_id: string;
  base_look_id: string | null;
  identity: string;
  status: string;
  diff_ratio: number | null;
  diff_pixels: number | null;
  mask_rel_path: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Parse boundaries
// ---------------------------------------------------------------------------

/**
 * Everything a look knows that has not earned a column yet.
 *
 * Every field is optional. That is not laziness — it is the contract: this
 * object is read from rows written by older versions of this plugin, forever.
 */
export interface LookMeta {
  /** The scheme the run built, for the Facts section. */
  scheme?: string;
  /** How the build ran, so the run can say so rather than implying it. */
  buildVia?: "xcode-plugin" | "xcodebuild";
  /** `null` when odiff was absent — the run rendered but compared nothing. */
  diffed?: boolean;
  serveSimVersion?: string;
  snapshotPreviewsVersion?: string;
  xcodeVersion?: string;
  arch?: string;
  /** The global threshold in force when the run was compared. */
  threshold?: number;
  /** Sorted manifest names, so a truncation can be detected after the fact. */
  manifest?: string[];
  /** Historical only: older releases persisted Stills result-bundle paths. */
  resultBundleRelPath?: string;
  /** Display only: where the checkout was when the run happened. */
  checkoutPath?: string;
  /** A frame identity that was captured while this bundle was in front. */
  foregroundBundleId?: string;
}

export function parseLookMeta(json: string | null | undefined): LookMeta {
  if (json === null || json === undefined || json === "") return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const record = raw as Record<string, unknown>;

  const meta: LookMeta = {};
  if (typeof record.scheme === "string") meta.scheme = record.scheme;
  if (record.buildVia === "xcode-plugin" || record.buildVia === "xcodebuild") meta.buildVia = record.buildVia;
  if (typeof record.diffed === "boolean") meta.diffed = record.diffed;
  if (typeof record.serveSimVersion === "string") meta.serveSimVersion = record.serveSimVersion;
  if (typeof record.snapshotPreviewsVersion === "string") {
    meta.snapshotPreviewsVersion = record.snapshotPreviewsVersion;
  }
  if (typeof record.xcodeVersion === "string") meta.xcodeVersion = record.xcodeVersion;
  if (typeof record.arch === "string") meta.arch = record.arch;
  if (typeof record.threshold === "number" && Number.isFinite(record.threshold)) {
    meta.threshold = record.threshold;
  }
  if (Array.isArray(record.manifest)) {
    meta.manifest = record.manifest.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof record.resultBundleRelPath === "string") meta.resultBundleRelPath = record.resultBundleRelPath;
  if (typeof record.checkoutPath === "string") meta.checkoutPath = record.checkoutPath;
  if (typeof record.foregroundBundleId === "string") meta.foregroundBundleId = record.foregroundBundleId;
  return meta;
}

/**
 * A SnapshotPreviews sidecar, as far as we trust it.
 *
 * `precision` round-trips through `1 - precision` in `Float` upstream, so the
 * stored threshold can be `0.050000012` for what was written as `0.05`. It is
 * never compared exactly; see `exceedsThreshold`.
 */
export interface Sidecar {
  displayName?: string;
  /** 0–1 fraction of changed pixels tolerated for this one frame. */
  diffThreshold?: number;
  scale?: number;
  deviceName?: string;
  osVersion?: string;
  /** Everything else, kept verbatim for the Facts section and for diagnosis. */
  extra: Record<string, unknown>;
}

export function parseSidecar(json: string | null | undefined): Sidecar {
  if (json === null || json === undefined || json === "") return { extra: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { extra: {} };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { extra: {} };
  const record = raw as Record<string, unknown>;

  const sidecar: Sidecar = { extra: record };
  if (typeof record.displayName === "string") sidecar.displayName = record.displayName;
  if (typeof record.name === "string" && sidecar.displayName === undefined) {
    sidecar.displayName = record.name;
  }

  // Upstream has written this as `diffThreshold` and as `precision`; accept
  // either, and treat a non-finite number as absent rather than as zero.
  const threshold = record.diffThreshold ?? record.diff_threshold;
  if (typeof threshold === "number" && Number.isFinite(threshold)) {
    sidecar.diffThreshold = threshold;
  } else if (typeof record.precision === "number" && Number.isFinite(record.precision)) {
    sidecar.diffThreshold = 1 - record.precision;
  }

  const simulator = record.simulator;
  if (typeof simulator === "object" && simulator !== null && !Array.isArray(simulator)) {
    const sim = simulator as Record<string, unknown>;
    if (typeof sim.name === "string") sidecar.deviceName = sim.name;
    if (typeof sim.osVersion === "string") sidecar.osVersion = sim.osVersion;
    if (typeof sim.os_version === "string" && sidecar.osVersion === undefined) {
      sidecar.osVersion = sim.os_version;
    }
  }
  if (typeof record.scale === "number" && Number.isFinite(record.scale)) sidecar.scale = record.scale;

  return sidecar;
}

// ---------------------------------------------------------------------------
// Row → domain
// ---------------------------------------------------------------------------

const LOOK_STATUSES = new Set<LookStatus>(["running", "ok", "failed", "cancelled"]);
const VERDICT_STATUSES = new Set<VerdictStatus>([
  "unchanged",
  "changed",
  "layout-changed",
  "added",
  "removed",
  "missing",
  "errored",
]);

function toLook(row: LookRow): Look {
  return {
    id: row.id,
    projectId: row.project_id,
    scopeKey: row.scope_key,
    kind: row.kind === "live" ? "live" : "stills",
    // An unknown status from a future version reads as failed rather than
    // throwing: a card that says "something went wrong" beats no card at all.
    status: LOOK_STATUSES.has(row.status as LookStatus) ? (row.status as LookStatus) : "failed",
    commitSha: row.commit_sha,
    branch: row.branch,
    deviceKey: row.device_key,
    deviceUdid: row.device_udid,
    deviceName: row.device_name,
    osVersion: row.os_version,
    scale: row.scale,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    frameCount: row.frame_count,
    expectedCount: row.expected_count,
    manifestRan: row.manifest_ran === 1,
    bytesTotal: row.bytes_total,
    error: row.error,
  };
}

function toFrame(row: FrameRow): Frame {
  return {
    id: row.id,
    lookId: row.look_id,
    identity: row.identity,
    source: row.source === "capture" ? "capture" : "preview",
    displayName: row.display_name,
    groupName: row.group_name,
    relPath: row.rel_path,
    thumbRelPath: row.thumb_rel_path,
    width: row.width,
    height: row.height,
    contentHash: row.content_hash,
    bytes: row.bytes,
    diffThreshold: row.diff_threshold,
    foregroundBundleId: row.foreground_bundle_id,
    capturedAt: row.captured_at,
  };
}

function toVerdict(row: VerdictRow): Verdict {
  return {
    lookId: row.look_id,
    baseLookId: row.base_look_id,
    identity: row.identity,
    status: VERDICT_STATUSES.has(row.status as VerdictStatus)
      ? (row.status as VerdictStatus)
      : "errored",
    diffRatio: row.diff_ratio,
    diffPixels: row.diff_pixels,
    maskRelPath: row.mask_rel_path,
    error: row.error,
  };
}

export function hashContent(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------
// Looks
// ---------------------------------------------------------------------------

export interface NewLook {
  id: string;
  projectId: string;
  scopeKey: string;
  kind: LookKind;
  status: LookStatus;
  commitSha: string | null;
  branch: string | null;
  deviceKey: string;
  deviceUdid: string | null;
  deviceName: string | null;
  osVersion: string | null;
  scale: number | null;
  startedAt: number;
  expectedCount?: number | null;
  meta?: LookMeta;
}

export function insertLook(db: Db, look: NewLook): void {
  db.prepare(
    `INSERT INTO looks (id, project_id, scope_key, kind, status, commit_sha, branch,
       device_key, device_udid, device_name, os_version, scale, started_at,
       expected_count, meta_json)
     VALUES (@id, @projectId, @scopeKey, @kind, @status, @commitSha, @branch,
       @deviceKey, @deviceUdid, @deviceName, @osVersion, @scale, @startedAt,
       @expectedCount, @metaJson)`,
  ).run({
    ...look,
    expectedCount: look.expectedCount ?? null,
    metaJson: JSON.stringify(look.meta ?? {}),
  });
}

export interface LookPatch {
  status?: LookStatus;
  endedAt?: number | null;
  frameCount?: number;
  expectedCount?: number | null;
  manifestRan?: boolean;
  bytesTotal?: number;
  error?: string | null;
}

export function updateLook(db: Db, lookId: string, patch: LookPatch): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: lookId };
  const assign = (column: string, key: string, value: unknown): void => {
    sets.push(`${column} = @${key}`);
    params[key] = value;
  };
  if (patch.status !== undefined) assign("status", "status", patch.status);
  if (patch.endedAt !== undefined) assign("ended_at", "endedAt", patch.endedAt);
  if (patch.frameCount !== undefined) assign("frame_count", "frameCount", patch.frameCount);
  if (patch.expectedCount !== undefined) assign("expected_count", "expectedCount", patch.expectedCount);
  if (patch.manifestRan !== undefined) assign("manifest_ran", "manifestRan", patch.manifestRan ? 1 : 0);
  if (patch.bytesTotal !== undefined) assign("bytes_total", "bytesTotal", patch.bytesTotal);
  if (patch.error !== undefined) assign("error", "error", patch.error);
  if (sets.length === 0) return;
  db.prepare(`UPDATE looks SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

/** Merge into `meta_json` rather than replacing it, so two writers cannot erase each other. */
export function mergeLookMeta(db: Db, lookId: string, patch: LookMeta): void {
  const row = db.prepare(`SELECT meta_json FROM looks WHERE id = ?`).get(lookId) as
    | { meta_json: string }
    | undefined;
  if (row === undefined) return;
  const merged = { ...parseLookMeta(row.meta_json), ...patch };
  db.prepare(`UPDATE looks SET meta_json = ? WHERE id = ?`).run(JSON.stringify(merged), lookId);
}

export function getLook(db: Db, lookId: string): Look | null {
  const row = db.prepare(`SELECT * FROM looks WHERE id = ?`).get(lookId) as LookRow | undefined;
  return row === undefined ? null : toLook(row);
}

export function getLookMeta(db: Db, lookId: string): LookMeta {
  const row = db.prepare(`SELECT meta_json FROM looks WHERE id = ?`).get(lookId) as
    | { meta_json: string }
    | undefined;
  return parseLookMeta(row?.meta_json);
}

export function listLooks(db: Db, scopeKey: string, kind: LookKind, limit: number): Look[] {
  const rows = db
    .prepare(
      `SELECT * FROM looks WHERE scope_key = ? AND kind = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(scopeKey, kind, limit) as LookRow[];
  return rows.map(toLook);
}

/** The newest finished run, which is what "the latest look" means to a person. */
export function latestLook(db: Db, scopeKey: string, kind: LookKind): Look | null {
  const row = db
    .prepare(
      `SELECT * FROM looks WHERE scope_key = ? AND kind = ? AND status != 'cancelled'
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(scopeKey, kind) as LookRow | undefined;
  return row === undefined ? null : toLook(row);
}

/**
 * The most recent completed look for this device class, excluding one id.
 *
 * This is the fallback base when nothing has been explicitly baselined: "the
 * last time this ran" is what a person means by "since".
 */
export function previousOkLook(
  db: Db,
  scopeKey: string,
  deviceKey: string,
  excludeLookId: string,
): Look | null {
  const row = db
    .prepare(
      `SELECT * FROM looks
       WHERE scope_key = ? AND device_key = ? AND kind = 'stills' AND status = 'ok' AND id != ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(scopeKey, deviceKey, excludeLookId) as LookRow | undefined;
  return row === undefined ? null : toLook(row);
}

export function deleteLook(db: Db, lookId: string): void {
  db.prepare(`DELETE FROM looks WHERE id = ?`).run(lookId);
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface NewFrame {
  id: string;
  lookId: string;
  identity: string;
  source: FrameSource;
  displayName: string;
  groupName: string;
  relPath: string;
  thumbRelPath: string | null;
  width: number;
  height: number;
  contentHash: string;
  bytes: number;
  diffThreshold: number | null;
  sidecarJson: string | null;
  foregroundBundleId: string | null;
  capturedAt: number;
}

export function insertFrame(db: Db, frame: NewFrame): void {
  db.prepare(
    `INSERT INTO frames (id, look_id, identity, source, display_name, group_name,
       rel_path, thumb_rel_path, width, height, content_hash, bytes,
       diff_threshold, sidecar_json, foreground_bundle_id, captured_at)
     VALUES (@id, @lookId, @identity, @source, @displayName, @groupName,
       @relPath, @thumbRelPath, @width, @height, @contentHash, @bytes,
       @diffThreshold, @sidecarJson, @foregroundBundleId, @capturedAt)`,
  ).run(frame);
}

export function listFrames(db: Db, lookId: string): Frame[] {
  const rows = db
    .prepare(`SELECT * FROM frames WHERE look_id = ? ORDER BY identity ASC`)
    .all(lookId) as FrameRow[];
  return rows.map(toFrame);
}

export function getFrame(db: Db, frameId: string): Frame | null {
  const row = db.prepare(`SELECT * FROM frames WHERE id = ?`).get(frameId) as FrameRow | undefined;
  return row === undefined ? null : toFrame(row);
}

export function findFrame(db: Db, lookId: string, identity: string): Frame | null {
  const row = db
    .prepare(`SELECT * FROM frames WHERE look_id = ? AND identity = ?`)
    .get(lookId, identity) as FrameRow | undefined;
  return row === undefined ? null : toFrame(row);
}

export function getFrameSidecar(db: Db, frameId: string): Sidecar {
  const row = db.prepare(`SELECT sidecar_json FROM frames WHERE id = ?`).get(frameId) as
    | { sidecar_json: string | null }
    | undefined;
  return parseSidecar(row?.sidecar_json);
}

/**
 * One identity's frames over time — the filmstrip, and the bisect answer §2
 * sells the plugin on. One query against `frames_identity`.
 */
export function identityHistory(
  db: Db,
  scopeKey: string,
  identity: string,
  limit: number,
): Array<{ frame: Frame; look: Look; verdict: VerdictStatus | null }> {
  const rows = db
    .prepare(
      `SELECT f.*, l.id AS l_id, v.status AS v_status
       FROM frames f
       JOIN looks l ON l.id = f.look_id
       LEFT JOIN verdicts v ON v.look_id = f.look_id AND v.identity = f.identity
       WHERE f.identity = ? AND l.scope_key = ?
       ORDER BY f.captured_at DESC LIMIT ?`,
    )
    .all(identity, scopeKey, limit) as Array<FrameRow & { v_status: string | null }>;

  return rows.map((row) => {
    const look = getLook(db, row.look_id);
    return {
      frame: toFrame(row),
      // The join guarantees the look exists; the null-guard is for a row that
      // lost its parent to a concurrent prune between the two statements.
      look: look ?? {
        id: row.look_id,
        projectId: "",
        scopeKey,
        kind: "stills",
        status: "ok",
        commitSha: null,
        branch: null,
        deviceKey: "",
        deviceUdid: null,
        deviceName: null,
        osVersion: null,
        scale: null,
        startedAt: row.captured_at,
        endedAt: row.captured_at,
        frameCount: 0,
        expectedCount: null,
        manifestRan: false,
        bytesTotal: 0,
        error: null,
      },
      verdict:
        row.v_status !== null && VERDICT_STATUSES.has(row.v_status as VerdictStatus)
          ? (row.v_status as VerdictStatus)
          : null,
    };
  });
}

/**
 * The last N captures from one device, newest first — the Frames strip.
 *
 * Scoped to the device rather than the project, because the strip sits under a
 * live frame and "the last twelve things I looked at on this simulator" is what
 * it is claiming to be.
 */
export function recentCaptures(db: Db, scopeKey: string, deviceUdid: string, limit: number): Frame[] {
  const rows = db
    .prepare(
      `SELECT f.* FROM frames f
       JOIN looks l ON l.id = f.look_id
       WHERE f.source = 'capture' AND l.scope_key = ? AND l.device_udid = ?
       ORDER BY f.captured_at DESC LIMIT ?`,
    )
    .all(scopeKey, deviceUdid, limit) as FrameRow[];
  return rows.map(toFrame);
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export function insertVerdicts(db: Db, verdicts: readonly Verdict[]): void {
  const statement = db.prepare(
    `INSERT OR REPLACE INTO verdicts (look_id, base_look_id, identity, status,
       diff_ratio, diff_pixels, mask_rel_path, error)
     VALUES (@lookId, @baseLookId, @identity, @status, @diffRatio, @diffPixels,
       @maskRelPath, @error)`,
  );
  const all = db.transaction((rows: readonly Verdict[]) => {
    for (const row of rows) statement.run(row);
  });
  all(verdicts);
}

export function listVerdicts(db: Db, lookId: string): Verdict[] {
  const rows = db.prepare(`SELECT * FROM verdicts WHERE look_id = ?`).all(lookId) as VerdictRow[];
  return rows.map(toVerdict);
}

/**
 * How often one identity changed across its last N runs — the flaky fact.
 *
 * Returns the counts rather than a boolean, because the panel says "changed in
 * 3 of the last 5 runs" and that is shorter than defending the word "flaky".
 */
export function changeFrequency(
  db: Db,
  scopeKey: string,
  identity: string,
  window: number,
): { changedRuns: number; totalRuns: number } {
  const rows = db
    .prepare(
      `SELECT v.status FROM verdicts v
       JOIN looks l ON l.id = v.look_id
       WHERE v.identity = ? AND l.scope_key = ? AND l.kind = 'stills' AND l.status = 'ok'
       ORDER BY l.started_at DESC LIMIT ?`,
    )
    .all(identity, scopeKey, window) as Array<{ status: string }>;
  const changedRuns = rows.filter(
    (row) => row.status === "changed" || row.status === "layout-changed",
  ).length;
  return { changedRuns, totalRuns: rows.length };
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export type BaselineSetBy = "auto" | "user" | "cli";

export interface BaselineRow {
  lookId: string;
  setAt: number;
  setBy: BaselineSetBy;
}

export function getBaseline(db: Db, scopeKey: string, deviceKey: string): BaselineRow | null {
  const row = db
    .prepare(`SELECT look_id, set_at, set_by FROM baselines WHERE scope_key = ? AND device_key = ?`)
    .get(scopeKey, deviceKey) as { look_id: string; set_at: number; set_by: string } | undefined;
  if (row === undefined) return null;
  return { lookId: row.look_id, setAt: row.set_at, setBy: row.set_by as BaselineSetBy };
}

export function setBaseline(
  db: Db,
  scopeKey: string,
  deviceKey: string,
  lookId: string,
  setBy: BaselineSetBy,
  at: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO baselines (scope_key, device_key, look_id, set_at, set_by)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(scopeKey, deviceKey, lookId, at, setBy);
}

export function clearBaseline(db: Db, scopeKey: string, deviceKey: string): void {
  db.prepare(`DELETE FROM baselines WHERE scope_key = ? AND device_key = ?`).run(scopeKey, deviceKey);
}

export function getIdentityBaselines(
  db: Db,
  scopeKey: string,
  deviceKey: string,
): Map<string, BaselineRow> {
  const rows = db
    .prepare(
      `SELECT identity, look_id, set_at, set_by FROM identity_baselines
       WHERE scope_key = ? AND device_key = ?`,
    )
    .all(scopeKey, deviceKey) as Array<{
    identity: string;
    look_id: string;
    set_at: number;
    set_by: string;
  }>;
  return new Map(
    rows.map((row) => [
      row.identity,
      { lookId: row.look_id, setAt: row.set_at, setBy: row.set_by as BaselineSetBy },
    ]),
  );
}

export function setIdentityBaseline(
  db: Db,
  scopeKey: string,
  deviceKey: string,
  identity: string,
  lookId: string,
  setBy: BaselineSetBy,
  at: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO identity_baselines (scope_key, device_key, identity, look_id, set_at, set_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(scopeKey, deviceKey, identity, lookId, at, setBy);
}

export function clearIdentityBaselines(db: Db, scopeKey: string, deviceKey: string): void {
  db.prepare(`DELETE FROM identity_baselines WHERE scope_key = ? AND device_key = ?`).run(
    scopeKey,
    deviceKey,
  );
}

// ---------------------------------------------------------------------------
// Thread links
// ---------------------------------------------------------------------------

export function linkThread(db: Db, threadId: string, lookId: string, at: number): void {
  db.prepare(
    `INSERT OR IGNORE INTO thread_links (thread_id, look_id, linked_at) VALUES (?, ?, ?)`,
  ).run(threadId, lookId, at);
}

export interface ThreadLink {
  lookId: string;
  linkedAt: number;
  /** The seen-identity watermark, or `null` if never dismissed. */
  dismissed: string | null;
}

export function latestThreadLink(db: Db, threadId: string): ThreadLink | null {
  const row = db
    .prepare(
      `SELECT look_id, linked_at, dismissed_json FROM thread_links
       WHERE thread_id = ? ORDER BY linked_at DESC LIMIT 1`,
    )
    .get(threadId) as { look_id: string; linked_at: number; dismissed_json: string | null } | undefined;
  if (row === undefined) return null;
  return { lookId: row.look_id, linkedAt: row.linked_at, dismissed: row.dismissed_json };
}

export function dismissThreadLink(db: Db, threadId: string, lookId: string, watermark: string): void {
  db.prepare(`UPDATE thread_links SET dismissed_json = ? WHERE thread_id = ? AND look_id = ?`).run(
    watermark,
    threadId,
    lookId,
  );
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Looks eligible for eviction, worst-to-keep first.
 *
 * A look that is baselined, that any identity baseline points at, or that a
 * thread is linked to is never returned — those are the three ways a person has
 * said "this one matters". A look referenced only by a message directive is
 * **not** exempt, deliberately: directives live in message text rather than a
 * queryable table, so the question cannot be answered without scanning
 * transcripts, and exempting all of them means the disk never shrinks in a busy
 * thread. The directive's tombstone state is the answer to that.
 */
export function evictionCandidates(db: Db, scopeKey: string | null): Look[] {
  const rows = db
    .prepare(
      `SELECT l.* FROM looks l
       WHERE (? IS NULL OR l.scope_key = ?)
         AND l.status != 'running'
         AND NOT EXISTS (SELECT 1 FROM baselines b WHERE b.look_id = l.id)
         AND NOT EXISTS (SELECT 1 FROM identity_baselines ib WHERE ib.look_id = l.id)
         AND NOT EXISTS (SELECT 1 FROM thread_links t WHERE t.look_id = l.id)
       ORDER BY l.started_at ASC`,
    )
    .all(scopeKey, scopeKey) as LookRow[];
  return rows.map(toLook);
}

export function countLooksInScope(db: Db, scopeKey: string, kind: LookKind): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM looks WHERE scope_key = ? AND kind = ?`)
    .get(scopeKey, kind) as { n: number };
  return row.n;
}

export function totalBytes(db: Db): number {
  const row = db.prepare(`SELECT COALESCE(SUM(bytes_total), 0) AS n FROM looks`).get() as { n: number };
  return row.n;
}

export function scopeCount(db: Db): number {
  const row = db.prepare(`SELECT COUNT(DISTINCT scope_key) AS n FROM looks`).get() as { n: number };
  return row.n;
}

/** Every look, for `bb xcode sim purge` and for the doctor's disk figure. */
export function allLooks(db: Db): Look[] {
  const rows = db.prepare(`SELECT * FROM looks ORDER BY started_at ASC`).all() as LookRow[];
  return rows.map(toLook);
}
