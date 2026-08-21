/**
 * Tier 1 — Xcode's own build log store.
 *
 * `<derivedDataRoot>/Logs/{Build,Test,Package,...}/LogStoreManifest.plist` is
 * the authoritative record of completed activity. It is written for both
 * Xcode.app builds and `xcodebuild` CLI builds (className tells them apart),
 * and carries status plus error/warning counts without touching the much more
 * expensive `.xcactivitylog` payloads.
 *
 * Caveat proven by experiment: for CLI `xcodebuild test` runs the *Test*
 * manifest stays empty — test detail only exists in the `.xcresult`. See
 * `xcresult.ts`.
 */

import { isRecord, parsePlist, type PlistValue } from "./plist";
import type { ManifestEntry, RunStatus } from "./types";

/**
 * Offset between Apple's reference date (2001-01-01 UTC) and the Unix epoch.
 *
 * The manifest stores Apple-epoch seconds while `xcresulttool` emits Unix-epoch
 * seconds — mixing them up silently yields timestamps ~31 years off.
 */
export const APPLE_EPOCH_OFFSET_SECONDS = 978_307_200;

/** Log store subdirectories worth watching, mapped to the run kind they imply. */
/**
 * Only Build and Test are swept. The Package domain ("Resolve Packages") was
 * measured to carry no build outcomes, and correlating it against real builds
 * was v1's worst bug.
 */
export const LOG_DOMAINS: ReadonlyArray<{ dir: string; kind: "build" | "test" }> = [
  { dir: "Build", kind: "build" },
  { dir: "Test", kind: "test" },
];

export function appleTimeToEpochMs(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round((value + APPLE_EPOCH_OFFSET_SECONDS) * 1000);
}

/** Map Xcode's single-letter status to our vocabulary. */
export function statusFromHighLevel(
  raw: string | null,
  errorCount: number,
  testFailureCount: number,
): RunStatus {
  switch (raw) {
    case "S":
      return "passed";
    case "W":
      return "warnings";
    case "E":
      return "failed";
    case "X":
      return "cancelled";
    default:
      if (errorCount > 0 || testFailureCount > 0) return "failed";
      return raw === null ? "ended" : "passed";
  }
}

function num(value: PlistValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: PlistValue | undefined): string | null {
  if (typeof value !== "string") return null;
  // Xcode writes the literal string "<nil>" for absent document types.
  return value === "<nil>" ? null : value;
}

/**
 * Parse a `LogStoreManifest.plist` document into entries.
 *
 * Returns `[]` for an empty or unreadable manifest rather than throwing — an
 * empty log store is the normal state for a project that has not been built.
 */
export function parseManifest(xml: string): ManifestEntry[] {
  let root: PlistValue | null;
  try {
    root = parsePlist(xml);
  } catch {
    return [];
  }
  if (!isRecord(root)) return [];
  const logs = root["logs"];
  if (!isRecord(logs)) return [];

  const entries: ManifestEntry[] = [];
  for (const [uniqueIdentifier, value] of Object.entries(logs)) {
    if (!isRecord(value)) continue;
    const observable = isRecord(value["primaryObservable"])
      ? value["primaryObservable"]
      : {};

    const errorCount = num(observable["totalNumberOfErrors"]);
    const warningCount = num(observable["totalNumberOfWarnings"]);
    const analyzerCount = num(observable["totalNumberOfAnalyzerIssues"]);
    const testFailureCount = num(observable["totalNumberOfTestFailures"]);

    const startedRaw = value["timeStartedRecording"];
    const stoppedRaw = value["timeStoppedRecording"];

    entries.push({
      uniqueIdentifier,
      fileName: str(value["fileName"]),
      className: str(value["className"]),
      domainType: str(value["domainType"]),
      title: str(value["title"]),
      signature: str(value["signature"]),
      containerName: str(value["schemeIdentifier-containerName"]),
      startedAt: appleTimeToEpochMs(
        typeof startedRaw === "number" ? startedRaw : null,
      ),
      endedAt: appleTimeToEpochMs(
        typeof stoppedRaw === "number" ? stoppedRaw : null,
      ),
      status: statusFromHighLevel(
        str(observable["highLevelStatus"]),
        errorCount,
        testFailureCount,
      ),
      errorCount,
      warningCount,
      analyzerCount,
      testFailureCount,
    });
  }

  entries.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return entries;
}

/**
 * Best-effort scheme name from a manifest title.
 *
 * Xcode writes titles like `Building workspace Almanac with scheme Almanac`;
 * the scheme is the only part worth surfacing in a table.
 */
export function schemeFromTitle(title: string | null): string | null {
  if (!title) return null;
  const withScheme = /\bwith scheme\s+(.+?)\s*$/i.exec(title);
  if (withScheme) return withScheme[1]!.trim();
  return null;
}

/** True when the log was produced by `xcodebuild` rather than Xcode.app. */
export function isCommandLineLog(entry: ManifestEntry): boolean {
  return entry.className === "IDECommandLineBuildLog";
}
