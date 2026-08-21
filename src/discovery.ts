/**
 * DerivedData root discovery.
 *
 * The premise of this plugin is that DerivedData location is *not* knowable in
 * advance: it may be the shared `~/Library/Developer/Xcode/DerivedData`, a
 * project-local `.build-sim`, or anything passed to `-derivedDataPath`. So
 * roots are discovered from three independent angles and merged.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** The shared location Xcode.app uses unless told otherwise. */
export const DEFAULT_DERIVED_DATA = join(
  homedir(),
  "Library/Developer/Xcode/DerivedData",
);

/**
 * Directory names that are conventional project-local DerivedData.
 *
 * Matched by prefix, so `.build-sim`, `.build-mac` and `.build` all qualify.
 */
const LOCAL_ROOT_HINTS = [".build", "build", "DerivedData", "dd"];

/** Directories never worth descending into when scanning a worktree. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".svn",
  "Pods",
  "Carthage",
  ".swiftpm",
  "vendor",
  ".venv",
  "venv",
  "dist",
  "out",
  ".next",
  "target",
]);

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** True when `path` looks like a DerivedData root (it has a log store). */
export async function looksLikeDerivedRoot(path: string): Promise<boolean> {
  return isDirectory(join(path, "Logs", "Build"));
}

/** Immediate children of the shared DerivedData directory that have log stores. */
export async function discoverDefaultRoots(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(DEFAULT_DERIVED_DATA);
  } catch {
    return [];
  }
  const found: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(DEFAULT_DERIVED_DATA, entry);
      if (await looksLikeDerivedRoot(path)) found.push(path);
    }),
  );
  return found.sort();
}

/**
 * Scan a project worktree for DerivedData roots.
 *
 * Bounded by `maxDepth` because worktrees can be large, and deliberately
 * includes dot-directories — Almanac's real build output lives in
 * `AlmanacKit/.build-sim`, which a conventional scan would skip entirely.
 */
export async function discoverProjectRoots(
  worktree: string,
  maxDepth = 4,
): Promise<string[]> {
  const found: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      const raw = await readdir(dir, { withFileTypes: true });
      entries = raw.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory) return;
        if (SKIP_DIRECTORIES.has(entry.name)) return;
        const path = join(dir, entry.name);

        const isHint = LOCAL_ROOT_HINTS.some(
          (hint) => entry.name === hint || entry.name.startsWith(`${hint}-`),
        );
        if (isHint && (await looksLikeDerivedRoot(path))) {
          found.push(path);
          return; // a DerivedData root never contains another one
        }

        // Descend into ordinary directories, and into dot-directories only when
        // they are a build-output hint (avoids .git internals, caches, etc).
        if (entry.name.startsWith(".") && !isHint) return;
        await walk(path, depth + 1);
      }),
    );
  };

  await walk(worktree, 0);
  return [...new Set(found)].sort();
}

/** Absolute paths of the log-store manifests inside a root. */
export function manifestPaths(
  root: string,
  domains: readonly string[],
): string[] {
  return domains.map((domain) =>
    join(root, "Logs", domain, "LogStoreManifest.plist"),
  );
}

/** `.xcresult` bundles Xcode wrote alongside a root's test logs. */
export async function findTestResultBundles(root: string): Promise<string[]> {
  const testLogs = join(root, "Logs", "Test");
  let entries: string[];
  try {
    entries = await readdir(testLogs);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".xcresult"))
    .map((entry) => join(testLogs, entry))
    .sort();
}
