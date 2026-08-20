/**
 * Running the Stills target directly through the fixed system xcodebuild.
 *
 * It never polls: the child close event and an `AbortSignal` watchdog own the
 * lifetime, because the exit code is the one thing about a build we can trust.
 *
 * It does not parse build logs. Doing that badly is worse than not doing it;
 * the bounded tail is retained in the run while scratch result bundles are
 * deleted with the run's private working directory.
 */
import { join } from "node:path";
import { run, tail, type RunResult } from "./exec.js";
import { curatedChildEnv } from "../child-env.js";

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
}

/** Default watchdog. A clean build of a large app genuinely takes this long. */
export const BUILD_TIMEOUT_MS = 30 * 60_000;

export async function runXcodebuild(
  argv: readonly string[],
  target: BuildTarget,
  options: RunBuildOptions,
): Promise<BuildOutcome> {
  const via: BuildVia = "xcodebuild";
  let result: RunResult;
  try {
    result = await run("xcodebuild", argv, {
      cwd: options.cwd,
      // Unbuffered, so a hung build's last output is the line it hung on.
      env: { ...curatedChildEnv(process.env), NSUnbufferedIO: "YES" },
      timeoutMs: options.timeoutMs ?? BUILD_TIMEOUT_MS,
      signal: options.signal,
      maxBuffer: 4 * 1024 * 1024,
    });
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
    detail: describeFailure(result),
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
export function describeFailure(result: RunResult): string {
  if (result.timedOut) {
    return "The build did not finish in time and was stopped.";
  }
  const stderr = tail(result.stderr, 8 * 1024);
  const stdout = stderr === "" ? tail(result.stdout, 8 * 1024) : "";
  const detail = stderr || stdout;
  const head = `Build failed (exit ${result.code ?? "?"}).`;
  return detail === "" ? head : `${head}\n\n${detail}`;
}
