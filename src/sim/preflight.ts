/**
 * Prerequisites, probed once and cached.
 *
 * `bb xcode sim doctor`, the panel's Doctor section and the empty state render **the
 * same sentences** — there is no second vocabulary of status tokens. Every
 * check returns a `Probe` whose `detail` is the sentence a person reads, so a
 * new surface cannot invent its own wording for a state that already has one.
 *
 * Probing happens on first use and is cached until an explicit refresh —
 * never at load. Seven child processes inside an RPC handler is I/O on the
 * shared event loop once per keystroke of whatever triggered it; the same
 * seven at load would delay activation on every reload for a fact nothing
 * needs until someone opens the doctor.
 */
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "./exec.js";

/** The serve-sim release every quirk in this plugin was verified against. */
export const PINNED_SERVE_SIM = "0.1.45";

export type ProbeState = "ok" | "warn" | "blocked" | "unknown";

export interface Probe {
  id: string;
  /** Short label, e.g. "Xcode". Never a status token on its own. */
  label: string;
  state: ProbeState;
  /** The whole sentence, fix included. This is the contract the tests assert. */
  detail: string;
  /** Machine-readable extra for the CLI's `--json`, never rendered as prose. */
  value?: string;
}

export interface Preflight {
  probes: Probe[];
  /** Convenience flags, derived from the probes so they cannot disagree. */
  isMac: boolean;
  isAppleSilicon: boolean;
  canRunXcodebuild: boolean;
  captureAddonLoaded: boolean;
  odiffPath: string | null;
  serveSimVersion: string | null;
  xcodeVersion: string | null;
  macosVersion: string | null;
  checkedAt: number;
}

export interface PreflightDeps {
  platform: NodeJS.Platform;
  arch: string;
  runner: typeof run;
  /** Absolute path of the plugin's own directory, for `node_modules` resolution. */
  pluginDir: string;
  now: () => number;
}

export function defaultDeps(pluginDir: string): PreflightDeps {
  return {
    platform: process.platform,
    arch: process.arch,
    runner: run,
    pluginDir,
    now: Date.now,
  };
}

/**
 * The sentence for a non-macOS server.
 *
 * This is the **first** probe, before all others. bb supports a Linux server
 * with enrolled Macs — which is exactly why `bb.sdk.terminals` takes an
 * explicit `{ kind: "host_path", hostId }` scope — and without this check that
 * topology gets told to run `xcode-select --install`.
 */
export function platformProbe(platform: NodeJS.Platform): Probe {
  if (platform === "darwin") {
    return { id: "platform", label: "Server platform", state: "ok", detail: "This bb server runs on macOS.", value: platform };
  }
  const named = platform === "linux" ? "Linux" : platform === "win32" ? "Windows" : platform;
  return {
    id: "platform",
    label: "Server platform",
    state: "blocked",
    detail:
      "Xcode Simulators drives Xcode and the iOS simulator, so it only works when the bb server itself runs on macOS. " +
      `This server runs on ${named}.`,
    value: platform,
  };
}

export function archProbe(arch: string): Probe {
  if (arch === "arm64") {
    return { id: "arch", label: "Architecture", state: "ok", detail: "Apple silicon.", value: arch };
  }
  return {
    id: "arch",
    label: "Architecture",
    state: "warn",
    detail:
      "Live mirroring has only ever been exercised on Apple silicon. The capture addon is a universal binary and will " +
      "load on Intel, but its IOSurface path is untested there. Stills work here — they only need xcodebuild. " +
      "To try Live anyway, turn on allowIntelLive.",
    value: arch,
  };
}

/** `sw_vers -productVersion`, split on `.` and integer-compared. Never string-compared. */
export function macosProbe(version: string | null): Probe {
  if (version === null) {
    return {
      id: "macos",
      label: "macOS",
      state: "unknown",
      detail: "Could not read the macOS version — `sw_vers -productVersion` did not answer.",
    };
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major < 14) {
    return {
      id: "macos",
      label: "macOS",
      state: "warn",
      detail: `Live mirroring needs macOS 14 or newer — serve-sim's capture addon is built against it. This Mac runs ${version}. Stills are unaffected.`,
      value: version,
    };
  }
  return { id: "macos", label: "macOS", state: "ok", detail: `macOS ${version}.`, value: version };
}

