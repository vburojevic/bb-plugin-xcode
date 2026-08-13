/**
 * The onboarder, asserted on its **dry-run output text** and never on a
 * mutation.
 *
 * Every emitted string is templated from the detector. A draft printed
 * `TEST_HOST = $(BUILT_PRODUCTS_DIR)/App.app/…/App` as a literal; shipped into
 * the manual steps for a raw `.xcodeproj` — the commonest project shape — every
 * stranger whose target is not called `App` pastes a broken setting and gets a
 * green run with zero previews. So there is a golden assertion per shape on the
 * substituted `TEST_HOST`, target, scheme and class name.
 */
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  buildPlan,
  chooseAppTarget,
  chooseScheme,
  describeDetection,
  existingDependency,
  findCandidates,
  findSnapshotTestTarget,
  targetPool,
  packageDependencyLine,
  rankCandidates,
  shapeOf,
  SNAPSHOT_PREVIEWS_VERSION,
  TEST_CLASS_NAME,
  testFileContents,
  testHostSetting,
  type DetectedProject,
} from "../../src/sim/onboard.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/projects", import.meta.url));

function project(over: Partial<DetectedProject> = {}): DetectedProject {
  return {
    shape: "xcodeproj",
    relPath: "App.xcodeproj",
    schemes: ["Almanac"],
    targets: ["Almanac", "AlmanacTests"],
    scheme: "Almanac",
    appTarget: "Almanac",
    snapshotTestTarget: null,
    ...over,
  };
}

describe("recognising a project", () => {
  it("knows every shape by its filename", () => {
    expect(shapeOf("App.xcworkspace")).toBe("xcworkspace");
    expect(shapeOf("App.xcodeproj")).toBe("xcodeproj");
    expect(shapeOf("Package.swift")).toBe("spm");
    expect(shapeOf("project.yml")).toBe("xcodegen");
    expect(shapeOf("Project.swift")).toBe("tuist");
    expect(shapeOf("README.md")).toBeNull();
  });

  it("finds a project two levels deep, where cross-platform repos keep theirs", async () => {
    // React Native, Expo, Flutter and Capacitor all keep it at
    // ios/App.xcworkspace, and a monorepo keeps it at apps/ios-client/…. A
    // detector that only looks at the root tells the majority of cross-platform
    // iOS developers "no Xcode project" with no field to correct it.
    const candidates = await findCandidates(FIXTURES);
    const paths = candidates.map((candidate) => candidate.relPath);
    expect(paths).toContain("spm/Package.swift");
    expect(paths).toContain("xcodegen/project.yml");
    expect(paths).toContain("raw/App.xcodeproj");
  });

  it("never descends into an .xcodeproj, which is a directory", async () => {
    const candidates = await findCandidates(FIXTURES);
    expect(candidates.every((candidate) => !candidate.relPath.includes(".xcodeproj/"))).toBe(true);
  });

  it("ranks a workspace above a project and a shallow path above a deep one", () => {
    const ranked = rankCandidates([
      { shape: "spm", relPath: "a/b/Package.swift" },
      { shape: "xcodeproj", relPath: "App.xcodeproj" },
      { shape: "xcworkspace", relPath: "App.xcworkspace" },
    ]);
    expect(ranked.map((candidate) => candidate.relPath)).toEqual([
      "App.xcworkspace",
      "App.xcodeproj",
      "a/b/Package.swift",
    ]);
  });
});

describe("choosing a scheme", () => {
  it("takes the only one, and refuses to guess among twelve", () => {
    expect(chooseScheme(["Only"], "")).toBe("Only");
    expect(chooseScheme(["A", "B"], "")).toBeNull();
    expect(chooseScheme(["A", "B"], "B")).toBe("B");
    // A configured scheme that is not there is a refusal, not a fallback.
    expect(chooseScheme(["A", "B"], "Gone")).toBeNull();
  });
});

