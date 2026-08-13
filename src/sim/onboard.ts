/**
 * What Stills asks of a repo, detected rather than assumed.
 *
 * Live costs a repo nothing — a booted simulator is enough. Stills is the
 * opposite: SnapshotPreviews walks loaded dyld images for `__swift5_proto`
 * conformances, so the app binary has to be loaded into an XCTest runner
 * process. There is no library entry point that renders a directory of
 * previews, and building one means reimplementing `SnapshotTest`,
 * `FileNameResolver` and `SnapshotCIExportCoordinator` — all internal — and
 * owning filename compatibility forever.
 *
 * **Every emitted string is templated from the detector.** A draft of this
 * printed `TEST_HOST = $(BUILT_PRODUCTS_DIR)/App.app/…/App` as a literal; ship
 * that into the manual steps for a raw `.xcodeproj` — the commonest project
 * shape — and every stranger whose target is not called `App` pastes a broken
 * setting and gets a green run with zero previews.
 *
 * **It does not rewrite `project.pbxproj`.** Vendoring an XcodeProj library and
 * mutating it was the alternative: a pbxproj rewrite that goes wrong costs the
 * user their project file, the blast radius is unbounded, and the manual path
 * is ninety seconds in a dialog they have opened a hundred times.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { runJson } from "./exec.js";

/**
 * The pinned SnapshotPreviews version, in one place so
 * moving it is a one-line change here and a one-line change in the
 * consuming manifest.
 *
 * A **tag**, not a bare commit. The design specified a revision on the grounds
 * that the newest tag lacked the export machinery; that was stale. `v0.18.0`
 * contains every file involved, the specified revision is two non-code commits
 * past it, and `git diff` over the Swift sources between them is empty. A tag
 * survives a force-push, reviews in a pull request, and means something to a
 * stranger reading their own `Package.swift`.
 */
export const SNAPSHOT_PREVIEWS_VERSION = "0.18.0";
export const SNAPSHOT_PREVIEWS_URL = "https://github.com/EmergeTools/SnapshotPreviews";

/** The class the onboarder writes. Greppable, and unlikely to collide. */
export const TEST_CLASS_NAME = "BBPreviewSnapshotTests";

export type ProjectShape = "spm" | "xcodegen" | "tuist" | "xcodeproj" | "xcworkspace" | "unknown";

export interface DetectedProject {
  shape: ProjectShape;
  /** Checkout-relative path to the manifest or project file. */
  relPath: string;
  /** Schemes `xcodebuild -list` reported, in its order. */
  schemes: string[];
  targets: string[];
  /** The scheme a run would use, or `null` when it cannot be chosen for you. */
  scheme: string | null;
  /** The app target whose product hosts the tests, when one is obvious. */
  appTarget: string | null;
  /** A test target already linking SnapshottingTests, if there is one. */
  snapshotTestTarget: string | null;
}

/**
 * Where the project is.
 *
 * Two levels deep, not just the checkout root. React Native, Expo, Flutter and
 * Capacitor keep their project at `ios/App.xcworkspace`, and a monorepo keeps
 * it at `apps/ios-client/…`. A detector that only looks at the root tells the
 * majority of cross-platform iOS developers "no Xcode project" with no field to
 * correct it.
 */
export const SEARCH_DEPTH = 2;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".build",
  "build",
  "DerivedData",
  "Pods",
  "vendor",
  ".yarn",
  "dist",
]);

export interface Candidate {
  shape: ProjectShape;
  relPath: string;
}

/** Rank candidates so the one a person means is first. */
export function rankCandidates(candidates: readonly Candidate[]): Candidate[] {
  const shapeRank: Record<ProjectShape, number> = {
    xcworkspace: 0,
    xcodeproj: 1,
    tuist: 2,
    xcodegen: 3,
    spm: 4,
    unknown: 5,
  };
  return [...candidates].sort((a, b) => {
    // A shallower path is more likely to be the project rather than a fixture.
    const byDepth = a.relPath.split("/").length - b.relPath.split("/").length;
    if (byDepth !== 0) return byDepth;
    const byShape = shapeRank[a.shape] - shapeRank[b.shape];
    if (byShape !== 0) return byShape;
    return a.relPath.localeCompare(b.relPath);
  });
}

