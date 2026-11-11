/**
 * What Xcode.app is doing, read from DerivedData rather than the process table.
 *
 * Xcode's build service is visible in `ps` only through its children, and an
 * IDE action spends long stretches with none: computing the build plan, and
 * the whole of a test run, whose runner and app live under the simulator's
 * own launchd, not under the service. Observed on a real Mac (Xcode 27,
 * `RunAllTests` through Xcode's agent tools): the service was first seen 70 s
 * into a five-minute action, its first children named no DerivedData root so
 * it could not be given to a thread, and every quiet stretch "ended" the run,
 * which came apart into three short ones and settled with no verdict.
 *
 * DerivedData says more, from the first second (verified read-only against
 * Xcode 26 DerivedData on this Mac):
 *
 *  - a test action creates `Logs/Test/Test-<scheme>-<start>.xcresult` when it
 *    begins — before its build — and writes the bundle's root `Info.plist`
 *    only when it ends. A bundle without one is a test action in progress,
 *    and its name says the scheme and the second it started;
 *  - a build holds `Build/Intermediates.noindex/XCBuildData/build.db` inside
 *    one open transaction for its whole length, so `build.db-journal` exists
 *    exactly while it runs.
 *
 * Both name their root, so they also say which workspace (its `info.plist`)
 * and so which thread. They are read only while a build service process
 * exists — no Xcode, no action — and are bounded in age, so a bundle or
 * journal a crash left behind cannot keep a run alive for long.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_DERIVED_DATA, discoverDefaultRoots } from "./discovery";

/** An action older than this is a leftover, not one still running. */
export const MAX_ACTION_AGE_MS = 3 * 3_600_000;
/** How long the list of DerivedData roots is trusted. */
const ROOTS_TTL_MS = 60_000;

export interface XcodeAction {
  /** The DerivedData root the action works in. */
  root: string;
  kind: "test" | "build";
  /** When the action began. */
  startedAt: number;
  /** For a test action: its result bundle, still being written. */
  bundlePath: string | null;
  scheme: string | null;
}

export interface XcodeActionSource {
  /** Actions in progress, newest first. `extraRoots` are roots seen in `ps`. */
  inProgress(now: number, extraRoots: readonly string[]): Promise<XcodeAction[]>;
}

/**
 * `Test-<scheme>-YYYY.MM.DD_HH-MM-SS-±HHMM.xcresult`, as Xcode names a test
 * action's bundle: the scheme, and the local start time with its offset.
 */
export function parseTestBundleName(name: string): { scheme: string; startedAt: number } | null {
  const match =
    /^Test-(.+)-(\d{4})\.(\d{2})\.(\d{2})_(\d{2})-(\d{2})-(\d{2})-([+-])(\d{2})(\d{2})\.xcresult$/.exec(
      name,
    );
  if (!match) return null;
  const [, scheme, y, mo, d, h, mi, s, sign, oh, om] = match;
  const offsetMs = (Number(oh) * 60 + Number(om)) * 60_000 * (sign === "-" ? -1 : 1);
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return { scheme: scheme!, startedAt: local - offsetMs };
}

/** The DerivedData roots of one Mac, checked on that Mac. */
export class DerivedDataActions implements XcodeActionSource {
  private roots: string[] = [];
  private rootsAt = -Infinity;

  constructor(private readonly derivedDataDir: string = DEFAULT_DERIVED_DATA) {}

  async inProgress(now: number, extraRoots: readonly string[]): Promise<XcodeAction[]> {
    if (now - this.rootsAt >= ROOTS_TTL_MS) {
      this.roots = await discoverDefaultRoots(this.derivedDataDir);
      this.rootsAt = now;
    }
    const roots = [...new Set([...this.roots, ...extraRoots])];
    const actions: XcodeAction[] = [];
    for (const root of roots) {
      const test = await testInProgress(root, now);
      if (test) actions.push(test);
      const build = await buildInProgress(root, now);
      if (build) actions.push(build);
    }
    return actions.sort((a, b) => b.startedAt - a.startedAt);
  }
}

/** The newest test bundle of a root, when it has not been finalized yet. */
async function testInProgress(root: string, now: number): Promise<XcodeAction | null> {
  const dir = join(root, "Logs", "Test");
  const entries = await readdir(dir).catch(() => [] as string[]);
  let newest: { path: string; scheme: string; startedAt: number } | null = null;
  for (const entry of entries) {
    const parsed = parseTestBundleName(entry);
    if (!parsed || (newest && newest.startedAt >= parsed.startedAt)) continue;
    newest = { path: join(dir, entry), ...parsed };
  }
  // Only the newest can be running: a later one means it was left behind.
  if (!newest || now - newest.startedAt > MAX_ACTION_AGE_MS) return null;
  const finalized = await stat(join(newest.path, "Info.plist"))
    .then((info) => info.isFile())
    .catch(() => false);
  if (finalized) return null;
  return {
    root,
    kind: "test",
    startedAt: newest.startedAt,
    bundlePath: newest.path,
    scheme: newest.scheme,
  };
}

/** A build holding its build database open, judged by the journal's age. */
async function buildInProgress(root: string, now: number): Promise<XcodeAction | null> {
  const journal = join(root, "Build", "Intermediates.noindex", "XCBuildData", "build.db-journal");
  const info = await stat(journal).catch(() => null);
  if (!info?.isFile()) return null;
  // Birth time where the file system keeps one; the change time otherwise.
  const startedAt = info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs;
  if (now - startedAt > MAX_ACTION_AGE_MS) return null;
  return { root, kind: "build", startedAt, bundlePath: null, scheme: null };
}

