import { describe, expect, it } from "vitest";

import {
  dominantPhase,
  findRootActivities,
  isResolvingPackages,
  parsePsOutput,
  primarySourceFile,
} from "../src/proc";
import type { BuildPhase } from "../src/types";

const set = (...phases: BuildPhase[]) => new Set<BuildPhase>(phases);

describe("dominantPhase", () => {
  it("reports nothing when no worker is running", () => {
    expect(dominantPhase(set())).toBeNull();
  });

  it("reports the single phase in flight", () => {
    expect(dominantPhase(set("compiling"))).toBe("compiling");
    expect(dominantPhase(set("testing"))).toBe("testing");
  });

  /**
   * Targets finish at different times, so a build routinely has compilers and
   * a linker alive at once. Reporting "compiling" then understates how far
   * along it is — the frontier is the truer answer.
   */
  it("takes the latest phase when several overlap", () => {
    expect(dominantPhase(set("compiling", "linking"))).toBe("linking");
    expect(dominantPhase(set("compiling", "assets", "signing"))).toBe("signing");
    expect(dominantPhase(set("linking", "compiling"))).toBe("linking");
  });

  /**
   * Resolution precedes everything, so the moment real build work starts it
   * stops being the answer — but while it is alone it is the only answer
   * there is.
   */
  it("ranks resolving before any build work", () => {
    expect(dominantPhase(set("resolving"))).toBe("resolving");
    expect(dominantPhase(set("resolving", "compiling"))).toBe("compiling");
  });

  it("ranks packaging between linking and signing", () => {
    expect(dominantPhase(set("linking", "packaging"))).toBe("packaging");
    expect(dominantPhase(set("packaging", "signing"))).toBe("signing");
  });
});

describe("isResolvingPackages", () => {
  // Verbatim from `ps` on this machine, during the 7m37s resolve that showed
  // up nowhere.
  const RESOLVE =
    "/Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -resolvePackageDependencies -scmProvider system -clonedSourcePackagesDirPath .build/DerivedData/SourcePackages";
  const UNZIP =
    "unzip /Users/me/.bb/worktrees/env_x/indexed/ios/Index/.build/DerivedData/SourcePackages/prebuilts/swift-syntax/602.0.0/swiftlang-6.3.3.1.3.zip";

  it("recognises the invocation that IS a resolve", () => {
    expect(isResolvingPackages(RESOLVE)).toBe(true);
  });

  it("recognises resolution happening inside a build", () => {
    expect(isResolvingPackages(UNZIP)).toBe(true);
    expect(
      isResolvingPackages(
        "/usr/bin/git -C /w/.build/DerivedData/SourcePackages/checkouts/swift-log fetch",
      ),
    ).toBe(true);
  });

  /**
   * The SourcePackages path is what keeps this honest: a build shells out to
   * `git` and `unzip` for plenty of unrelated reasons.
   */
  it("does not claim every unzip and git is package work", () => {
    expect(isResolvingPackages("unzip /tmp/assets.zip -d /tmp/out")).toBe(false);
    expect(isResolvingPackages("/usr/bin/git rev-parse HEAD")).toBe(false);
    expect(
      isResolvingPackages(
        "/usr/bin/xcodebuild -workspace App.xcworkspace -scheme App build",
      ),
    ).toBe(false);
  });
});

describe("package resolution as a tracked run", () => {
  /**
   * The regression this whole change exists for. `-resolvePackageDependencies`
   * sat in the metadata-query list beside `-version`, so a resolve was never a
   * root candidate and never became a run — measured at 7m37s of a thread
   * appearing to do nothing.
   */
  it("tracks a standalone resolve and names its phase", () => {
    const stdout = [
      "900 1 07:31 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -resolvePackageDependencies -scmProvider system -clonedSourcePackagesDirPath /w/.build/DerivedData/SourcePackages",
      "901 900 00:04 unzip /w/.build/DerivedData/SourcePackages/prebuilts/swift-syntax/602.0.0/macros.zip",
    ].join("\n");

    const activities = findRootActivities(parsePsOutput(stdout, 2_000_000));
    expect(activities).toHaveLength(1);
    expect(activities[0]!.kind).toBe("package");
    expect(activities[0]!.phase).toBe("resolving");
  });

  it("still ignores the genuine metadata queries", () => {
    const stdout = [
      "910 1 00:02 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -version",
      "911 1 00:03 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -project A.xcodeproj -list",
    ].join("\n");
    expect(findRootActivities(parsePsOutput(stdout, 2_000_000))).toHaveLength(0);
  });

  it("reports resolving for a BUILD that is still fetching dependencies", () => {
    const stdout = [
      "920 1 02:00 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -workspace /w/App.xcworkspace -scheme App -derivedDataPath /w/dd build",
      "921 920 00:05 /usr/bin/git -C /w/dd/SourcePackages/checkouts/swift-log fetch",
    ].join("\n");

    const activities = findRootActivities(parsePsOutput(stdout, 2_000_000));
    expect(activities).toHaveLength(1);
    expect(activities[0]!.kind).toBe("build");
    // No compilers yet — without this the row would show a build doing nothing.
    expect(activities[0]!.workerCount).toBe(0);
    expect(activities[0]!.phase).toBe("resolving");
  });
});

