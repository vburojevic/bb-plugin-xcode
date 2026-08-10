/**
 * Tier 0 — live process observation.
 *
 * Pure parsing/attribution logic. Nothing here shells out; the caller supplies
 * `ps` output so this whole module is unit-testable.
 *
 * Field choice matters: `lstart` and `args` both contain spaces, so a single
 * `ps` line with both cannot be split unambiguously. `etime` has no spaces, so
 * `pid,ppid,etime,args` is the one combination that parses cleanly.
 */

import type {
  ActivityAttribution,
  LiveActivity,
  ObservedProcess,
  RunKind,
} from "./types";

/** The `ps` invocation this module's parser expects. */
export const PS_ARGS = ["-Aww", "-o", "pid=,ppid=,etime=,args="] as const;

/**
 * Executables that mean "Xcode is doing something". Matched on the basename of
 * argv[0], so a toolchain living in a non-default Xcode.app still matches.
 */
const TOOLCHAIN_BINARIES = new Set([
  "xcodebuild",
  "XCBBuildService",
  "swift-frontend",
  "swift-driver",
  "swiftc",
  "swift",
  "clang",
  "clang++",
  "ld",
  "ld64",
  "libtool",
  "actool",
  "ibtool",
  "xctest",
  "xctestrun",
  "swift-testing",
  "clang-stat-cache",
  "SwiftCompile",
  "swift-symbolgraph-extract",
]);

/**
 * The only two processes ever treated as "a build".
 *
 * Wrapper tools (xcodebuildmcp, fastlane, CI scripts) are deliberately NOT
 * roots even though their argv mentions xcodebuild: they are long-lived servers
 * or shells that outlive the build, so treating them as roots produced phantom
 * activity that never ended. They spawn a real `xcodebuild`, which is what gets
 * tracked; their argv is still mined for attribution via the parent chain.
 */
const DIRECT_ROOT = "xcodebuild";

/**
 * Xcode.app's build service. Unlike `xcodebuild` it is a *persistent daemon*:
 * it stays resident for the whole Xcode session, idle between builds. Treating
 * its mere existence as a running build pinned a permanent fake entry to the
 * panel, so it counts only while it has real compiler work underneath it.
 */
const DAEMON_ROOT = "XCBBuildService";

/**
 * Processes that prove actual compilation is happening right now.
 *
 * Used to decide whether the build daemon is genuinely busy.
 */
const WORKER_BINARIES = new Set([
  "swift-frontend",
  "swift-driver",
  "swiftc",
  "clang",
  "clang++",
  "ld",
  "ld64",
  "libtool",
  "actool",
  "ibtool",
  "xctest",
  "swift-symbolgraph-extract",
]);

/**
 * Which action speaks for a multi-action invocation. A test outranks a build,
 * a build outranks the clean or package-resolve that precedes it, and
 * anything outranks "unknown".
 */
function actionRank(kind: RunKind): number {
  switch (kind) {
    case "test":
      return 5;
    case "archive":
      return 4;
    case "build":
    case "analyze":
    case "docbuild":
    case "install":
    case "export":
      return 3;
    case "clean":
      return 2;
    case "package":
    case "index":
      return 1;
    case "unknown":
      return 0;
  }
}

/** xcodebuild action verbs, used to classify a run and to spot the action in argv. */
const ACTION_VERBS: Record<string, RunKind> = {
  build: "build",
  "build-for-testing": "build",
  test: "test",
  "test-without-building": "test",
  archive: "archive",
  clean: "clean",
  analyze: "analyze",
  install: "install",
  installsrc: "install",
  exportArchive: "export",
  docbuild: "docbuild",
  "-resolvePackageDependencies": "package",
};

/** Parse `ps` elapsed time (`[[dd-]hh:]mm:ss`) into milliseconds. */
export function parseEtime(etime: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return null;
  const [, dd, hh, mm, ss] = match;
  const days = dd ? Number(dd) : 0;
  const hours = hh ? Number(hh) : 0;
  const minutes = Number(mm);
  const seconds = Number(ss);
  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}

/**
 * Split a `ps -o pid=,ppid=,etime=,args=` dump into structured rows.
 *
 * `now` is injected so callers (and tests) control the clock used to turn
 * elapsed time back into an absolute start timestamp.
 */