describe("choosing the app target", () => {
  it("skips targets named like tests", () => {
    expect(chooseAppTarget(["Almanac", "AlmanacTests", "AlmanacUITests"], "Almanac")).toBe("Almanac");
  });

  it("prefers the one matching the scheme", () => {
    expect(chooseAppTarget(["Widgets", "Almanac"], "Almanac")).toBe("Almanac");
  });

  it("prefers an app over a framework when nothing else decides", () => {
    expect(chooseAppTarget(["AlmanacKit", "Almanac"], null)).toBe("Almanac");
  });

  it("answers null rather than nominating a test target", () => {
    expect(chooseAppTarget(["AlmanacTests"], null)).toBeNull();
  });

  it("recognises an existing snapshot target", () => {
    expect(findSnapshotTestTarget(["Almanac", "AlmanacPreviewTests"])).toBe("AlmanacPreviewTests");
    expect(findSnapshotTestTarget(["Almanac", "AlmanacTests"])).toBeNull();

    // A workspace reports schemes and no targets at all, so the schemes are
    // where the test target's name actually is.
    expect(targetPool(undefined, [], ["Almanac", "AlmanacPreviewTests"])).toEqual([
      "Almanac",
      "AlmanacPreviewTests",
    ]);
    // SwiftPM knows which targets are tests; that answer is not a guess.
    expect(targetPool(["PkgTests"], ["Pkg", "PkgTests"], ["Pkg"])).toEqual(["PkgTests"]);
    // An empty test-target list is an answer too: no tests, not "go look at the schemes".
    expect(targetPool([], [], ["Almanac", "AlmanacPreviewTests"])).toEqual([]);
    expect(targetPool(undefined, ["Almanac", "AlmanacPreviewTests"], ["Nope"])).toEqual([
      "Almanac",
      "AlmanacPreviewTests",
    ]);
  });
});

describe("the emitted strings", () => {
  it("substitutes TEST_HOST from the detected target", () => {
    // This is the string that silently breaks a run when it is wrong: an
    // incorrect test host produces an unhosted test, which renders nothing and
    // reports success.
    expect(testHostSetting("Almanac")).toBe(
      "$(BUILT_PRODUCTS_DIR)/Almanac.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/Almanac",
    );
    expect(testHostSetting("Ferrybox")).toContain("Ferrybox.app");
    expect(testHostSetting("Ferrybox")).not.toContain("App.app");
  });

  it("pins by tag rather than by a bare revision", () => {
    // v0.18.0 contains every file the design said lived only on main, and the
    // specified revision is two non-code commits past it. A tag survives a
    // force-push and means something to a stranger reading their own manifest.
    expect(packageDependencyLine()).toBe(
      `.package(url: "https://github.com/EmergeTools/SnapshotPreviews", exact: "${SNAPSHOT_PREVIEWS_VERSION}")`,
    );
    expect(SNAPSHOT_PREVIEWS_VERSION).toBe("0.18.0");
  });

  it("names the app in the file it writes, so the hosting requirement is on screen", () => {
    const contents = testFileContents("Almanac");
    expect(contents).toContain(`final class ${TEST_CLASS_NAME}: SnapshotTest {}`);
    expect(contents).toContain("hosted unit test");
    expect(contents).toContain("Almanac");
    // Unhosted logic tests never load the app binary.
    expect(contents).toContain("green run with zero previews");
  });
});

