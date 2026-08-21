import { describe, expect, it } from "vitest";

import {
  activityKey,
  argv0,
  derivedRootsFromArgs,
  extractDerivedRoot,
  findRootActivities,
  parseEtime,
  parsePsOutput,
  parseXcodebuildArgs,
  tokenize,
} from "../src/proc";

/**
 * Fixtures below are real `ps` lines captured during actual builds on
 * Xcode 26.6, trimmed only for width.
 */
const XCODEBUILD =
  "/Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -scheme Demo -destination platform=macOS -derivedDataPath /tmp/x/dd build";
const SWIFT_DRIVER =
  "/Applications/Xcode-26.6.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-driver --driver-mode=swiftc -o /tmp/x/dd/Build/Intermediates.noindex/Demo.build/Debug/Demo.build/Objects-normal/arm64/Demo.o";

describe("parseEtime", () => {
  it("parses every ps elapsed format", () => {
    expect(parseEtime("05:31")).toBe(331_000);
    expect(parseEtime("13:13:11")).toBe(47_591_000);
    expect(parseEtime("01-17:13:23")).toBe(148_403_000);
  });

  it("returns null for junk", () => {
    expect(parseEtime("nonsense")).toBeNull();
  });
});

describe("parsePsOutput", () => {
  it("splits pid/ppid/etime/args even though args contain spaces", () => {
    const stdout = `  591  5573    05:31:58 ${XCODEBUILD}\n 1 0 01-17:13:23 /sbin/launchd\n`;
    const procs = parsePsOutput(stdout, 1_000_000_000);
    expect(procs).toHaveLength(2);
    expect(procs[0]!.pid).toBe(591);
    expect(procs[0]!.ppid).toBe(5573);
    expect(procs[0]!.comm).toBe("xcodebuild");
    expect(procs[0]!.startedAt).toBe(1_000_000_000 - 19_918_000);
  });

  it("ignores header and blank lines", () => {
    expect(parsePsOutput("\n  PID PPID ELAPSED ARGS\n")).toHaveLength(0);
  });
});

describe("argv0", () => {
  it("handles an Xcode.app path containing a space", () => {
    const args =
      "/Applications/Xcode 26.app/Contents/Developer/usr/bin/xcodebuild -scheme A build";
    expect(argv0(args)).toBe(
      "/Applications/Xcode 26.app/Contents/Developer/usr/bin/xcodebuild",
    );
  });

  it("falls back to the first token for unknown binaries", () => {
    expect(argv0("/usr/bin/node script.js")).toBe("/usr/bin/node");
  });
});

describe("extractDerivedRoot", () => {
  it("recovers the root from an intermediates path", () => {
    expect(
      extractDerivedRoot(
        "/tmp/x/dd/Build/Intermediates.noindex/Demo.build/Debug/Demo.o",
      ),
    ).toBe("/tmp/x/dd");
  });

  it("recovers the root from a products path", () => {
    expect(extractDerivedRoot("/a/b/dd/Build/Products/Debug/App.app")).toBe(
      "/a/b/dd",
    );
  });

  it("ignores unrelated paths", () => {
    expect(extractDerivedRoot("/usr/lib/libSystem.dylib")).toBeNull();
    expect(extractDerivedRoot("relative/Build/Products/x")).toBeNull();
  });

  it("finds roots anywhere in a full argv", () => {
    expect(derivedRootsFromArgs(SWIFT_DRIVER)).toEqual(["/tmp/x/dd"]);
  });
});

describe("parseXcodebuildArgs", () => {
  it("pulls scheme, destination, derived data and action", () => {
    const parsed = parseXcodebuildArgs(XCODEBUILD);
    expect(parsed.scheme).toBe("Demo");
    expect(parsed.destination).toBe("platform=macOS");
    expect(parsed.derivedDataPath).toBe("/tmp/x/dd");
    expect(parsed.kind).toBe("build");
  });

  it("prefers test when a command does both", () => {
    expect(parseXcodebuildArgs("xcodebuild -scheme A build test").kind).toBe(
      "test",
    );
  });

  it("reads workspace and result bundle", () => {
    const parsed = parseXcodebuildArgs(
      "xcodebuild -workspace /a/App.xcworkspace -scheme App -resultBundlePath /t/r.xcresult test",
    );
    expect(parsed.container).toBe("/a/App.xcworkspace");
    expect(parsed.resultBundlePath).toBe("/t/r.xcresult");
  });

  it("understands wrapper tools that carry JSON instead of flags", () => {
    // Captured from a real concurrent xcodebuildmcp invocation.
    const parsed = parseXcodebuildArgs(
      'node /opt/homebrew/bin/xcodebuildmcp --style minimal simulator build-and-run --json {"workspacePath": "Index.xcworkspace", "scheme": "Index Development"}',
    );
    expect(parsed.scheme).toBe("Index Development");
    expect(parsed.container).toBe("Index.xcworkspace");
    expect(parsed.kind).toBe("build");
  });

  it("does not treat a following flag as a value", () => {
    expect(parseXcodebuildArgs("xcodebuild -scheme -quiet build").scheme).toBeNull();
  });
});

describe("tokenize", () => {
  it("keeps quoted arguments together", () => {
    expect(tokenize(`xcodebuild -destination "platform=iOS Simulator,name=iPhone 16"`)).toEqual([
      "xcodebuild",
      "-destination",
      "platform=iOS Simulator,name=iPhone 16",
    ]);
  });
});

