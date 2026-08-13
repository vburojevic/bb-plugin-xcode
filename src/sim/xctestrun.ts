/**
 * Getting environment variables into the test runner.
 *
 * SnapshotPreviews reads `SNAPSHOTS_ALL_IMAGE_NAMES_FILE` (manifest pass) and
 * `SNAPSHOTS_EXPORT_DIR` (render pass) from the **test runner's process
 * environment**. `bb xcode run` accepts only argv and spawns the wrapped build
 * with the bb server's own environment, so a delegated build cannot carry them:
 * the manifest pass would write nothing, the render pass would attach PNGs to
 * the `.xcresult` instead of exporting, and the failure would look like an
 * empty export directory — the exact silent-empty state this plugin exists to
 * prevent.
 *
 * So the variables go into the generated `.xctestrun` plist before
 * `test-without-building`, which makes the delegated and direct paths identical
 * apart from argv.
 *
 * **Both env dicts are written.** Verified against Xcode 26.6: each test target
 * carries `TestingEnvironmentVariables` (the testing harness environment —
 * `DYLD_*`, `__XCODE_BUILT_PRODUCTS_DIR_PATHS`) *and* `EnvironmentVariables`
 * (the process environment — `OS_ACTIVITY_DT_MODE`, `TERM`). For a hosted unit
 * test the snapshot code runs inside the app host process, and which dict
 * reaches `ProcessInfo.processInfo.environment` there is documented nowhere we
 * could find. Writing both costs one plist key per variable and removes the
 * guess entirely.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { run, runJson } from "./exec.js";

/** The two dicts a test target carries. Both are written; see the header. */
export const ENV_DICTS = ["TestingEnvironmentVariables", "EnvironmentVariables"] as const;

export interface XctestrunTarget {
  /** The target's own name, e.g. `AppPreviewTests`. */
  blueprintName: string;
  /** Index into `TestConfigurations`. */
  configurationIndex: number;
  /** Index into that configuration's `TestTargets`. */
  targetIndex: number;
}

interface XctestrunPlist {
  __xctestrun_metadata__?: { FormatVersion?: number };
  TestConfigurations?: Array<{ TestTargets?: Array<{ BlueprintName?: string }> }>;
  ContainerInfo?: { SchemeName?: string };
  /** FormatVersion 1 put each target at the top level, keyed by its name. */
  [key: string]: unknown;
}

/**
 * Every test target in the plist, with the key path to reach it.
 *
 * FormatVersion 2 nests them under `TestConfigurations[].TestTargets[]`;
 * FormatVersion 1 put each target at the top level keyed by its name. Xcode has
 * emitted 2 since Xcode 13, but a `.xctestrun` left over from an older
 * derived-data directory is a real thing to trip over, so version 1 is at least
 * recognised rather than silently producing zero targets.
 */
export function findTestTargets(plist: XctestrunPlist): XctestrunTarget[] {
  const configurations = plist.TestConfigurations;
  if (Array.isArray(configurations)) {
    const out: XctestrunTarget[] = [];
    configurations.forEach((configuration, configurationIndex) => {
      (configuration.TestTargets ?? []).forEach((target, targetIndex) => {
        if (typeof target.BlueprintName !== "string") return;
        out.push({ blueprintName: target.BlueprintName, configurationIndex, targetIndex });
      });
    });
    return out;
  }

  // FormatVersion 1: top-level keys that look like a target.
  return Object.entries(plist)
    .filter(([key, value]) => !key.startsWith("__") && typeof value === "object" && value !== null)
    .map(([key], index) => ({ blueprintName: key, configurationIndex: -1, targetIndex: index }));
}

/** The scheme this `.xctestrun` was generated from, for the run's Facts. */
export function schemeOf(plist: XctestrunPlist): string | null {
  const name = plist.ContainerInfo?.SchemeName;
  return typeof name === "string" && name !== "" ? name : null;
}

/**
 * The `plutil` key path for one variable, escaped.
 *
 * A key containing a dot would otherwise be read as two path components, and
 * `DYLD_FRAMEWORK_PATH` is not the only key in there — an app can name its own.
 */
export function keyPath(target: XctestrunTarget, dict: string, variable: string): string {
  const escaped = variable.replace(/\./g, "\\.");
  if (target.configurationIndex < 0) {
    return `${target.blueprintName.replace(/\./g, "\\.")}.${dict}.${escaped}`;
  }
  return `TestConfigurations.${target.configurationIndex}.TestTargets.${target.targetIndex}.${dict}.${escaped}`;
}