export function parsePsOutput(
  stdout: string,
  now: number = Date.now(),
): ObservedProcess[] {
  const out: ObservedProcess[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pidText, ppidText, etime, args] = match;
    if (!args) continue;
    const elapsedMs = parseEtime(etime);
    out.push({
      pid: Number(pidText),
      ppid: Number(ppidText),
      comm: basename(argv0(args)),
      args,
      startedAt: elapsedMs === null ? null : now - elapsedMs,
    });
  }
  return out;
}

/**
 * argv[0] of a `ps` args string.
 *
 * Executable paths may contain spaces (`/Applications/Xcode 26.app/...`), so a
 * naive split on whitespace is wrong. Xcode's own toolchain paths never do, but
 * a user-renamed Xcode.app does — prefer the longest prefix that looks like a
 * path to a known toolchain binary, else fall back to the first token.
 */
export function argv0(args: string): string {
  const first = args.split(" ")[0] ?? args;
  if (!args.startsWith("/")) return first;
  // Walk candidate split points, longest first, and accept one whose basename
  // is a binary we recognize. This rescues "/Applications/Xcode 26.app/...".
  let index = args.indexOf(" ");
  const candidates: string[] = [];
  while (index !== -1) {
    candidates.push(args.slice(0, index));
    index = args.indexOf(" ", index + 1);
  }
  candidates.push(args);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = candidates[i]!;
    if (TOOLCHAIN_BINARIES.has(basename(candidate))) return candidate;
  }
  return first;
}

export function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}

export function isToolchainProcess(proc: ObservedProcess): boolean {
  if (TOOLCHAIN_BINARIES.has(proc.comm)) return true;
  // Wrappers such as xcodebuildmcp drive builds without being toolchain
  // binaries themselves; catch them by their argv mentioning xcodebuild.
  return /\bxcodebuild\b/.test(proc.args) && !proc.args.includes("grep ");
}

/**
 * Extract a DerivedData root from any single argument.
 *
 * Validated against real compiler invocations: every intermediate/product path
 * is `<ROOT>/Build/Intermediates.noindex/...` or `<ROOT>/Build/Products/...`.
 * This is what makes root discovery work for *any* project with no config.
 */
export function extractDerivedRoot(arg: string): string | null {
  const match = /^(.*?)\/Build\/(?:Intermediates\.noindex|Products)(?:\/|$)/.exec(
    arg,
  );
  if (match && match[1] && match[1].startsWith("/")) return match[1];
  return null;
}

/** Every DerivedData root mentioned anywhere in a process's argv. */
export function derivedRootsFromArgs(args: string): string[] {
  const roots = new Set<string>();
  for (const token of tokenize(args)) {
    const root = extractDerivedRoot(token);
    if (root) roots.add(root);
  }
  return [...roots];
}

/**
 * Split an args string into tokens, honouring the quoting `ps` shows for
 * arguments that contain spaces. Good enough for path extraction — this is not
 * a shell parser.
 */