describe("findRootActivities", () => {
  const snapshot = (lines: string[]): string => lines.join("\n");

  it("reports one activity per build, not one per compiler process", () => {
    const stdout = snapshot([
      `100 1 00:10 ${XCODEBUILD}`,
      `101 100 00:05 ${SWIFT_DRIVER}`,
      `102 101 00:02 /Applications/Xcode-26.6.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang /tmp/x/dd/Build/Intermediates.noindex/a.o`,
    ]);
    const activities = findRootActivities(parsePsOutput(stdout, 1_000_000));
    expect(activities).toHaveLength(1);
    expect(activities[0]!.pid).toBe(100);
    expect(activities[0]!.scheme).toBe("Demo");
    // Children contribute their worker count and their DerivedData root.
    expect(activities[0]!.workerCount).toBe(2);
    expect(activities[0]!.roots).toContain("/tmp/x/dd");
  });

  it("separates concurrent builds from different projects", () => {
    const stdout = snapshot([
      `100 1 00:10 ${XCODEBUILD}`,
      `200 1 00:08 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -scheme Other -derivedDataPath /tmp/y/dd build`,
      `201 200 00:03 /Applications/Xcode-26.6.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang /tmp/y/dd/Build/Products/Debug/O.o`,
    ]);
    const activities = findRootActivities(parsePsOutput(stdout, 1_000_000));
    expect(activities.map((a) => a.scheme).sort()).toEqual(["Demo", "Other"]);
    const other = activities.find((a) => a.scheme === "Other")!;
    expect(other.roots).toContain("/tmp/y/dd");
  });
});

describe("findRootActivities — churn guards", () => {
  const XCBBS =
    "/Applications/Xcode-26.6.0.app/Contents/SharedFrameworks/XCBuild.framework/Versions/A/XPCServices/XCBBuildService.xpc/Contents/MacOS/XCBBuildService";

  /**
   * Regression: XCBBuildService is resident for the whole Xcode session. Being
   * treated as a build made the panel show a permanent phantom activity from
   * the moment Xcode opened.
   */
  it("ignores an idle build daemon", () => {
    const activities = findRootActivities(
      parsePsOutput(`300 1 10:00 ${XCBBS}`, 1_000_000),
    );
    expect(activities).toHaveLength(0);
  });

  it("reports the daemon once it has real compiler work", () => {
    const stdout = [
      `300 1 10:00 ${XCBBS}`,
      `301 300 00:02 /Applications/Xcode-26.6.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -o /tmp/dd/Build/Intermediates.noindex/a.o`,
    ].join("\n");
    const activities = findRootActivities(parsePsOutput(stdout, 1_000_000));
    expect(activities).toHaveLength(1);
    expect(activities[0]!.isDaemon).toBe(true);
    expect(activities[0]!.workerCount).toBe(1);
    expect(activities[0]!.roots).toContain("/tmp/dd");
  });

  /**
   * Regression: matching any process whose argv mentions "xcodebuild" made
   * long-lived wrappers and even greps register as builds that never ended.
   */
  it("does not treat a long-lived wrapper as a build", () => {
    const stdout = [
      `400 1 08:00 node /opt/homebrew/bin/xcodebuildmcp --style minimal serve`,
      `401 1 00:01 grep xcodebuild`,
      `402 1 00:01 /bin/bash -c 'xcodebuild -list'`,
    ].join("\n");
    expect(findRootActivities(parsePsOutput(stdout, 1_000_000))).toHaveLength(0);
  });

  it("tracks the real xcodebuild a wrapper spawned, inheriting its attribution", () => {
    const stdout = [
      `400 1 08:00 node /opt/homebrew/bin/xcodebuildmcp --json {"workspacePath": "Index.xcworkspace", "scheme": "Index Development"}`,
      `401 400 00:20 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -derivedDataPath /tmp/i/dd build`,
    ].join("\n");
    const activities = findRootActivities(parsePsOutput(stdout, 1_000_000));
    expect(activities).toHaveLength(1);
    expect(activities[0]!.pid).toBe(401);
    // The scheme lives only on the wrapper's argv.
    expect(activities[0]!.scheme).toBe("Index Development");
    expect(activities[0]!.container).toBe("Index.xcworkspace");
  });

  it("does not double-count a build running under the daemon", () => {
    const stdout = [
      `300 1 10:00 ${XCBBS}`,
      `100 300 00:10 ${XCODEBUILD}`,
      `101 100 00:05 ${SWIFT_DRIVER}`,
    ].join("\n");
    const activities = findRootActivities(parsePsOutput(stdout, 1_000_000));
    expect(activities.map((a) => a.pid)).toEqual([300]);
  });
});

describe("activityKey", () => {
  /**
   * Regression: keying on pid + derived start time duplicated a run mid-build,
   * because `ps etime` only has whole-second resolution so `now - elapsed`
   * drifts between ticks.
   */
  it("is stable when the derived start time drifts between ticks", () => {
    const line = `100 1 00:10 ${XCODEBUILD}`;
    const tickA = findRootActivities(parsePsOutput(line, 1_000_000))[0]!;
    const tickB = findRootActivities(parsePsOutput(line, 1_000_900))[0]!;
    expect(tickB.startedAt).not.toBe(tickA.startedAt);
    expect(activityKey(tickB)).toBe(activityKey(tickA));
  });
});

describe("metadata queries are not builds (regression)", () => {
  it("ignores -list / -version / -showBuildSettings invocations", () => {
    const stdout = [
      `500 1 00:11 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -project Almanac.xcodeproj -list`,
      `501 1 00:02 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -version`,
      `502 1 00:02 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -scheme A -showBuildSettings`,
    ].join("\n");
    expect(findRootActivities(parsePsOutput(stdout, 1_000_000))).toHaveLength(0);
  });

  it("still tracks a real build that also passes query-ish flags", () => {
    const stdout = `600 1 00:11 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -scheme A -destination platform=macOS build`;
    expect(findRootActivities(parsePsOutput(stdout, 1_000_000))).toHaveLength(1);
  });
});