export type XcodeSelectState =
  | { kind: "ok"; path: string }
  | { kind: "missing" }
  | { kind: "stale"; path: string }
  | { kind: "clt-only"; path: string }
  | { kind: "unlicensed" };

/** Four distinct failures, four distinct sentences, each naming its own fix. */
export function xcodeSelectProbe(state: XcodeSelectState): Probe {
  switch (state.kind) {
    case "ok":
      return { id: "xcode-select", label: "Xcode command-line tools", state: "ok", detail: `Xcode is selected at ${state.path}.`, value: state.path };
    case "missing":
      return {
        id: "xcode-select",
        label: "Xcode command-line tools",
        state: "blocked",
        detail: "The Xcode command-line tools are not installed. Run `xcode-select --install`.",
      };
    case "stale":
      return {
        id: "xcode-select",
        label: "Xcode command-line tools",
        state: "blocked",
        detail: `\`xcode-select -p\` points at ${state.path}, which is gone. Run \`sudo xcode-select -s /Applications/Xcode.app\`.`,
        value: state.path,
      };
    case "clt-only":
      return {
        id: "xcode-select",
        label: "Xcode command-line tools",
        state: "blocked",
        detail: "Only the Command Line Tools are selected, so `xcodebuild` cannot run. Point `xcode-select` at a full Xcode.",
        value: state.path,
      };
    case "unlicensed":
      return {
        id: "xcode-select",
        label: "Xcode command-line tools",
        state: "blocked",
        detail: "Xcode's licence has not been accepted. Run `sudo xcodebuild -license accept`.",
      };
  }
}

export function xcodeVersionProbe(version: string | null): Probe {
  if (version === null) {
    return { id: "xcode", label: "Xcode", state: "unknown", detail: "Could not read the Xcode version." };
  }
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major < 15) {
    return {
      id: "xcode",
      label: "Xcode",
      state: "warn",
      detail:
        `Xcode 15 or newer is needed for #Preview macro discovery. This Mac has ${version}, so your #Preview macros ` +
        "silently do not render — only PreviewProvider types will.",
      value: version,
    };
  }
  return { id: "xcode", label: "Xcode", state: "ok", detail: `Xcode ${version}.`, value: version };
}

export function addonProbe(loaded: boolean, error: string | null): Probe {
  if (loaded) {
    return { id: "addon", label: "Capture addon", state: "ok", detail: "serve-sim's native capture addon loaded." };
  }
  return {
    id: "addon",
    label: "Capture addon",
    state: "blocked",
    // Never say `npm rebuild`: serve-sim has no install or gyp script and ships
    // the addon prebuilt, so rebuilding rebuilds nothing and the stranger's one
    // instruction is a dead end.
    detail:
      "serve-sim's native capture addon did not load. Reinstall with `bb plugin update xcode-simulators`; " +
      "if that does not fix it, node_modules/serve-sim/dist/native/ is missing.",
    value: error ?? undefined,
  };
}

export function serveSimVersionProbe(version: string | null): Probe {
  if (version === null) {
    return {
      id: "serve-sim",
      label: "serve-sim",
      state: "blocked",
      detail: "serve-sim is not installed. Xcode Simulators is a git install for exactly this reason — reinstall it from its repository.",
    };
  }
  if (version !== PINNED_SERVE_SIM) {
    return {
      id: "serve-sim",
      label: "serve-sim",
      state: "warn",
      detail: `Xcode Simulators was tested against serve-sim ${PINNED_SERVE_SIM}; this install has ${version}. Live may behave differently.`,
      value: version,
    };
  }
  return { id: "serve-sim", label: "serve-sim", state: "ok", detail: `serve-sim ${version}.`, value: version };
}