export function shapeOf(name: string): ProjectShape | null {
  if (name.endsWith(".xcworkspace")) return "xcworkspace";
  if (name.endsWith(".xcodeproj")) return "xcodeproj";
  if (name === "Package.swift") return "spm";
  if (name === "project.yml" || name === "project.yaml") return "xcodegen";
  if (name === "Project.swift") return "tuist";
  return null;
}

/**
 * Every candidate under a checkout, not one.
 *
 * A monorepo legitimately has several, and picking one silently is how a tool
 * renders a project the user does not care about and calls it their app.
 */
export async function findCandidates(checkoutPath: string, depth = SEARCH_DEPTH): Promise<Candidate[]> {
  const found: Candidate[] = [];

  const walk = async (relative: string, remaining: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(checkoutPath, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const childRel = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const shape = shapeOf(entry.name);
      if (shape !== null) {
        found.push({ shape, relPath: childRel });
        // An `.xcodeproj` is a directory; never descend into one.
        if (shape === "xcodeproj" || shape === "xcworkspace") continue;
      }
      if (entry.isDirectory() && remaining > 0 && !IGNORED_DIRS.has(entry.name)) {
        await walk(childRel, remaining - 1);
      }
    }
  };

  await walk("", depth);

  // An `.xcworkspace` beside an `.xcodeproj` is the one to build; CocoaPods and
  // SwiftPM-in-Xcode projects both produce that pair.
  const workspaceDirs = new Set(
    found.filter((c) => c.shape === "xcworkspace").map((c) => c.relPath.split("/").slice(0, -1).join("/")),
  );
  return rankCandidates(
    found.filter((c) => c.shape !== "xcodeproj" || !workspaceDirs.has(c.relPath.split("/").slice(0, -1).join("/"))),
  );
}

interface XcodebuildList {
  project?: { name?: string; schemes?: string[]; targets?: string[] };
  workspace?: { name?: string; schemes?: string[] };
}

interface SwiftPackageDump {
  name?: string;
  targets?: Array<{ name?: string; type?: string }>;
}

/**
 * A Swift package's targets, which `xcodebuild -list` does not report.
 *
 * Verified against Xcode 26.6: for a `Package.swift`, `xcodebuild -list -json`
 * returns a **workspace** with schemes and *no targets at all*. Reading targets
 * from it therefore finds nothing — and "nothing" is indistinguishable from
 * "no test target", so the onboarder would tell a correctly-configured package
 * that it still needs setting up.
 *
 * `swift package dump-package` reads the manifest without building, and it also
 * says which targets are tests.
 */
export async function dumpPackageTargets(
  packageDir: string,
  signal?: AbortSignal,
): Promise<{ targets: string[]; testTargets: string[] }> {
  try {
    const dump = await runJson<SwiftPackageDump>("swift", ["package", "dump-package"], {
      cwd: packageDir,
      timeoutMs: 120_000,
      signal,
    });
    const targets = dump.targets ?? [];
    return {
      targets: targets.flatMap((target) => (typeof target.name === "string" ? [target.name] : [])),
      testTargets: targets.flatMap((target) =>
        target.type === "test" && typeof target.name === "string" ? [target.name] : [],
      ),
    };
  } catch {
    return { targets: [], testTargets: [] };
  }
}

/**
 * Ask `xcodebuild` what is in there.
 *
 * A `Package.swift` reports itself as a **workspace** — with the scheme named
 * after its library product, or `<PackageName>-Package` when it declares none —
 * which is why this reads all three shapes rather than assuming `project`, and
 * why the SPM path also asks SwiftPM for the targets.
 */