describe("Xcode 26 build service", () => {
  /**
   * `XCBBuildService` does not exist on Xcode 26.6 — `XCBuild.framework` has no
   * XPCServices directory at all, and the service is `SWBBuildService` inside
   * `SwiftBuild.framework`. Command-line builds survived the rename by accident
   * (workers are attributed by walking up to the `xcodebuild` root, and the
   * service is just a link in that chain); an Xcode.app build, where the
   * service IS the root, was invisible outright.
   */
  const SERVICE =
    "/Applications/Xcode-26.6.0.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/MacOS/SWBBuildService";

  it("treats a busy SWBBuildService as an IDE build", () => {
    const stdout = [
      `500 1 05:00 ${SERVICE}`,
      "501 500 00:30 /Applications/Xcode-26.6.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -c -primary-file /w/A.swift -o /w/dd/Build/Intermediates.noindex/A.o",
    ].join("\n");

    const activities = findRootActivities(parsePsOutput(stdout, 2_000_000));
    expect(activities).toHaveLength(1);
    expect(activities[0]!.isDaemon).toBe(true);
    expect(activities[0]!.workerCount).toBe(1);
    expect(activities[0]!.phase).toBe("compiling");
  });

  it("still ignores the service while it sits idle between builds", () => {
    // Resident for the whole Xcode session. Treating its existence as a build
    // pinned a permanent phantom entry from the moment Xcode opened.
    const stdout = `500 1 05:00 ${SERVICE}`;
    expect(findRootActivities(parsePsOutput(stdout, 2_000_000))).toHaveLength(0);
  });

  it("does not count macro plugin servers as compilers", () => {
    // Ten of these ran alongside ten swift-frontend processes on this machine;
    // counting both would have reported twenty compilers for ten units of work.
    const stdout = [
      "600 1 01:00 /Applications/Xcode-26.6.0.app/Contents/Developer/usr/bin/xcodebuild -scheme App -derivedDataPath /w/dd build",
      "601 600 00:30 /Applications/Xcode-26.6.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-frontend -c -primary-file /w/A.swift",
      "602 600 00:30 /Applications/Xcode-26.6.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swift-plugin-server",
    ].join("\n");

    const activities = findRootActivities(parsePsOutput(stdout, 2_000_000));
    expect(activities[0]!.workerCount).toBe(1);
    expect(activities[0]!.phase).toBe("compiling");
  });
});

describe("primarySourceFile", () => {
  it("reads swift-frontend's explicit primary file", () => {
    expect(
      primarySourceFile(
        "/usr/bin/swift-frontend -frontend -c -primary-file /a/b/LocationCard.swift -module-name Otto",
      ),
    ).toBe("LocationCard.swift");
  });

  it("reads clang's single source argument", () => {
    expect(
      primarySourceFile("/usr/bin/clang -x objective-c -c /a/b/Bridge.m -o /t/Bridge.o"),
    ).toBe("Bridge.m");
  });

  /**
   * A wrong filename in the row is worse than none — it would name a file the
   * build is not on. Anything ambiguous returns null.
   */
  it("declines to guess", () => {
    // Several sources in one invocation: no single answer.
    expect(primarySourceFile("/usr/bin/clang -c /a/One.m /a/Two.m")).toBeNull();
    // Not a compiler at all.
    expect(primarySourceFile("/usr/bin/ld -o /t/App /t/One.o")).toBeNull();
    expect(primarySourceFile("/bin/sh ./scripts/build_app.sh build")).toBeNull();
    expect(primarySourceFile("")).toBeNull();
  });
});