export function tokenize(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of args) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === " ") {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Value of a `-flag value` pair in a token list. */
function flagValue(tokens: string[], flag: string): string | null {
  const index = tokens.indexOf(flag);
  if (index === -1 || index + 1 >= tokens.length) return null;
  const value = tokens[index + 1]!;
  return value.startsWith("-") ? null : value;
}

/**
 * A flag value that may span several tokens. `ps` strips shell quoting, so
 * `-destination 'generic/platform=iOS Simulator'` arrives as two tokens;
 * rejoin until the next flag or action verb (`build`, `test`, …), bounded.
 */
function flagValuePhrase(tokens: string[], flag: string): string | null {
  const index = tokens.indexOf(flag);
  if (index === -1 || index + 1 >= tokens.length) return null;
  const first = tokens[index + 1]!;
  if (first.startsWith("-")) return null;
  const parts = [first];
  for (
    let cursor = index + 2;
    cursor < tokens.length && parts.length < 5;
    cursor++
  ) {
    const token = tokens[cursor]!;
    if (token.startsWith("-") || token in ACTION_VERBS) break;
    parts.push(token);
  }
  return parts.join(" ");
}

/**
 * Pull everything we can out of an `xcodebuild` command line.
 *
 * Also handles wrappers (xcodebuildmcp and friends) that embed a JSON blob
 * rather than passing real flags.
 */
export function parseXcodebuildArgs(args: string): ActivityAttribution {
  const tokens = tokenize(args);

  // One invocation can carry several actions (`clean build`, `build test`).
  // Report the one whose outcome the developer cares about, by precedence —
  // NOT the first seen. `clean build` classified as a clean, which then let
  // the clean phase's own log entry deliver a "passed" verdict while the
  // build was still compiling (observed live on 2026-08-10).
  let kind: RunKind = "unknown";
  for (const token of tokens) {
    const verb = ACTION_VERBS[token];
    if (verb && actionRank(verb) > actionRank(kind)) kind = verb;
  }

  const container =
    flagValue(tokens, "-workspace") ?? flagValue(tokens, "-project");

  const attribution: ActivityAttribution = {
    kind,
    scheme: flagValue(tokens, "-scheme"),
    container,
    configuration: flagValue(tokens, "-configuration"),
    destination: flagValuePhrase(tokens, "-destination"),
    derivedDataPath: flagValue(tokens, "-derivedDataPath"),
    resultBundlePath: flagValue(tokens, "-resultBundlePath"),
    cwd: null,
  };

  if (!attribution.scheme || !attribution.container) {
    const fromJson = parseWrapperJson(args);
    attribution.scheme ??= fromJson.scheme;
    attribution.container ??= fromJson.container;
    if (attribution.kind === "unknown" && fromJson.kind !== "unknown") {
      attribution.kind = fromJson.kind;
    }
  }

  return attribution;
}

/**
 * Wrapper tools (e.g. `xcodebuildmcp ... --json {"workspacePath": ...}`) carry
 * their intent in an embedded JSON object rather than xcodebuild flags.
 */
function parseWrapperJson(args: string): {
  scheme: string | null;
  container: string | null;
  kind: RunKind;
} {
  const empty = { scheme: null, container: null, kind: "unknown" as RunKind };
  const start = args.indexOf("{");
  if (start === -1) return empty;
  const candidate = args.slice(start, args.lastIndexOf("}") + 1);
  if (!candidate.endsWith("}")) return empty;
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const str = (key: string): string | null =>
      typeof parsed[key] === "string" ? (parsed[key] as string) : null;
    let kind: RunKind = "unknown";
    if (/\btest\b/.test(args)) kind = "test";
    else if (/\bbuild\b/.test(args)) kind = "build";
    return {
      scheme: str("scheme"),
      container: str("workspacePath") ?? str("projectPath"),
      kind,
    };
  } catch {
    return empty;
  }
}

/**
 * Reduce a process snapshot to the set of root activities, each carrying the
 * DerivedData roots and worker count harvested from its subtree.
 *
 * A process is a root when it can start builds and no ancestor already is one —
 * that keeps a single `xcodebuild` from being reported once per child compiler.
 */