export async function listProject(
  checkoutPath: string,
  candidate: Candidate,
  signal?: AbortSignal,
): Promise<{ schemes: string[]; targets: string[]; testTargets?: string[] }> {
  const args =
    candidate.shape === "xcworkspace"
      ? ["-list", "-json", "-workspace", candidate.relPath]
      : candidate.shape === "xcodeproj"
        ? ["-list", "-json", "-project", candidate.relPath]
        : ["-list", "-json"];
  const cwd =
    candidate.shape === "spm" || candidate.shape === "xcodegen" || candidate.shape === "tuist"
      ? join(checkoutPath, candidate.relPath, "..")
      : checkoutPath;

  const parsed = await runJson<XcodebuildList>("xcodebuild", args, {
    cwd,
    timeoutMs: 120_000,
    signal,
  });
  const schemes = parsed.workspace?.schemes ?? parsed.project?.schemes ?? [];
  if (candidate.shape !== "spm") {
    return { schemes, targets: parsed.project?.targets ?? [] };
  }
  const dumped = await dumpPackageTargets(cwd, signal);
  return { schemes, targets: dumped.targets, testTargets: dumped.testTargets };
}

/** The scheme, when it can be chosen without asking. Twelve schemes cannot. */
export function chooseScheme(schemes: readonly string[], configured: string): string | null {
  if (configured !== "" && schemes.includes(configured)) return configured;
  if (configured !== "") return null;
  if (schemes.length === 1) return schemes[0]!;
  return null;
}

/**
 * The app target whose product hosts the tests.
 *
 * A target named like a test is not it; neither is a framework named `…Kit`.
 * When several remain, the one matching the scheme wins, because that is what
 * the user named their app.
 */
export function chooseAppTarget(targets: readonly string[], scheme: string | null): string | null {
  const candidates = targets.filter((target) => !/tests?$/i.test(target) && !/UITests?$/i.test(target));
  if (candidates.length === 0) return null;
  if (scheme !== null) {
    const exact = candidates.find((target) => target === scheme);
    if (exact !== undefined) return exact;
  }
  const nonFramework = candidates.filter((target) => !/(Kit|Core|Shared|Common)$/.test(target));
  return (nonFramework[0] ?? candidates[0]) ?? null;
}

/**
 * The names to look for the snapshot test target among.
 *
 * SwiftPM tells us which targets are tests, so that list wins outright.
 * Otherwise it is a name guess over targets — except that `xcodebuild -list` on
 * a **workspace** returns schemes and *zero* targets, so guessing over targets
 * alone tells a workspace user their snapshot test target does not exist when
 * it plainly does, and the plan then walks them through creating it a second
 * time. Every generator writes a scheme per target, and Xcode makes one for a
 * new test target too, so the name is there to be found.
 */
export function targetPool(
  testTargets: readonly string[] | undefined,
  targets: readonly string[],
  schemes: readonly string[],
): readonly string[] {
  if (testTargets !== undefined) return testTargets;
  return targets.length > 0 ? targets : schemes;
}

export function findSnapshotTestTarget(targets: readonly string[]): string | null {
  return targets.find((target) => /preview/i.test(target) && /tests?$/i.test(target)) ?? null;
}