export function odiffProbe(path: string | null): Probe {
  if (path === null) {
    return {
      id: "odiff",
      label: "odiff",
      state: "warn",
      // Rendering without diffing is useful; failing the run is not.
      detail: "odiff is missing, so previews will render but nothing will be compared.",
    };
  }
  return { id: "odiff", label: "odiff", state: "ok", detail: "odiff is available.", value: path };
}

// ---------------------------------------------------------------------------
// The probes that actually touch the machine
// ---------------------------------------------------------------------------

async function probeMacosVersion(deps: PreflightDeps): Promise<string | null> {
  try {
    const result = await deps.runner("sw_vers", ["-productVersion"], { timeoutMs: 5000 });
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

async function probeXcodeSelect(deps: PreflightDeps): Promise<XcodeSelectState> {
  let path: string;
  try {
    const result = await deps.runner("xcode-select", ["-p"], { timeoutMs: 5000 });
    if (result.code !== 0) return { kind: "missing" };
    path = result.stdout.trim();
    if (path === "") return { kind: "missing" };
  } catch {
    return { kind: "missing" };
  }

  if (path.endsWith("/CommandLineTools") || path.endsWith("CommandLineTools")) {
    return { kind: "clt-only", path };
  }

  try {
    const version = await deps.runner("xcodebuild", ["-version"], { timeoutMs: 20_000 });
    if (version.code !== 0) {
      if (/agreeing to the Xcode/i.test(version.stderr)) return { kind: "unlicensed" };
      // A selected directory that no longer exists reports as an invalid path.
      if (/(?:cannot be located|does not exist|unable to find utility)/i.test(version.stderr)) {
        return { kind: "stale", path };
      }
      return { kind: "stale", path };
    }
  } catch {
    return { kind: "stale", path };
  }

  return { kind: "ok", path };
}

/** `xcodebuild -version -json` when it parses, else the first integer run of line 1. */
export function parseXcodeVersion(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as { xcodeVersion?: unknown };
    if (typeof parsed.xcodeVersion === "string" && parsed.xcodeVersion !== "") return parsed.xcodeVersion;
  } catch {
    // Not JSON on this Xcode; fall through.
  }
  const match = /(\d+(?:\.\d+)*)/.exec(stdout.split("\n")[0] ?? "");
  return match ? match[1]! : null;
}

async function probeXcodeVersion(deps: PreflightDeps): Promise<string | null> {
  try {
    const asJson = await deps.runner("xcodebuild", ["-version", "-json"], { timeoutMs: 20_000 });
    if (asJson.code === 0) {
      const parsed = parseXcodeVersion(asJson.stdout);
      if (parsed !== null) return parsed;
    }
    const plain = await deps.runner("xcodebuild", ["-version"], { timeoutMs: 20_000 });
    if (plain.code !== 0) return null;
    return parseXcodeVersion(plain.stdout);
  } catch {
    return null;
  }
}

/**
 * Resolve serve-sim's middleware entry from the plugin's own `node_modules`.
 *
 * Note the specifier: `require.resolve("serve-sim")` throws
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` on a perfectly healthy install, because the
 * exports map declares only `./middleware` and `./state` with no `.` entry.
 * Verified against serve-sim 0.1.45.
 */
export function resolveServeSimMiddleware(pluginDir: string): string | null {
  try {
    const require = createRequire(join(pluginDir, "noop.cjs"));
    return require.resolve("serve-sim/middleware");
  } catch {
    return null;
  }
}

/** The addon sits beside the bundled middleware, and is not an exports-map entry. */
export function serveSimAddonPath(middlewarePath: string): string {
  return join(dirname(middlewarePath), "native", "serve-sim-native.node");
}

async function probeServeSimVersion(pluginDir: string): Promise<string | null> {
  const middleware = resolveServeSimMiddleware(pluginDir);
  if (middleware === null) return null;
  // dist/middleware.cjs → dist → package root
  const packageJson = join(dirname(dirname(middleware)), "package.json");
  try {
    const parsed = JSON.parse(await readFile(packageJson, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * odiff, from the plugin's own `node_modules` first.
 *
 * It is a pinned dependency, not something a stranger installs by hand — it
 * ships prebuilt per-platform binaries through optionalDependencies, exactly as
 * installable as serve-sim. PATH is a residual fallback for an install that
 * somehow lost its optional dependency.
 */
export function resolveOdiff(pluginDir: string): string | null {
  try {
    const require = createRequire(join(pluginDir, "noop.cjs"));
    return require.resolve("odiff-bin/bin/odiff");
  } catch {
    return null;
  }
}

export async function probeOdiff(deps: PreflightDeps): Promise<string | null> {
  const local = resolveOdiff(deps.pluginDir);
  if (local !== null) return local;
  try {
    const result = await deps.runner("/usr/bin/which", ["odiff"], { timeoutMs: 5000 });
    if (result.code !== 0) return null;
    const path = result.stdout.trim().split("\n")[0]?.trim();
    return path === undefined || path === "" ? null : path;
  } catch {
    return null;
  }
}

/**
 * Run every probe, in order, stopping the machine-specific ones when the
 * platform check already says they cannot apply.
 */
export async function runPreflight(deps: PreflightDeps): Promise<Preflight> {
  const platform = platformProbe(deps.platform);
  const checkedAt = deps.now();

  if (platform.state === "blocked") {
    return {
      probes: [platform],
      isMac: false,
      isAppleSilicon: false,
      canRunXcodebuild: false,
      captureAddonLoaded: false,
      odiffPath: null,
      serveSimVersion: null,
      xcodeVersion: null,
      macosVersion: null,
      checkedAt,
    };
  }

  const [macosVersion, xcodeSelect, serveSimVersion, odiffPath] = await Promise.all([
    probeMacosVersion(deps),
    probeXcodeSelect(deps),
    probeServeSimVersion(deps.pluginDir),
    probeOdiff(deps),
  ]);

  const canRunXcodebuild = xcodeSelect.kind === "ok";
  const xcodeVersion = canRunXcodebuild ? await probeXcodeVersion(deps) : null;

  const middleware = resolveServeSimMiddleware(deps.pluginDir);
  let addonLoaded = false;
  let addonError: string | null = null;
  if (middleware === null) {
    addonError = "serve-sim is not installed";
  } else {
    // Existence only. The child `dlopen`s it for real and reports back on its
    // handshake line — loading a native addon into the bb server to find out
    // whether it loads is the thing the child process exists to avoid.
    try {
      const { existsSync } = await import("node:fs");
      addonLoaded = existsSync(serveSimAddonPath(middleware));
      if (!addonLoaded) addonError = `not at ${serveSimAddonPath(middleware)}`;
    } catch (error) {
      addonError = error instanceof Error ? error.message : String(error);
    }
  }

  const probes: Probe[] = [
    platform,
    archProbe(deps.arch),
    macosProbe(macosVersion),
    xcodeSelectProbe(xcodeSelect),
    xcodeVersionProbe(xcodeVersion),
    addonProbe(addonLoaded, addonError),
    serveSimVersionProbe(serveSimVersion),
    odiffProbe(odiffPath),
  ];

  return {
    probes,
    isMac: true,
    isAppleSilicon: deps.arch === "arm64",
    canRunXcodebuild,
    captureAddonLoaded: addonLoaded,
    odiffPath,
    serveSimVersion,
    xcodeVersion,
    macosVersion,
    checkedAt,
  };
}

/** The worst state present, for a one-line summary. */
export function overallState(probes: readonly Probe[]): ProbeState {
  if (probes.some((p) => p.state === "blocked")) return "blocked";
  if (probes.some((p) => p.state === "warn")) return "warn";
  if (probes.some((p) => p.state === "unknown")) return "unknown";
  return "ok";
}
