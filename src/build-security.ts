/** Security checks shared by the agent tool and agent-facing build CLI. */
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathIsUnder } from "./scopes";

const PATH_FLAGS = new Set([
  "-project",
  "-workspace",
  "-xcconfig",
  "-sdk",
  "-derivedDataPath",
  "-archivePath",
  "-exportOptionsPlist",
  "-exportPath",
  "-importPath",
  "-localizationPath",
  "-xctestrun",
  "-testProductsPath",
  "-test-enumeration-output-path",
  "-clonedSourcePackagesDirPath",
  "-packageCachePath",
  "-authenticationKeyPath",
  "-framework",
  "-library",
  "-headers",
  "-output",
]);

const HOST_MUTATING_OPTIONS = new Set([
  "-allowProvisioningUpdates",
  "-allowProvisioningDeviceRegistration",
  "-create-xcframework",
  "-runFirstLaunch",
  "-checkForNewerComponents",
  "-prepareDeviceSupport",
  "-downloadPlatform",
  "-downloadAllPlatforms",
  "-importPlatform",
  "-downloadComponent",
  "-importComponent",
  "-deleteComponent",
  "-exportArchive",
  "-exportNotarizedApp",
  "-skipPackagePluginValidation",
  "-skipMacroValidation",
  "-skipPackageSignatureValidation",
  "-enablePerformanceTestsDiagnostics",
  "-collect-test-diagnostics",
]);

export async function confinedBuildCwd(root: string, requested?: string): Promise<string> {
  const realRoot = await realpath(root);
  const candidate = requested === undefined ? realRoot : resolve(realRoot, requested);
  const realCandidate = await realpath(candidate);
  if (!pathIsUnder(realCandidate, realRoot)) {
    throw new Error("The build working directory must stay inside this thread's checkout.");
  }
  if (!(await stat(realCandidate)).isDirectory()) {
    throw new Error("The build working directory is not a directory.");
  }
  return realCandidate;
}

/**
 * Keep every caller-selected xcodebuild input/output path beneath the checkout.
 * The nearest existing ancestor is resolved too, so a symlink cannot turn a
 * lexically in-root output into a host write elsewhere.
 */
export async function validateBuildArguments(
  argv: readonly string[],
  root: string,
  cwd: string,
): Promise<void> {
  const realRoot = await realpath(root);
  const realCwd = await realpath(cwd);
  if (!pathIsUnder(realCwd, realRoot)) {
    throw new Error("The build working directory must stay inside this thread's checkout.");
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const mutatingOption = [...HOST_MUTATING_OPTIONS].find(
      (option) => argument === option || argument.startsWith(`${option}=`),
    );
    if (mutatingOption !== undefined) {
      throw new Error(`${mutatingOption} is not available through the tracked build runner.`);
    }
    const inlineFlag = [...PATH_FLAGS].find((flag) => argument.startsWith(`${flag}=`));
    const flag = PATH_FLAGS.has(argument) ? argument : inlineFlag;
    if (flag === undefined) continue;
    const value = inlineFlag === undefined ? argv[index + 1] : argument.slice(inlineFlag.length + 1);
    if (value === undefined || value === "") {
      throw new Error(`${flag} requires a path.`);
    }
    if (inlineFlag === undefined) index += 1;
    if (value === "-" && flag === "-test-enumeration-output-path") continue;
    if (value.startsWith("-")) throw new Error(`${flag} requires a path.`);
    if (/\$\(|\$\{/.test(value)) {
      throw new Error(`${flag} may not contain deferred variable expansion.`);
    }
    const target = resolve(realCwd, value);
    if (!pathIsUnder(target, realRoot)) {
      throw new Error(`${flag} must stay inside this thread's checkout.`);
    }
    const existing = await nearestExisting(target);
    const realExisting = await realpath(existing);
    if (!pathIsUnder(realExisting, realRoot)) {
      throw new Error(`${flag} resolves through a path outside this thread's checkout.`);
    }
  }

  // Build settings can redirect products without using a named path flag.
  // Resolve relative values too: `SYMROOT=../../outside` is the same escape as
  // an absolute path once xcodebuild interprets it from cwd. Xcode variables
  // are refused in path-looking values because their expansion happens later,
  // outside this validator's view.
  for (const argument of argv.slice(1)) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(argument);
    if (assignment === null) continue;
    const name = assignment[1]!;
    const value = assignment[2]!;
    if (!looksLikeBuildPath(name, value)) continue;
    if (/\$\(|\$\{/.test(value)) {
      throw new Error("A build-setting path may not contain deferred variable expansion.");
    }
    const target = resolve(realCwd, value);
    const existing = await nearestExisting(target);
    const realExisting = await realpath(existing);
    const realTarget = resolve(realExisting, relative(existing, target));
    if (!pathIsUnder(realExisting, realRoot) || !pathIsUnder(realTarget, realRoot)) {
      throw new Error("A build-setting path resolves outside this thread's checkout.");
    }
  }
}

function looksLikeBuildPath(name: string, value: string): boolean {
  return (
    isAbsolute(value) ||
    value.startsWith(".") ||
    value.startsWith("~") ||
    value.includes("/") ||
    value.includes("\\") ||
    /(?:ROOT|DIR|DIRECTORY|PATH|PATHS|FILE|FILES|PLIST|ENTITLEMENTS|HEADER|HEADERS)$/.test(name)
  );
}

async function nearestExisting(path: string): Promise<string> {
  let candidate = path;
  for (;;) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`No existing ancestor for ${path}.`);
    candidate = parent;
  }
}
