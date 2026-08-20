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

/** A literal POSIX-shell word; safe for paths containing quotes or `$()`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

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

REAL=${shellQuote(REAL_XCODEBUILD)}
BUNDLES=${shellQuote(bundleDir)}

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
 * How long result bundles are kept, and how much room they may take.
 *
 * These are NOT the run-history retention, and conflating them was a real
 * hazard: history is rows, measured in kilobytes, and a month of it is cheap.
 * A result bundle is a directory tree — a build's is a few MB, a test run's
 * with attachments is routinely hundreds — and one is produced per `build`,
 * `test`, `archive` and `analyze` on the machine. Pointing a month of run
 * retention at them meant following this plugin's own README could quietly
 * cost tens of gigabytes.
 *
 * They are also worth much less than history: everything the tracker needs is
 * extracted into the database on the first sweep. A bundle only has to outlive
 * the gap between the build finishing and the sweep reading it, plus enough
 * slack to survive a bb restart. Two days is generous for that.
 */
export interface BundleRetention {
  maxAgeMs: number;
  /** Ceiling on the whole bundle directory; oldest are evicted first. */
  maxTotalBytes: number;
}

export interface BundlePruneResult {
  removed: number;
  bytesFreed: number;
  /** Bytes still held after pruning, for the log line. */
  bytesRetained: number;
}

/** Recursive size of a directory tree, resilient to a build writing into it. */
async function treeSize(path: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12) return;
    let entries: Array<{ name: string; isDirectory: boolean }>;
    try {
      entries = (await readdir(dir, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(child, depth + 1);
        continue;
      }
      try {
        total += (await stat(child)).size;
      } catch {
        /* vanished mid-walk */
      }
    }
  };
  await walk(path, 0);
  return total;
}

/**
 * Enforce both halves of `BundleRetention`: age first, then the size budget.
 *
 * Age alone is not enough. A single afternoon of snapshot-test runs can blow
 * past any sane disk budget well inside the age window, and "your disk filled
 * up but the retention setting was respected" is not a defence.
 */
export async function pruneShimBundles(
  dataDir: string,
  retention: BundleRetention,
  now: number,
): Promise<BundlePruneResult> {
  const result: BundlePruneResult = {
    removed: 0,
    bytesFreed: 0,
    bytesRetained: 0,
  };

  const surviving: Array<{ path: string; mtimeMs: number; size: number }> = [];
  for (const bundle of await listShimBundles(dataDir)) {
    try {
      const info = await stat(bundle);
      const size = await treeSize(bundle);
      if (now - info.mtimeMs > retention.maxAgeMs) {
        await rm(bundle, { recursive: true, force: true });
        result.removed += 1;
        result.bytesFreed += size;
        continue;
      }
      surviving.push({ path: bundle, mtimeMs: info.mtimeMs, size });
    } catch {
      // Racing with a build that is still writing; leave it alone.
    }
  }

  // Oldest first, so the budget evicts the least useful bundles.
  surviving.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let held = surviving.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of surviving) {
    if (held <= retention.maxTotalBytes) break;
    try {
      await rm(entry.path, { recursive: true, force: true });
      held -= entry.size;
      result.removed += 1;
      result.bytesFreed += entry.size;
    } catch {
      /* leave it and try again next prune */
    }
  }
  result.bytesRetained = held;
  return result;
}

/** The shell line a user adds to make the shim take effect. */
export function pathExportLine(binDir: string): string {
  return `export PATH=${shellQuote(binDir)}:"$PATH"`;
}