export function findRootActivities(procs: ObservedProcess[]): LiveActivity[] {
  const byPid = new Map<number, ObservedProcess>();
  for (const proc of procs) byPid.set(proc.pid, proc);

  // Metadata queries are not builds: `xcodebuild -list` still spawns a real
  // xcodebuild process (often for many seconds while packages resolve), and
  // tracking it produced phantom "unknown" runs in the panel.
  const isQueryInvocation = (proc: ObservedProcess): boolean =>
    proc.comm === DIRECT_ROOT &&
    /\s-(list|version|showsdks|showdestinations|showBuildSettings|showComponent|usage|help|exportLocalizations|resolvePackageDependencies)\b/.test(
      proc.args,
    ) &&
    !Object.keys(ACTION_VERBS).some(
      (verb) => !verb.startsWith("-") && tokenize(proc.args).includes(verb),
    );

  const isRootCandidate = (proc: ObservedProcess): boolean =>
    (proc.comm === DIRECT_ROOT || proc.comm === DAEMON_ROOT) &&
    !isQueryInvocation(proc);

  const hasToolchainAncestor = (proc: ObservedProcess): boolean => {
    const seen = new Set<number>([proc.pid]);
    let cursor = byPid.get(proc.ppid);
    while (cursor && !seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      if (isRootCandidate(cursor)) return true;
      cursor = byPid.get(cursor.ppid);
    }
    return false;
  };

  const roots = procs.filter(
    (proc) => isRootCandidate(proc) && !hasToolchainAncestor(proc),
  );

  // Map every process to its owning root so workers contribute their args
  // (and therefore their DerivedData paths) to the right activity.
  const rootPids = new Set(roots.map((proc) => proc.pid));
  const ownerOf = new Map<number, number>();
  const resolveOwner = (proc: ObservedProcess): number | null => {
    if (rootPids.has(proc.pid)) return proc.pid;
    const cached = ownerOf.get(proc.pid);
    if (cached !== undefined) return cached;
    const seen = new Set<number>([proc.pid]);
    let cursor = byPid.get(proc.ppid);
    while (cursor && !seen.has(cursor.pid)) {
      seen.add(cursor.pid);
      if (rootPids.has(cursor.pid)) {
        ownerOf.set(proc.pid, cursor.pid);
        return cursor.pid;
      }
      cursor = byPid.get(cursor.ppid);
    }
    return null;
  };

  const rootsByPid = new Map<number, { roots: Set<string>; workers: number }>();
  for (const pid of rootPids) {
    rootsByPid.set(pid, { roots: new Set(), workers: 0 });
  }
  for (const proc of procs) {
    const owner = resolveOwner(proc);
    if (owner === null) continue;
    const bucket = rootsByPid.get(owner)!;
    if (proc.pid !== owner && WORKER_BINARIES.has(proc.comm)) bucket.workers += 1;
    for (const root of derivedRootsFromArgs(proc.args)) bucket.roots.add(root);
  }

  return roots.flatMap((proc) => {
    const bucket = rootsByPid.get(proc.pid)!;
    const isDaemon = proc.comm === DAEMON_ROOT;

    // An idle build daemon is not a build. Xcode keeps XCBBuildService resident
    // for the whole session, so without this it would report a build in
    // progress from the moment Xcode opens until it quits.
    if (isDaemon && bucket.workers === 0 && bucket.roots.size === 0) return [];

    const attribution = parseXcodebuildArgs(proc.args);
    if (attribution.derivedDataPath) bucket.roots.add(attribution.derivedDataPath);

    // A wrapper (xcodebuildmcp, a CI script) is never a root itself, but its
    // argv often names the scheme and workspace that the spawned xcodebuild
    // does not — so borrow attribution from the nearest ancestor that has it.
    if (!attribution.scheme || !attribution.container) {
      const inherited = inheritFromAncestors(proc, byPid);
      attribution.scheme ??= inherited.scheme;
      attribution.container ??= inherited.container;
    }

    return [
      {
        ...attribution,
        pid: proc.pid,
        comm: proc.comm,
        args: proc.args,
        startedAt: proc.startedAt ?? Date.now(),
        roots: [...bucket.roots],
        workerCount: bucket.workers,
        isDaemon,
      },
    ];
  });
}

/** Walk up the process tree for scheme/container a wrapper knows but we don't. */
function inheritFromAncestors(
  proc: ObservedProcess,
  byPid: Map<number, ObservedProcess>,
): { scheme: string | null; container: string | null } {
  const seen = new Set<number>([proc.pid]);
  let cursor = byPid.get(proc.ppid);
  let depth = 0;
  while (cursor && !seen.has(cursor.pid) && depth < 4) {
    seen.add(cursor.pid);
    depth += 1;
    if (/xcodebuild|xcworkspace|xcodeproj|-scheme/.test(cursor.args)) {
      const parsed = parseXcodebuildArgs(cursor.args);
      if (parsed.scheme || parsed.container) {
        return { scheme: parsed.scheme, container: parsed.container };
      }
    }
    cursor = byPid.get(cursor.ppid);
  }
  return { scheme: null, container: null };
}

/**
 * Stable identity for a live activity across probe ticks.
 *
 * The pid alone. It is tempting to pair it with the start time to guard against
 * pid reuse, but `ps etime` has whole-second resolution: `startedAt` is derived
 * as `now - elapsed`, so it drifts by up to a second between ticks and a
 * composite key would mint a fresh identity mid-build, duplicating the run.
 *
 * Reuse is not a real risk here: the tracker drops a pid the moment it leaves
 * the snapshot, so a recycled pid is always seen as new.
 */
export function activityKey(activity: LiveActivity): string {
  return String(activity.pid);
}