describe("the plan, per shape", () => {
  it("edits the manifest for a Swift package", () => {
    const plan = buildPlan({
      checkoutPath: "/repo",
      project: project({ shape: "spm", relPath: "Package.swift", appTarget: "Almanac" }),
      candidate: { shape: "spm", relPath: "Package.swift" },
      existing: { present: false, version: null },
    });
    expect(plan.manualSteps[0]).toContain("Package.swift");
    expect(plan.manualSteps[0]).toContain(packageDependencyLine());
    expect(plan.files[0]?.relPath).toBe(`Tests/AlmanacPreviewTests/${TEST_CLASS_NAME}.swift`);
  });

  it("tells XcodeGen and Tuist to regenerate", () => {
    const xcodegen = buildPlan({
      checkoutPath: "/repo",
      project: project({ shape: "xcodegen", relPath: "project.yml", appTarget: "Ferrybox" }),
      candidate: { shape: "xcodegen", relPath: "project.yml" },
      existing: { present: false, version: null },
    });
    expect(xcodegen.manualSteps.join("\n")).toContain("xcodegen generate");
    expect(xcodegen.manualSteps.join("\n")).toContain("Ferrybox");

    const tuist = buildPlan({
      checkoutPath: "/repo",
      project: project({ shape: "tuist", relPath: "Project.swift", appTarget: "Ferrybox" }),
      candidate: { shape: "tuist", relPath: "Project.swift" },
      existing: { present: false, version: null },
    });
    expect(tuist.manualSteps.join("\n")).toContain("tuist generate");
  });

  it("prints the substituted TEST_HOST for a raw project rather than a literal", () => {
    const plan = buildPlan({
      checkoutPath: "/repo",
      project: project({ appTarget: "Ferrybox" }),
      candidate: { shape: "xcodeproj", relPath: "App.xcodeproj" },
      existing: { present: false, version: null },
    });
    const steps = plan.manualSteps.join("\n");
    expect(steps).toContain("$(BUILT_PRODUCTS_DIR)/Ferrybox.app/");
    expect(steps).not.toContain("/App.app/");
    // It never rewrites project.pbxproj: a rewrite that goes wrong costs the
    // user their project file, and the manual path is ninety seconds.
    expect(steps).not.toContain("pbxproj");
  });

  it("always asks for the previews env var and a Debug-ish configuration", () => {
    const steps = buildPlan({
      checkoutPath: "/repo",
      project: project(),
      candidate: { shape: "xcodeproj", relPath: "App.xcodeproj" },
      existing: { present: false, version: null },
    }).manualSteps.join("\n");
    expect(steps).toContain("SNAPSHOTS_RUNNING_FOR_PREVIEWS=1");
    expect(steps).toContain("whole-module optimization does not strip");
  });
});

describe("a project that already depends on SnapshotPreviews", () => {
  it("reports the conflict and edits nothing", async () => {
    // SwiftPM's resolution failure is an error nobody would connect to this
    // plugin.
    const existing = await existingDependency(`${FIXTURES}/conflict`, {
      shape: "spm",
      relPath: "Package.swift",
    });
    expect(existing).toEqual({ present: true, version: "0.9.4" });

    const plan = buildPlan({
      checkoutPath: `${FIXTURES}/conflict`,
      project: project({ shape: "spm", relPath: "Package.swift" }),
      candidate: { shape: "spm", relPath: "Package.swift" },
      existing,
    });
    expect(plan.conflict).toContain("0.9.4");
    expect(plan.conflict).toContain(SNAPSHOT_PREVIEWS_VERSION);
    expect(plan.files).toEqual([]);
  });

  it("says nothing when the versions already agree", async () => {
    const plan = buildPlan({
      checkoutPath: "/repo",
      project: project(),
      candidate: { shape: "spm", relPath: "Package.swift" },
      existing: { present: true, version: SNAPSHOT_PREVIEWS_VERSION },
    });
    expect(plan.conflict).toBeNull();
    expect(plan.alreadyDone[0]).toContain("already depends on SnapshotPreviews");
  });

  it("finds no dependency in a project that has none", async () => {
    const existing = await existingDependency(`${FIXTURES}/spm`, {
      shape: "spm",
      relPath: "Package.swift",
    });
    expect(existing).toEqual({ present: false, version: null });
  });
});

describe("the un-onboarded sentence", () => {
  it("names what was found rather than what is missing", () => {
    // "This project has no snapshot target" is a dead end.
    expect(describeDetection(project())).toBe(
      "Found App.xcodeproj with one scheme, Almanac and an app target called Almanac. Stills needs a unit-test target linking SnapshottingTests; there is none yet.",
    );
  });

  it("says the opposite when there already is one", () => {
    // Telling someone their configured project needs configuring is the kind of
    // wrongness that makes them stop believing the rest of the sentence.
    expect(describeDetection(project({ snapshotTestTarget: "AlmanacPreviewTests" }))).toContain(
      "AlmanacPreviewTests links SnapshottingTests, so Stills can run here.",
    );
  });

  it("counts schemes rather than listing twelve", () => {
    expect(describeDetection(project({ schemes: ["A", "B", "C"], scheme: null }))).toContain(
      "with 3 schemes",
    );
  });
});
