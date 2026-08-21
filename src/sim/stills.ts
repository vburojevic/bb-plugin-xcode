/**
 * The Stills run engine: manifest pass, render pass, import.
 *
 * ## Why there is a manifest pass at all
 *
 * A failed render writes nothing, logs nothing to XCTest, and leaves the run
 * green — in export mode the coordinator's `guard case .success` simply
 * returns. So *"148 previews rendered"* is a meaningless number without a
 * denominator.
 *
 * Setting `SNAPSHOTS_ALL_IMAGE_NAMES_FILE` makes `discoverPreviews()` write the
 * names and return `[]` — zero tests, nothing rendered. That count becomes
 * `expected_count`; any manifest name with no PNG becomes `missing`, is
 * rendered first, and is **never** reported as `removed`, because "you deleted
 * this preview" and "this preview crashed" are opposite facts.
 *
 * The device filter applies to the manifest too, so device-pinned previews
 * never read as missing: `logicalImageNames` calls the same
 * `SnapshotPreviewDeviceFilter` the render pass applies. Manifest and render
 * agree, which is why there is no "expected to be missing" list here.
 *
 * ## Why every run gets a fresh directory
 *
 * The export directory is never cleaned by upstream, so a stale PNG from a
 * deleted preview would read as unchanged forever.
 */
import { constants, type Dirent } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readTextFileBounded } from "../bounded-file.js";
import { deviceKey, describePreviewName, newFrameId, newLookId, previewIdentity, sidecarFor } from "./model.js";
import { hashContent, insertFrame, insertLook, mergeLookMeta, updateLook, type LookMeta } from "./frames.js";
import { dimensions, downscale, THUMB_LONG_EDGE } from "./image.js";
import { FrameStore } from "./framestore.js";
import { parseSidecar } from "./frames.js";
import {
  buildForTestingArgv,
  destinationFor,
  runXcodebuild,
  testWithoutBuildingArgv,
  type BuildOutcome,
  type BuildTarget,
} from "./xcodebuild.js";
import {
  findTestTargets,
  findXctestrunFiles,
  removeEnvironment,
  schemeOf,
  readXctestrun,
  writeEnvironment,
} from "./xctestrun.js";
import { SNAPSHOT_PREVIEWS_VERSION, TEST_CLASS_NAME } from "./onboard.js";
import type { Db } from "./store.js";

/** The two variables SnapshotPreviews reads from the runner's environment. */
export const MANIFEST_ENV = "SNAPSHOTS_ALL_IMAGE_NAMES_FILE";
export const EXPORT_ENV = "SNAPSHOTS_EXPORT_DIR";
/** Set so app code can gate network and analytics. Advice, not enforcement. */
export const PREVIEWS_ENV = "SNAPSHOTS_RUNNING_FOR_PREVIEWS";
export const MAX_EXPORT_FRAMES = 1000;
export const MAX_EXPORT_PNG_BYTES = 32 * 1024 * 1024;
export const MAX_EXPORT_SIDECAR_BYTES = 64 * 1024;
export const MAX_EXPORT_TOTAL_BYTES = 512 * 1024 * 1024;
export const MAX_EXPORT_IMAGE_EDGE = 16_384;
export const MAX_EXPORT_IMAGE_PIXELS = 64 * 1024 * 1024;
export const MAX_EXPORT_MANIFEST_BYTES = 1024 * 1024;
export const MAX_EXPORT_MANIFEST_NAME_BYTES = 4096;

export interface StillsRunInput {
  db: Db;
  store: FrameStore;
  lookId: string;
  scopeKey: string;
  projectId: string;
  checkoutPath: string;
  target: BuildTarget;
  /** `<TestTarget>/<Class>`, or `null` to run every test in the target. */
  onlyTesting: string | null;
  testTargetName: string | null;
  device: { udid: string; name: string; osVersion: string };
  commitSha: string | null;
  branch: string | null;
  scale: number;
  workDir: string;
  signal?: AbortSignal;
  now: () => number;
  log: (message: string) => void;
  /** Evict old pixels and reserve budget before importing generated output. */
  beforeImport?: (incomingBytes: number) => Promise<void>;
}

export interface StillsRunResult {
  lookId: string;
  ok: boolean;
  /** The manifest's count, or `null` when the manifest pass did not run. */
  expectedCount: number | null;
  frameCount: number;
  /** Manifest names that produced no PNG. Never reported as `removed`. */
  missing: string[];
  error: string | null;
  bytesTotal: number;
}

