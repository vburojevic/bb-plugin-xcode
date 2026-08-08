/**
 * Shared domain types for the Xcode activity tracker.
 *
 * Kept free of any `@bb/plugin-sdk` or node imports so the pure logic modules
 * that use them stay unit-testable without a bb server.
 */

export type { RunKind, RunStatus } from "./model";
import type { RunKind, RunStatus } from "./model";

/** How a DerivedData root came to our attention. */
export type RootDiscovery =
  | "process" // learned from a live compiler invocation
  | "default" // ~/Library/Developer/Xcode/DerivedData
  | "project-scan" // found by scanning a bb project worktree
  | "manual"; // user-configured via settings

export interface DerivedRoot {
  root: string;
  hostId: string | null;
  projectId: string | null;
  discoveredVia: RootDiscovery;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** A single Xcode process observed by the Tier 0 probe. */
export interface ObservedProcess {
  pid: number;
  ppid: number;
  /** Basename of the executable, e.g. `xcodebuild`, `swift-frontend`. */
  comm: string;
  /** Full argv as reported by `ps -Aww`. */
  args: string;
  /** Epoch ms the process started, parsed from `ps lstart`. */
  startedAt: number | null;
}

/**
 * A root activity: an observed process we treat as "one build", plus everything
 * we could attribute to it from its own args and its children's args.
 */
export interface ActivityAttribution {
  kind: RunKind;
  scheme: string | null;
  /** `-workspace` or `-project` path. */
  container: string | null;
  configuration: string | null;
  destination: string | null;
  derivedDataPath: string | null;
  resultBundlePath: string | null;
  /** Working directory, resolved via `lsof -d cwd`. */
  cwd: string | null;
  /** Git branch of the source checkout; resolved by the collector. */
  branch?: string | null;
  /** Checkout/worktree directory name; resolved by the collector. */
  worktree?: string | null;
}

export interface LiveActivity extends ActivityAttribution {
  pid: number;
  comm: string;
  args: string;
  startedAt: number;
  /** DerivedData roots seen in this activity's process subtree. */
  roots: string[];
  /** Live compiler/linker processes in the subtree (rough progress signal). */
  workerCount: number;
  /**
   * True for Xcode.app's resident build service rather than a one-shot
   * `xcodebuild`. Daemons need different lifecycle handling: they do not exit
   * when the build ends, they just go quiet.
   */
  isDaemon: boolean;
}

/** One entry from a `LogStoreManifest.plist` `logs` dict. */
export interface ManifestEntry {
  uniqueIdentifier: string;
  fileName: string | null;
  className: string | null;
  domainType: string | null;
  title: string | null;
  signature: string | null;
  /** Scheme container name, when Xcode recorded one. */
  containerName: string | null;
  /** Epoch ms (already converted from Apple reference date). */
  startedAt: number | null;
  endedAt: number | null;
  status: RunStatus;
  errorCount: number;
  warningCount: number;
  analyzerCount: number;
  testFailureCount: number;
}

export interface IssueRow {
  severity: "error" | "warning" | "analyzer" | "note";
  message: string;
  filePath: string | null;
  line: number | null;
  column: number | null;
  target: string | null;
}

export interface TestRow {
  suite: string | null;
  name: string;
  identifier: string | null;
  status: "passed" | "failed" | "skipped" | "expected-failure" | "unknown";
  durationMs: number | null;
  failureMessage: string | null;
  target: string | null;
}

/** Result of parsing an `.xcresult` build action. */
export interface BuildResults {
  status: RunStatus;
  startedAt: number | null;
  endedAt: number | null;
  errorCount: number;
  warningCount: number;
  analyzerCount: number;
  actionTitle: string | null;
  destination: string | null;
  issues: IssueRow[];
}

/** Result of parsing an `.xcresult` test action. */
export interface TestResults {
  status: RunStatus;
  startedAt: number | null;
  endedAt: number | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  expectedFailures: number;
  destination: string | null;
  tests: TestRow[];
}