export async function detectProject(
  checkoutPath: string,
  candidate: Candidate,
  configuredScheme: string,
  signal?: AbortSignal,
): Promise<DetectedProject> {
  let schemes: string[] = [];
  let targets: string[] = [];
  let testTargets: string[] | undefined;
  try {
    ({ schemes, targets, testTargets } = await listProject(checkoutPath, candidate, signal));
  } catch {
    // A project `xcodebuild` cannot read is still a project; the onboarding
    // plan says what it could not learn rather than claiming there is nothing.
  }
  const scheme = chooseScheme(schemes, configuredScheme);
  return {
    shape: candidate.shape,
    relPath: candidate.relPath,
    schemes,
    targets,
    scheme,
    appTarget: chooseAppTarget(targets, scheme),
    snapshotTestTarget: findSnapshotTestTarget(targetPool(testTargets, targets, schemes)),
  };
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface PlanFile {
  /** Checkout-relative. */
  relPath: string;
  contents: string;
  /** True when the file already exists with different contents. */
  conflict: boolean;
}

export interface OnboardPlan {
  project: DetectedProject;
  /** Files `--apply` would write. */
  files: PlanFile[];
  /** Steps a person has to take in Xcode's UI, with the substituted strings. */
  manualSteps: string[];
  /** Set when the repo already depends on SnapshotPreviews at another version. */
  conflict: string | null;
  /** What is already true, so a second run is not a second setup. */
  alreadyDone: string[];
}

/** The one file the onboarder writes into a repo. */
export function testFileContents(appTarget: string | null): string {
  const app = appTarget ?? "your app";
  return `// Generated by bb-plugin-xcode-simulators.
//
// SnapshotPreviews walks loaded dyld images for SwiftUI preview conformances,
// so this test must run in a *hosted unit test* target — one whose test host is
// ${app}. An unhosted logic test never loads the app binary, the scan finds
// nothing, and you get a green run with zero previews.
import SnapshottingTests

final class ${TEST_CLASS_NAME}: SnapshotTest {}
`;
}

/**
 * The SwiftPM dependency line, templated from the pinned version.
 *
 * Emitted rather than hand-written so a version bump has exactly one string
 * to move.
 */
export function packageDependencyLine(): string {
  return `.package(url: "${SNAPSHOT_PREVIEWS_URL}", exact: "${SNAPSHOT_PREVIEWS_VERSION}")`;
}

/**
 * `TEST_HOST`, substituted.
 *
 * This is the string the draft got wrong, and the one that silently breaks a
 * run when it is wrong: an incorrect test host produces an unhosted test, which
 * renders nothing and reports success.
 */
export function testHostSetting(appTarget: string): string {
  return `$(BUILT_PRODUCTS_DIR)/${appTarget}.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/${appTarget}`;
}

/**
 * Does this repo already depend on SnapshotPreviews, and at what version?
 *
 * If it does at another version, the plan reports the conflict and edits
 * nothing: SwiftPM's resolution failure is an error nobody would connect to
 * this plugin.
 */
export async function existingDependency(
  checkoutPath: string,
  candidate: Candidate,
): Promise<{ present: boolean; version: string | null } | null> {
  const manifests =
    candidate.shape === "spm"
      ? [candidate.relPath]
      : ["Package.swift", `${candidate.relPath}/project.pbxproj`, "project.yml", "Project.swift"];
  for (const manifest of manifests) {
    let text: string;
    try {
      text = await readFile(join(checkoutPath, manifest), "utf8");
    } catch {
      continue;
    }
    if (!/SnapshotPreviews/i.test(text)) continue;
    const exact = /SnapshotPreviews[^\n]*?(?:exact:|revision:|from:|version\s*=)\s*"?([0-9a-zA-Z.]+)"?/i.exec(text);
    const nearby = /(?:exact|revision|from|minimumVersion)"?\s*[:=]\s*"([0-9a-zA-Z.]+)"/i.exec(text);
    return { present: true, version: exact?.[1] ?? nearby?.[1] ?? null };
  }
  return { present: false, version: null };
}

export interface PlanInput {
  checkoutPath: string;
  project: DetectedProject;
  candidate: Candidate;
  existing: { present: boolean; version: string | null } | null;
}

export function buildPlan(input: PlanInput): OnboardPlan {
  const { project } = input;
  const alreadyDone: string[] = [];
  const files: PlanFile[] = [];
  const manualSteps: string[] = [];

  let conflict: string | null = null;
  if (input.existing?.present === true) {
    if (input.existing.version === null || input.existing.version === SNAPSHOT_PREVIEWS_VERSION) {
      alreadyDone.push(`This project already depends on SnapshotPreviews.`);
    } else {
      conflict =
        `This project already depends on SnapshotPreviews at ${input.existing.version}, and Xcode Simulators is built ` +
        `against ${SNAPSHOT_PREVIEWS_VERSION}. Nothing has been changed: two versions in one resolution is a SwiftPM ` +
        `error nobody would connect to this plugin. Align them yourself, then run this again.`;
    }
  }

  if (project.snapshotTestTarget !== null) {
    alreadyDone.push(`${project.snapshotTestTarget} looks like the snapshot test target already.`);
  }

  const testTargetName =
    project.snapshotTestTarget ?? `${project.appTarget ?? "App"}PreviewTests`;
  const testDir = project.shape === "spm" ? `Tests/${testTargetName}` : testTargetName;

  if (conflict === null) {
    files.push({
      relPath: `${testDir}/${TEST_CLASS_NAME}.swift`,
      contents: testFileContents(project.appTarget),
      conflict: false,
    });
  }

  switch (project.shape) {
    case "spm":
      manualSteps.push(
        `Add the dependency to ${project.relPath}:\n    ${packageDependencyLine()}`,
        `Add a test target named ${testTargetName} depending on ${project.appTarget ?? "your library target"} and on .product(name: "SnapshottingTests", package: "SnapshotPreviews").`,
        // Measured, not assumed. SwiftPM has no way to express a host
        // application, and a test target without one renders *nothing*: every
        // preview fails with UISceneErrorDomain 101, upstream drops the failed
        // image without failing the test, and the run goes green with an empty
        // export directory. Saying "the package's test target loads the library
        // so the previews are found" is true and useless — they are found and
        // then none of them render.
        `A package alone cannot run this. SwiftPM test targets have no host application, and SnapshotPreviews renders through a real window — without one every preview fails and the tests still pass.`,
        `Open the package from an Xcode project or workspace that has an app target, add ${testTargetName} there, and set that app as its Host Application.`,
      );
      break;
    case "xcodegen":
      manualSteps.push(
        `Add to ${project.relPath} under packages:\n    SnapshotPreviews:\n      url: ${SNAPSHOT_PREVIEWS_URL}\n      exactVersion: ${SNAPSHOT_PREVIEWS_VERSION}`,
        `Add a ${testTargetName} target of type bundle.unit-test with dependencies on SnapshottingTests and on ${project.appTarget ?? "your app target"}.`,
        `Regenerate with \`xcodegen generate\`.`,
      );
      break;
    case "tuist":
      manualSteps.push(
        `Add to ${project.relPath}'s dependencies:\n    .external(name: "SnapshottingTests")  // ${SNAPSHOT_PREVIEWS_URL} @ ${SNAPSHOT_PREVIEWS_VERSION}`,
        `Add a ${testTargetName} unit-test target hosted by ${project.appTarget ?? "your app target"}.`,
        `Regenerate with \`tuist generate\`.`,
      );
      break;
    default:
      // A pbxproj rewrite that goes wrong costs the user their project file.
      manualSteps.push(
        `In Xcode: File → Add Package Dependencies → ${SNAPSHOT_PREVIEWS_URL}, pinned to exactly ${SNAPSHOT_PREVIEWS_VERSION}.`,
        `File → New → Target → Unit Testing Bundle, named ${testTargetName}.`,
        project.appTarget === null
          ? `Set that target's Host Application to your app.`
          : `Set that target's Host Application to ${project.appTarget}. Its TEST_HOST becomes:\n    ${testHostSetting(project.appTarget)}`,
        `Add SnapshottingTests to that target's Frameworks and Libraries.`,
        `Add ${TEST_CLASS_NAME}.swift (written by --apply) to that target.`,
      );
      break;
  }

  manualSteps.push(
    // So app code can gate network and analytics; the README explains why the
    // async story makes this advice rather than enforcement.
    `In the test scheme's Test action, set the environment variable SNAPSHOTS_RUNNING_FOR_PREVIEWS=1.`,
    `Build that scheme in a Debug-ish configuration, so #if DEBUG previews compile and whole-module optimization does not strip unreferenced preview declarations.`,
  );

  return { project, files, manualSteps, conflict, alreadyDone };
}

/**
 * The un-onboarded state, as a sentence naming what was found.
 *
 * "This project has no snapshot target" is a dead end; naming the scheme, the
 * targets and which one is not hosted is a next step.
 */
export function describeDetection(project: DetectedProject): string {
  const parts = [`Found ${project.relPath}`];
  if (project.schemes.length === 1) parts.push(`with one scheme, ${project.schemes[0]}`);
  else if (project.schemes.length > 1) parts.push(`with ${project.schemes.length} schemes`);
  if (project.appTarget !== null) parts.push(`and an app target called ${project.appTarget}`);
  const found = parts.join(" ");
  // Saying "there is none yet" about a project that has one is the kind of
  // wrongness that makes someone stop believing the rest of the sentence.
  return project.snapshotTestTarget === null
    ? `${found}. Stills needs a unit-test target linking SnapshottingTests; there is none yet.`
    : `${found}. ${project.snapshotTestTarget} links SnapshottingTests, so Stills can run here.`;
}