export async function readXctestrun(path: string): Promise<XctestrunPlist> {
  return runJson<XctestrunPlist>("plutil", ["-convert", "json", "-o", "-", path], {
    timeoutMs: 20_000,
  });
}

/**
 * `<derivedData>/Build/Products/*.xctestrun`, **newest first**.
 *
 * By modification time, not by name. Derived data outlives a project: change the
 * scheme, or move a package into a workspace, and yesterday's `.xctestrun` is
 * still sitting there next to today's. Sorting by name then picks whichever one
 * happens to sort first — here that was a stale SwiftPM file with an unhosted
 * test target, so the run rendered nothing and blamed the wrong thing.
 */
export async function findXctestrunFiles(derivedDataPath: string): Promise<string[]> {
  const products = join(derivedDataPath, "Build", "Products");
  try {
    const entries = (await readdir(products)).filter((entry) => entry.endsWith(".xctestrun"));
    const timed = await Promise.all(
      entries.map(async (entry) => {
        const path = join(products, entry);
        // A file that vanished between the listing and the stat sorts last
        // rather than taking the whole run down with it.
        const mtimeMs = await stat(path).then(
          (info) => info.mtimeMs,
          () => 0,
        );
        return { path, mtimeMs };
      }),
    );
    return timed.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)).map((entry) => entry.path);
  } catch {
    return [];
  }
}

/**
 * Remove variables from every matching test target, in both env dicts.
 *
 * **Not the same as setting them to `""`.** Verified the hard way against
 * SnapshotPreviews 0.18.0: `AllSnapshotImageNamesWriter.createFromEnvironment`
 * guards `environment[envKey]` for presence, then `preconditionFailure`s on an
 * empty value — so blanking the manifest variable for the render pass crashes
 * the test runner before it bootstraps, with "Early unexpected exit, operation
 * never finished bootstrapping". The key has to go, not be emptied.
 */
export async function removeEnvironment(
  path: string,
  names: readonly string[],
  only?: (blueprintName: string) => boolean,
): Promise<string[]> {
  const plist = await readXctestrun(path);
  const targets = findTestTargets(plist).filter(
    (target) => only === undefined || only(target.blueprintName),
  );
  const removed: string[] = [];
  for (const target of targets) {
    for (const dict of ENV_DICTS) {
      for (const name of names) {
        const keyed = keyPath(target, dict, name);
        // A key that was never there is success: this runs before every render
        // pass, and the first one has nothing to remove.
        const result = await run("plutil", ["-remove", keyed, path], { timeoutMs: 20_000 });
        if (result.code === 0) removed.push(keyed);
      }
    }
  }
  return removed;
}

export interface WriteEnvironmentResult {
  /** Targets that were written to. Empty means the variables reached nothing. */
  targets: string[];
  /** Key paths written, for the log and for the test. */
  written: string[];
}

/**
 * Write variables into every matching test target, in both env dicts.
 *
 * `plutil -replace` inserts or overwrites, so a re-run against the same
 * `.xctestrun` is idempotent — which matters, because the manifest pass and the
 * render pass write different values into the same file.
 *
 * Throws when it matched no target: a run whose variables reached nothing
 * renders zero previews and reports success, and that is the failure mode the
 * whole design is arranged against.
 */
export async function writeEnvironment(
  path: string,
  variables: Record<string, string>,
  only?: (blueprintName: string) => boolean,
): Promise<WriteEnvironmentResult> {
  const plist = await readXctestrun(path);
  const targets = findTestTargets(plist).filter(
    (target) => only === undefined || only(target.blueprintName),
  );
  if (targets.length === 0) {
    throw new Error(
      `No test target in ${path} matched, so the render variables would have reached nothing.`,
    );
  }

  const written: string[] = [];
  for (const target of targets) {
    for (const dict of ENV_DICTS) {
      for (const [name, value] of Object.entries(variables)) {
        const path0 = keyPath(target, dict, name);
        const result = await run("plutil", ["-replace", path0, "-string", value, path], {
          timeoutMs: 20_000,
        });
        if (result.code !== 0) {
          throw new Error(
            `Could not write ${name} into ${path}: ${result.stderr.trim() || `plutil exited ${result.code ?? "?"}`}`,
          );
        }
        written.push(path0);
      }
    }
  }

  return { targets: targets.map((target) => target.blueprintName), written };
}
