/**
 * Running xcodebuild — directly, or through `bb-plugin-xcode` when it is there.
 *
 * Neither path polls. Both are `await once(child, "close")` with an
 * `AbortSignal` watchdog, because the exit code of a build is the one thing
 * about a build you can actually trust.
 *
 * **The direct path does not parse build logs.** Doing that badly is worse than
 * not doing it, and doing it well is exactly what the Xcode plugin exists for.
 * So the failure state reads *"Build failed (exit 65). Install bb-plugin-xcode
 * for parsed errors, or open the result bundle."*
 */
import { join } from "node:path";
import { run, tail, type RunResult } from "./exec.js";

export interface BuildTarget {
  /**
   * Where result bundles go. **Unique per run**: xcodebuild refuses to
   * overwrite an existing bundle and fails in about a second with no
   * diagnostics, which reads as a broken build rather than a stale path.
   */
  /** Checkout-relative path to the project, workspace or package directory. */
  projectRelPath: string;
  shape: "spm" | "xcodegen" | "tuist" | "xcodeproj" | "xcworkspace" | "unknown";
  scheme: string;
  /** `platform=iOS Simulator,id=<udid>` — composed, never taken from settings. */
  destination: string;
  derivedDataPath: string;
  resultBundlePath: string;
}


export type BuildVia = "xcode-plugin" | "xcodebuild";

export interface BuildOutcome {
  ok: boolean;
  via: BuildVia;
  exitCode: number | null;
  /** The last of stderr, bounded, for a failure card that fits on screen. */
  detail: string;
  resultBundlePath: string;
}

/** `platform=iOS Simulator,id=<udid>`. Composed here so nothing else spells it. */
export function destinationFor(udid: string): string {
  return `platform=iOS Simulator,id=${udid}`;
}

/**
 * The project flag, named **relative to the build's working directory**.
 *
 * `projectRelPath` is relative to the checkout, but the build runs in the
 * directory that contains the project — so passing it whole asks xcodebuild for
 * `scratch/Demo/Demo.xcworkspace` from inside `scratch/Demo`, which does not
 * exist. That failure arrives as a bare `xcodebuild encountered an error (66)`
 * with nothing else to go on, and only for project and workspace shapes: SwiftPM
 * passes no flag at all and builds from the directory it is standing in, so it
 * looked fine right up until the first `.xcworkspace`.
 */
function projectArgs(target: BuildTarget): string[] {
  const fileName = target.projectRelPath.split("/").pop() ?? target.projectRelPath;
  switch (target.shape) {
    case "xcworkspace":
      return ["-workspace", fileName];
    case "xcodeproj":
      return ["-project", fileName];
    default:
      // SwiftPM, XcodeGen and Tuist all build from the directory containing the
      // manifest, with no project flag.
      return [];
  }
}

export function buildForTestingArgv(target: BuildTarget): string[] {
  return [
    ...projectArgs(target),
    "-scheme",
    target.scheme,
    "-destination",
    target.destination,
    "-derivedDataPath",
    target.derivedDataPath,
    "-resultBundlePath",
    join(target.resultBundlePath, "build.xcresult"),
    "build-for-testing",
    "-quiet",
  ];
}

export function testWithoutBuildingArgv(
  xctestrunPath: string,
  target: BuildTarget,
  onlyTesting: string | null,
  resultBundleName: string,
): string[] {
  return [
    "-xctestrun",
    xctestrunPath,
    "-destination",
    target.destination,
    "-resultBundlePath",
    join(target.resultBundlePath, resultBundleName),
    ...(onlyTesting === null ? [] : ["-only-testing:" + onlyTesting]),
    "test-without-building",
    "-quiet",
  ];
}

export interface RunBuildOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * The bb CLI, when the Xcode plugin is installed and should own the build.
   *
   * `bb xcode run --wait -- xcodebuild …` gives three things this would
   * otherwise reinvent: the build appears in the Xcode plugin's own activity
   * card, so the user's "what is building" surface stays singular; the verdict
   * comes back parsed by an engine that already knows how to distrust a poll
   * loop's exit code; and this plugin's banner can point at their card instead
   * of drawing a second progress bar for the same work.
   */
  delegate: { bbCli: string } | null;
}

/** Default watchdog. A clean build of a large app genuinely takes this long. */
export const BUILD_TIMEOUT_MS = 30 * 60_000;

export async function runXcodebuild(
  argv: readonly string[],
  target: BuildTarget,
  options: RunBuildOptions,
): Promise<BuildOutcome> {
  const via: BuildVia = options.delegate === null ? "xcodebuild" : "xcode-plugin";
  let result: RunResult;
  try {
    if (options.delegate === null) {
      result = await run("xcodebuild", argv, {
        cwd: options.cwd,
        // Unbuffered, so a hung build's last output is the line it hung on.
        env: { ...process.env, NSUnbufferedIO: "YES" },
        timeoutMs: options.timeoutMs ?? BUILD_TIMEOUT_MS,
        signal: options.signal,
        maxBuffer: 4 * 1024 * 1024,
      });
    } else {
      // `resolveBuildArgv` rewrites `xcodebuild` to `/usr/bin/xcodebuild` and
      // passes everything else through unchanged, so this argv is safe as-is.
      result = await run(options.delegate.bbCli, ["xcode", "run", "--wait", "--", "xcodebuild", ...argv], {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? BUILD_TIMEOUT_MS,
        signal: options.signal,
        maxBuffer: 4 * 1024 * 1024,
      });
    }
  } catch (error) {
    return {
      ok: false,
      via,
      exitCode: null,
      detail: error instanceof Error ? error.message : String(error),
      resultBundlePath: target.resultBundlePath,
    };
  }

  if (result.code === 0) {
    return { ok: true, via, exitCode: 0, detail: "", resultBundlePath: target.resultBundlePath };
  }

  return {
    ok: false,
    via,
    exitCode: result.code,
    detail: describeFailure(result, via, target.resultBundlePath),
    resultBundlePath: target.resultBundlePath,
  };
}

/**
 * The failure sentence.
 *
 * Names the exit code, the last of stderr, and — on the direct path — where the
 * parsed version lives. Pointing at a better tool is more useful than a worse
 * imitation of it.
 */
export function describeFailure(result: RunResult, via: BuildVia, resultBundlePath: string): string {
  if (result.timedOut) {
    return "The build did not finish in time and was stopped.";
  }
  const stderr = tail(result.stderr, 8 * 1024);
  const stdout = stderr === "" ? tail(result.stdout, 8 * 1024) : "";
  const detail = stderr || stdout;
  const head =
    via === "xcode-plugin"
      ? `Build failed (exit ${result.code ?? "?"}).`
      : `Build failed (exit ${result.code ?? "?"}). Install bb-plugin-xcode for parsed errors, or open the result bundle at ${resultBundlePath}.`;
  return detail === "" ? head : `${head}\n\n${detail}`;
}
