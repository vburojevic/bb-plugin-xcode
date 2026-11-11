/**
 * DerivedData as Xcode lays it out, built in a temp directory.
 *
 * Shapes taken from a real Xcode 26 DerivedData (read-only): each root has an
 * `info.plist` naming its `WorkspacePath`, a `Logs/Build` (and `Logs/Test`)
 * log store with a `LogStoreManifest.plist`, and Xcode leaves test result
 * bundles as `Logs/Test/*.xcresult`. A bundle is finalized once its root
 * `Info.plist` exists.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APPLE_EPOCH_OFFSET_SECONDS } from "../../src/manifest";

export interface ManifestFixtureEntry {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  /** Xcode's one-letter status: S, W, E or X. */
  status: "S" | "W" | "E" | "X";
  errors?: number;
}

function appleTime(ms: number): number {
  return ms / 1000 - APPLE_EPOCH_OFFSET_SECONDS;
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function manifestXml(entries: readonly ManifestFixtureEntry[]): string {
  const logs = entries
    .map(
      (entry) => `
    <key>${entry.id}</key>
    <dict>
      <key>className</key><string>IDEActivityLogSection</string>
      <key>domainType</key><string>Xcode.IDEActivityLogDomainType.BuildLog</string>
      <key>primaryObservable</key>
      <dict>
        <key>highLevelStatus</key><string>${entry.status}</string>
        <key>totalNumberOfAnalyzerIssues</key><integer>0</integer>
        <key>totalNumberOfErrors</key><integer>${entry.errors ?? 0}</integer>
        <key>totalNumberOfTestFailures</key><integer>0</integer>
        <key>totalNumberOfWarnings</key><integer>0</integer>
      </dict>
      <key>timeStartedRecording</key><real>${appleTime(entry.startedAt)}</real>
      <key>timeStoppedRecording</key><real>${appleTime(entry.endedAt)}</real>
      <key>title</key><string>${escape(entry.title)}</string>
      <key>uniqueIdentifier</key><string>${entry.id}</string>
    </dict>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>logFormatVersion</key><integer>12</integer>
  <key>logs</key>
  <dict>${logs}
  </dict>
</dict>
</plist>
`;
}

/** A DerivedData root, as Xcode.app creates one for a workspace. */
export function makeDerivedRoot(
  root: string,
  options: { workspace?: string; build?: readonly ManifestFixtureEntry[] } = {},
): string {
  mkdirSync(join(root, "Logs", "Build"), { recursive: true });
  mkdirSync(join(root, "Logs", "Test"), { recursive: true });
  mkdirSync(join(root, "Build", "Intermediates.noindex"), { recursive: true });
  if (options.workspace) {
    writeFileSync(
      join(root, "info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>LastAccessedDate</key>
	<date>2026-11-01T01:50:21Z</date>
	<key>WorkspacePath</key>
	<string>${escape(options.workspace)}</string>
</dict>
</plist>
`,
    );
  }
  if (options.build) writeBuildManifest(root, options.build);
  return root;
}

export function writeBuildManifest(root: string, entries: readonly ManifestFixtureEntry[]): void {
  writeFileSync(join(root, "Logs", "Build", "LogStoreManifest.plist"), manifestXml(entries));
}

/** A result bundle in a root's Test logs; `finalized` writes its Info.plist. */
export function makeTestBundle(root: string, name: string, finalized = true): string {
  const bundle = join(root, "Logs", "Test", `${name}.xcresult`);
  mkdirSync(join(bundle, "Data"), { recursive: true });
  if (finalized) writeFileSync(join(bundle, "Info.plist"), "");
  return bundle;
}

/**
 * `ps -Aww -o pid=,ppid=,etime=,args=` for Xcode.app building a workspace:
 * the resident build service with compilers under it, whose arguments name
 * the DerivedData root. Pass no `workers` for the service sitting idle.
 */
export function xcodeAppPs(options: {
  servicePid: number;
  root?: string;
  workers?: number;
  /** The service has been up this long (`etime`). */
  serviceEtime?: string;
  extra?: string;
}): string {
  const service =
    "/Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService";
  const lines = [
    `    1     0 10-00:00:00 /sbin/launchd`,
    `  700     1 02:00:00 /Applications/Xcode.app/Contents/MacOS/Xcode`,
    `${String(options.servicePid).padStart(5)}   700 ${options.serviceEtime ?? "01:30:00"} ${service}`,
  ];
  for (let index = 0; index < (options.workers ?? 0); index += 1) {
    lines.push(
      `${String(9000 + index).padStart(5)} ${options.servicePid} 00:02 /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -frontend -c -primary-file /src/App/File${index}.swift -o ${options.root}/Build/Intermediates.noindex/App.build/Debug-iphonesimulator/App.build/Objects-normal/arm64/File${index}.o`,
    );
  }
  if (options.extra) lines.push(options.extra);
  return `${lines.join("\n")}\n`;
}