/**
 * Read the manifest SnapshotPreviews wrote.
 *
 * One name per line. Blank lines and a trailing newline are ordinary; anything
 * else is not something to guess at, so unparseable content yields an empty
 * manifest and the run reports "we don't know" rather than a wrong denominator.
 */
export function parseManifest(text: string): string[] {
  const names = [
    ...new Set(
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  ].sort();
  if (names.length > MAX_EXPORT_FRAMES) {
    throw new Error(`The preview manifest exceeds the ${MAX_EXPORT_FRAMES}-entry safety limit.`);
  }
  if (names.some((name) => Buffer.byteLength(name, "utf8") > MAX_EXPORT_MANIFEST_NAME_BYTES)) {
    throw new Error("The preview manifest contains a name beyond the safety limit.");
  }
  return names;
}

/**
 * Translate SnapshotPreviews' one opaque failure into something actionable.
 *
 * `SnapshotTest.testPreview` waits 10 seconds and fails with the exact string
 * `"Did not render"`; `HeightExpansionTimeLimitInSeconds` is 30, so the
 * expansion timeout can never fire and a slow-expanding view produces only
 * that. If upstream changes the string this degrades to the raw message rather
 * than losing it.
 */
export function explainRenderFailure(logText: string): string | null {
  if (!logText.includes("Did not render")) return null;
  return "This preview took longer than 10s to lay out — usually an unbounded List.";
}

/**
 * The sentence for a render that succeeded and exported nothing.
 *
 * **A passing test suite is not evidence that a single image exists.** Upstream's
 * export path ends in `guard case .success(let image) = result.image else
 * { return }`, so a preview that fails to render is dropped without failing its
 * test. Measured against SnapshotPreviews 0.18.0 with a test target that had no
 * host application: the manifest listed three previews, all three tests passed
 * in 0.000 seconds each, `** TEST SUCCEEDED **`, and the export directory stayed
 * empty. Every render had failed with `UISceneErrorDomain Code=101`.
 *
 * A run that finds N previews and produces none of them is the silent-empty
 * state this plugin exists to prevent, so it is a failure with a cause named —
 * not an `ok` with a soft sentence about there being nothing to compare yet.
 */
export function explainEmptyRender(expectedCount: number): string {
  const previews = expectedCount === 1 ? "1 preview" : `${expectedCount} previews`;
  return (
    `The render pass reported success and exported nothing: ${previews} found, 0 rendered.\n\n` +
    `The usual cause is a test target with no host application. SnapshotPreviews renders through a real window, ` +
    `so a target that runs without an app fails every render — and still reports its tests as passing. ` +
    `Set a Host Application on the snapshot test target, then run this again.`
  );
}

/** The sentence for a `.xctestrun` that carries no test target at all. */
export function explainNoTestAction(scheme: string): string {
  return (
    `The scheme ${scheme} built, but it has no test action — so there is nothing to render previews with.\n\n` +
    `Pick a scheme that runs your snapshot tests (the setting is "scheme"), or add the snapshot test target ` +
    `to this scheme's Test action in Xcode.`
  );
}

/**
 * Run one Stills pass, and **always** leave the row in a terminal state.
 *
 * The inner function returns a failure for everything it anticipates, but a
 * throw it did not anticipate used to escape to the caller, which logged it and
 * moved on — leaving `status = 'running'` in the database forever. The panel
 * then showed a spinner for a run that had been dead for twenty minutes, which
 * is a worse lie than any error message. Measured: a workspace scheme with no
 * test action threw out of the render pass and hung the row exactly like that.
 */
export async function runStills(input: StillsRunInput): Promise<StillsRunResult> {
  try {
    return await runStillsInner(input);
  } catch (error) {
    const detail = describe(error);
    updateLook(input.db, input.lookId, {
      status: "failed",
      endedAt: input.now(),
      error: detail,
    });
    return {
      lookId: input.lookId,
      ok: false,
      expectedCount: null,
      frameCount: 0,
      missing: [],
      error: detail,
      bytesTotal: 0,
    };
  }
}

async function runStillsInner(input: StillsRunInput): Promise<StillsRunResult> {
  const meta: LookMeta = {
    scheme: input.target.scheme,
    snapshotPreviewsVersion: SNAPSHOT_PREVIEWS_VERSION,
    arch: process.arch,
    checkoutPath: input.checkoutPath,
  };

  const fail = async (error: string): Promise<StillsRunResult> => {
    updateLook(input.db, input.lookId, { status: "failed", endedAt: input.now(), error });
    mergeLookMeta(input.db, input.lookId, meta);
    return {
      lookId: input.lookId,
      ok: false,
      expectedCount: null,
      frameCount: 0,
      missing: [],
      error,
      bytesTotal: 0,
    };
  };

  await mkdir(input.workDir, { recursive: true });

  // ── 1. build-for-testing ────────────────────────────────────────────────
  input.log("building for testing");
  const build = await runXcodebuild(buildForTestingArgv(input.target), input.target, {
    cwd: join(input.checkoutPath, dirOf(input.target)),
    signal: input.signal,
  });
  meta.buildVia = build.via;
  if (!build.ok) return fail(build.detail);

  const xctestrunFiles = await findXctestrunFiles(input.target.derivedDataPath);
  const xctestrunPath = xctestrunFiles[0];
  if (xctestrunPath === undefined) {
    return fail(
      `The build succeeded but produced no .xctestrun in ${input.target.derivedDataPath}. That usually means the scheme has no test action.`,
    );
  }
  const plist = await readXctestrun(xctestrunPath).catch(() => ({}));
  const schemeFromPlist = schemeOf(plist);
  if (schemeFromPlist !== null) meta.scheme = schemeFromPlist;

  // A scheme with no test action still produces a `.xctestrun` — a four-line
  // plist carrying nothing but the scheme's own name. Reading that as "the
  // build worked" and pressing on gets you "the render variables would have
  // reached nothing" two steps later, which is true and tells the user nothing
  // about what to change. The scheme is the thing to change, so name it.
  if (findTestTargets(plist).length === 0) {
    return fail(explainNoTestAction(schemeFromPlist ?? input.target.scheme));
  }

  const only =
    input.testTargetName === null ? undefined : (name: string) => name === input.testTargetName;

  // ── 2. manifest pass ────────────────────────────────────────────────────
  const manifestPath = join(input.workDir, "manifest.txt");
  let manifest: string[] = [];
  let manifestRan = false;
  try {
    await writeEnvironment(
      xctestrunPath,
      { [MANIFEST_ENV]: manifestPath, [PREVIEWS_ENV]: "1" },
      only,
    );
    input.log("running the manifest pass");
    const manifestRun = await runXcodebuild(
      testWithoutBuildingArgv(xctestrunPath, input.target, input.onlyTesting, "manifest.xcresult"),
      input.target,
      { cwd: join(input.checkoutPath, dirOf(input.target)), signal: input.signal },
    );
    // `discoverPreviews()` writes the names and returns [] — zero tests. A
    // non-zero exit here is a real failure, not "no previews".
    if (!manifestRun.ok) return fail(manifestRun.detail);
    manifest = parseManifest(
      await readTextFileBounded(manifestPath, MAX_EXPORT_MANIFEST_BYTES, { noFollow: true }),
    );
    manifestRan = manifest.length > 0;
  } catch (error) {
    // A manifest we could not get means no denominator, which the panel already
    // has a state for. The render still runs: rendering without a denominator
    // is useful; refusing to render is not.
    input.log(`manifest pass did not produce a list: ${describe(error)}`);
  }

  // ── 3. render pass, into a directory that has never been used ───────────
  const exportDir = join(input.workDir, "export");
  await mkdir(exportDir, { recursive: true });
  // The manifest variable has to be **removed**, not blanked. Upstream guards
  // it for presence and then `preconditionFailure`s on an empty value, so an
  // empty string crashes the runner before it bootstraps — and with the key
  // still present it would take the manifest branch again and render nothing.
  await removeEnvironment(xctestrunPath, [MANIFEST_ENV], only);
  await writeEnvironment(
    xctestrunPath,
    { [EXPORT_ENV]: exportDir, [PREVIEWS_ENV]: "1" },
    only,
  );
  input.log("rendering previews");
  const render = await runXcodebuild(
    testWithoutBuildingArgv(xctestrunPath, input.target, input.onlyTesting, "render.xcresult"),
    input.target,
    { cwd: join(input.checkoutPath, dirOf(input.target)), signal: input.signal },
  );

  // ── 4. import whatever it produced ──────────────────────────────────────
  const imported = await importExport({
    db: input.db,
    store: input.store,
    lookId: input.lookId,
    scopeKey: input.scopeKey,
    exportDir,
    now: input.now,
    beforeWrite: input.beforeImport,
  });

  const missing = manifest.filter((name) => !imported.names.has(name));

  // "Did not render" is SnapshottingTests' 10-second layout timeout; the
  // translation is worth more than the raw string, and falls through to it.
  const describeFailure = (detail: string): string => explainRenderFailure(detail) ?? detail;

  // A crash mid-run leaves a truncated but perfectly valid-looking export, so a
  // failed render with frames on disk is still worth importing — and still a
  // failure.
  if (!render.ok && imported.count === 0) return fail(describeFailure(render.detail));

  // Found previews, produced none of them. `explainEmptyRender` has the why.
  const emptyRender = render.ok && manifestRan && manifest.length > 0 && imported.count === 0;
  const ok = render.ok && !emptyRender;
  const error = emptyRender
    ? explainEmptyRender(manifest.length)
    : render.ok
      ? null
      : describeFailure(render.detail);

  meta.manifest = manifest;
  updateLook(input.db, input.lookId, {
    status: ok ? "ok" : "failed",
    endedAt: input.now(),
    frameCount: imported.count,
    expectedCount: manifestRan ? manifest.length : null,
    manifestRan,
    bytesTotal: imported.bytes,
    error,
  });
  mergeLookMeta(input.db, input.lookId, meta);

  return {
    lookId: input.lookId,
    ok,
    expectedCount: manifestRan ? manifest.length : null,
    frameCount: imported.count,
    missing,
    error,
    bytesTotal: imported.bytes,
  };
}

function dirOf(target: BuildTarget): string {
  // A workspace or project path names a file; everything else names a directory
  // that already is the build root.
  if (target.shape === "xcworkspace" || target.shape === "xcodeproj") {
    const parts = target.projectRelPath.split("/");
    return parts.slice(0, -1).join("/");
  }
  const parts = target.projectRelPath.split("/");
  return parts.slice(0, -1).join("/");
}

export interface ImportInput {
  db: Db;
  store: FrameStore;
  lookId: string;
  scopeKey: string;
  exportDir: string;
  now: () => number;
  beforeWrite?: (incomingBytes: number) => Promise<void>;
}

export interface ImportResult {
  count: number;
  bytes: number;
  /** The PNG basenames that arrived, for the missing calculation. */
  names: Set<string>;
}

/**
 * Import an export directory into the store.
 *
 * The sidecar is derived with `sidecarFor` and nothing else: preview filenames
 * contain embedded dots (`MyModule_LoginView.swift_Dark_Mode.png`), so any
 * `path.with_extension()`-shaped logic corrupts the name and silently drops
 * every per-frame threshold.
 */
export async function importExport(input: ImportInput): Promise<ImportResult> {
  let entries: Dirent[];
  try {
    entries = await readdir(input.exportDir, { withFileTypes: true });
  } catch {
    return { count: 0, bytes: 0, names: new Set() };
  }

  const pngs = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
    .map((entry) => entry.name)
    .sort();
  if (pngs.length > MAX_EXPORT_FRAMES) {
    throw new Error(`The preview export produced ${pngs.length} images; the safety limit is ${MAX_EXPORT_FRAMES}.`);
  }

  let incomingBytes = 0;
  for (const name of pngs) {
    const info = await lstat(join(input.exportDir, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Preview output ${name} is not a regular file.`);
    if (info.size > MAX_EXPORT_PNG_BYTES) throw new Error(`Preview output ${name} exceeds the per-image safety limit.`);
    incomingBytes += info.size;
    const sidecarPath = join(input.exportDir, sidecarFor(name));
    try {
      const sidecarInfo = await lstat(sidecarPath);
      if (!sidecarInfo.isFile() || sidecarInfo.isSymbolicLink()) {
        throw new Error(`Preview sidecar for ${name} is not a regular file.`);
      }
      if (sidecarInfo.size > MAX_EXPORT_SIDECAR_BYTES) {
        throw new Error(`Preview sidecar for ${name} exceeds the safety limit.`);
      }
      incomingBytes += sidecarInfo.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (incomingBytes > MAX_EXPORT_TOTAL_BYTES) {
      throw new Error("The preview export exceeds the total import safety limit.");
    }
  }
  await input.beforeWrite?.(incomingBytes);
  const names = new Set<string>();
  let count = 0;
  let bytes = 0;
  let actualIncomingBytes = 0;

  await input.store.ensureLookDir(input.scopeKey, input.lookId);

  for (const name of pngs) {
    let data: Buffer;
    try {
      data = await readRegularFile(join(input.exportDir, name), MAX_EXPORT_PNG_BYTES);
    } catch {
      continue;
    }
    actualIncomingBytes += data.byteLength;
    if (actualIncomingBytes > MAX_EXPORT_TOTAL_BYTES) {
      throw new Error("The preview export grew beyond the total import safety limit while it was being read.");
    }
    const size = dimensions(data);
    if (size === null) continue;
    if (
      size.width > MAX_EXPORT_IMAGE_EDGE ||
      size.height > MAX_EXPORT_IMAGE_EDGE ||
      size.width * size.height > MAX_EXPORT_IMAGE_PIXELS
    ) {
      throw new Error(`Preview output ${name} declares image dimensions beyond the safety limit.`);
    }

    let sidecarJson: string | null = null;
    try {
      const sidecar = await readRegularFile(
        join(input.exportDir, sidecarFor(name)),
        MAX_EXPORT_SIDECAR_BYTES,
      );
      actualIncomingBytes += sidecar.byteLength;
      if (actualIncomingBytes > MAX_EXPORT_TOTAL_BYTES) {
        throw new Error("The preview export grew beyond the total import safety limit while it was being read.");
      }
      sidecarJson = sidecar.toString("utf8");
    } catch (error) {
      // A missing sidecar is ordinary: it only exists when a preview declared
      // something worth recording.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const sidecar = parseSidecar(sidecarJson);
    const { groupName, displayName } = describePreviewName(name);

    // The export belongs to project code and may still be changing after the
    // directory preflight. Re-check the cumulative bytes actually opened so a
    // grow-after-stat race cannot bypass the plugin's disk budget.
    await input.beforeWrite?.(actualIncomingBytes);

    const written = await input.store.write(
      { scopeKey: input.scopeKey, lookId: input.lookId, relPath: name },
      data,
    );

    const thumbRelPath = `${name.slice(0, -".png".length)}.thumb.jpg`;
    const madeThumb = await downscale(
      join(input.store.root, input.scopeKey, input.lookId, name),
      join(input.store.root, input.scopeKey, input.lookId, thumbRelPath),
      THUMB_LONG_EDGE,
    );

    insertFrame(input.db, {
      id: newFrameId(input.now()),
      lookId: input.lookId,
      identity: previewIdentity(name),
      source: "preview",
      displayName: sidecar.displayName ?? displayName,
      groupName,
      relPath: name,
      thumbRelPath: madeThumb ? thumbRelPath : null,
      width: size.width,
      height: size.height,
      contentHash: hashContent(data),
      bytes: written,
      diffThreshold: sidecar.diffThreshold ?? null,
      sidecarJson,
      foregroundBundleId: null,
      capturedAt: input.now(),
    });

    names.add(name);
    count += 1;
    bytes += written;
  }

  return { count, bytes, names };
}

async function readRegularFile(path: string, limit: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("Generated preview file failed its safety check.");
    const data = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== data.length) throw new Error("Generated preview file changed while it was being read.");
    return data;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Start a run's row, so a panel can render "running" before anything builds. */
export function beginLook(
  db: Db,
  input: {
    scopeKey: string;
    projectId: string;
    device: { udid: string; name: string; osVersion: string };
    scale: number;
    commitSha: string | null;
    branch: string | null;
    now: number;
  },
): string {
  const lookId = newLookId(input.now);
  insertLook(db, {
    id: lookId,
    projectId: input.projectId,
    scopeKey: input.scopeKey,
    kind: "stills",
    status: "running",
    commitSha: input.commitSha,
    branch: input.branch,
    deviceKey: deviceKey({
      name: input.device.name,
      osVersion: input.device.osVersion,
      scale: input.scale,
      arch: process.arch,
    }),
    deviceUdid: input.device.udid,
    deviceName: input.device.name,
    osVersion: input.device.osVersion,
    scale: input.scale,
    startedAt: input.now,
  });
  return lookId;
}

/** `<TestTarget>/<Class>`, the `-only-testing:` argument. */
export function onlyTestingFor(testTargetName: string | null): string | null {
  return testTargetName === null ? null : `${testTargetName}/${TEST_CLASS_NAME}`;
}

export function destinationForDevice(udid: string): string {
  return destinationFor(udid);
}

export type { BuildOutcome };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
