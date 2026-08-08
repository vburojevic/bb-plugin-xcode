/**
 * The `xcodebuild` shim.
 *
 * Measured on a real machine: Xcode writes **no** Build-domain log-store entry
 * for command-line builds — every DerivedData root here had zero. The outcome
 * of a CLI build exists only in a `.xcresult`, and only when one was requested.
 * So without help, the tracker can time a build but never say whether it passed.
 *
 * The shim closes that gap by adding `-resultBundlePath` to build/test
 * invocations that lack one, writing bundles into a directory the tracker
 * watches. It is opt-in: it goes on PATH ahead of the real tool, which is a
 * real thing to do to a developer's shell, so the user asks for it explicitly.
 */

import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The system `xcodebuild` stub, which forwards to whichever Xcode
 * `xcode-select` points at. Hardcoded rather than resolved through PATH so the
 * shim can never invoke itself.
 */
const REAL_XCODEBUILD = "/usr/bin/xcodebuild";

/** Actions worth instrumenting. Queries like `-version` produce no results. */
const INSTRUMENTED_ACTIONS = [
  "build",
  "test",
  "archive",
  "analyze",
  "build-for-testing",
  "test-without-building",
];

export interface ShimPaths {
  /** Directory to prepend to PATH. */
  binDir: string;
  /** The shim executable itself. */
  script: string;
  /** Where result bundles land for the tracker to pick up. */
  bundleDir: string;
}

export function shimPaths(dataDir: string): ShimPaths {
  return {
    binDir: join(dataDir, "shim"),
    script: join(dataDir, "shim", "xcodebuild"),
    bundleDir: join(dataDir, "bundles"),
  };
}

/**
 * The shim script.
 *
 * Deliberately POSIX `sh` with no dependency on bb, node, or the network: it
 * sits in front of every build a developer runs, so it must be trivially
 * auditable and must never be the reason a build fails. Any unexpected
 * condition falls through to exec'ing the real tool unchanged.
 */
export function shimScript(bundleDir: string): string {
  return `#!/bin/sh
# bb xcode shim — records a result bundle for each build so the tracker can
# report real outcomes. Remove with: bb xcode shim uninstall
#
# Falls through to the real xcodebuild unchanged whenever it is not a build,
# already has a result bundle, or anything looks unusual.

REAL="${REAL_XCODEBUILD}"
BUNDLES="${bundleDir}"

[ -x "$REAL" ] || { echo "bb xcode shim: $REAL missing" >&2; exit 127; }

# Already instrumented by the caller — do not add a second bundle.
for arg in "$@"; do
  case "$arg" in
    -resultBundlePath) exec "$REAL" "$@" ;;
  esac
done

# Only instrument real build actions.
instrument=0
for arg in "$@"; do
  case "$arg" in
${INSTRUMENTED_ACTIONS.map((action) => `    ${action}) instrument=1 ;;`).join("\n")}
  esac
done
[ "$instrument" = 1 ] || exec "$REAL" "$@"

mkdir -p "$BUNDLES" 2>/dev/null || exec "$REAL" "$@"

stamp=$(date +%Y%m%d-%H%M%S)-$$
exec "$REAL" "$@" -resultBundlePath "$BUNDLES/$stamp.xcresult"
`;
}

/** Write the shim and its bundle directory. Returns the line to add to PATH. */
export async function installShim(dataDir: string): Promise<ShimPaths> {
  const paths = shimPaths(dataDir);
  await mkdir(paths.binDir, { recursive: true });
  await mkdir(paths.bundleDir, { recursive: true });
  await writeFile(paths.script, shimScript(paths.bundleDir), "utf8");
  await chmod(paths.script, 0o755);
  return paths;
}

export async function uninstallShim(dataDir: string): Promise<boolean> {
  const paths = shimPaths(dataDir);
  try {
    await rm(paths.script);
    return true;
  } catch {
    return false;
  }
}

export async function isShimInstalled(dataDir: string): Promise<boolean> {
  try {
    return (await stat(shimPaths(dataDir).script)).isFile();
  } catch {
    return false;
  }
}

/** Result bundles the shim has produced, oldest first. */
export async function listShimBundles(dataDir: string): Promise<string[]> {
  const { bundleDir } = shimPaths(dataDir);
  try {
    const entries = await readdir(bundleDir);
    return entries
      .filter((entry) => entry.endsWith(".xcresult"))
      .sort()
      .map((entry) => join(bundleDir, entry));
  } catch {
    return [];
  }
}

/**
 * Delete bundles older than `maxAgeMs`.
 *
 * Result bundles are not small and one is produced per build, so an
 * uncollected directory would grow without bound on an active machine.
 */
export async function pruneShimBundles(
  dataDir: string,
  maxAgeMs: number,
  now: number,
): Promise<number> {
  let removed = 0;
  for (const bundle of await listShimBundles(dataDir)) {
    try {
      const info = await stat(bundle);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(bundle, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Racing with a build that is still writing; leave it alone.
    }
  }
  return removed;
}

/** The shell line a user adds to make the shim take effect. */
export function pathExportLine(binDir: string): string {
  return `export PATH="${binDir}:$PATH"`;
}
