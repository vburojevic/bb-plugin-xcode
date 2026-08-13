/**
 * Settings: descriptors, and the one normalizer everything reads through.
 *
 * bb settings descriptors are `string | select | boolean | project`, so every
 * numeric field arrives as a string and is parsed here — once, at load and
 * again in `onChange` — rather than at each of a dozen call sites that would
 * each get the clamping slightly different.
 *
 * The locale rule from a sibling plugin's real bug: a European keyboard types
 * `0,01`, `Number.parseFloat("0,01")` is `0`, and a diff threshold of zero
 * marks every frame changed forever. So a lone comma is read as a decimal
 * separator rather than silently truncating the value. Everything else that
 * fails to parse falls back to the documented default, because a setting the
 * user got wrong should behave like one they never set.
 */

export interface Settings {
  /** Checkout-relative path to the `.xcodeproj` / `.xcworkspace` / `Package.swift`. */
  projectPath: string;
  scheme: string;
  defaultDevice: string;
  stillsDevice: string;
  /** A **fraction** of changed pixels, 0–1. Per-frame sidecars override it. */
  diffThreshold: number;
  retainLooks: number;
  diskBudgetMb: number;
  exposeTtlMinutes: number;
  showDeviceChrome: boolean;
  allowIntelLive: boolean;
  allowAgentCapture: boolean;
  postChangedPreviews: boolean;
}

export const DEFAULTS: Settings = {
  projectPath: "",
  scheme: "",
  defaultDevice: "",
  stillsDevice: "",
  diffThreshold: 0.01,
  retainLooks: 20,
  diskBudgetMb: 2048,
  exposeTtlMinutes: 30,
  showDeviceChrome: false,
  allowIntelLive: false,
  allowAgentCapture: true,
  postChangedPreviews: true,
};

/** Max TTL for an exposure, in minutes. Four hours is already generous. */
export const MAX_EXPOSE_TTL_MINUTES = 240;

/**
 * The descriptor set handed to `bb.settings.define`.
 *
 * Every non-secret has a default, so `get()` returns non-optional values and
 * nothing downstream has to handle `undefined`. There are no secrets: this
 * plugin stores no token and contacts no service. If that ever stops being
 * true the token goes in a `secret: true` descriptor — 0600 file, never
 * reaches the frontend, never reaches an agent, never appears in a log line.
 */
export const SETTINGS_DESCRIPTORS = {
  projectPath: {
    type: "string",
    label: "Project path",
    description:
      "Checkout-relative path to the .xcodeproj, .xcworkspace or Package.swift. Leave empty to detect it.",
    default: DEFAULTS.projectPath,
  },
  scheme: {
    type: "string",
    label: "Scheme",
    description: "Leave empty to use the only scheme, or to be asked when there is more than one.",
    default: DEFAULTS.scheme,
  },
  defaultDevice: {
    type: "string",
    label: "Default device",
    description: "Device name or UDID for Live. Empty picks the newest iPhone on the newest runtime.",
    default: DEFAULTS.defaultDevice,
  },
  stillsDevice: {
    type: "string",
    label: "Preview render device",
    description:
      "Device used for preview renders. Empty creates a dedicated one, so a render never fights the device you are watching.",
    default: DEFAULTS.stillsDevice,
  },
  diffThreshold: {
    type: "string",
    label: "Diff threshold",
    description: "Fraction of changed pixels tolerated, 0–1. A preview's own sidecar overrides this.",
    default: String(DEFAULTS.diffThreshold),
  },
  retainLooks: {
    type: "string",
    label: "Runs kept per project",
    description: "Older runs are pruned. A baselined run, or one linked to a thread, is never pruned.",
    default: String(DEFAULTS.retainLooks),
  },
  diskBudgetMb: {
    type: "string",
    label: "Disk budget (MB)",
    description: "Across every project. Checked before a run writes as well as after.",
    default: String(DEFAULTS.diskBudgetMb),
  },
  exposeTtlMinutes: {
    type: "string",
    label: "Exposure length (minutes)",
    description: `How long a remote share lasts before it tears itself down. Maximum ${MAX_EXPOSE_TTL_MINUTES}.`,
    default: String(DEFAULTS.exposeTtlMinutes),
  },
  showDeviceChrome: {
    type: "boolean",
    label: "Show device bezel",
    description: "Off by default: you are here to see the app, not a bezel.",
    default: DEFAULTS.showDeviceChrome,
  },
  allowIntelLive: {
    type: "boolean",
    label: "Allow Live on Intel",
    description:
      "The capture addon loads on Intel but its capture path is untested there. Stills are unaffected either way.",
    default: DEFAULTS.allowIntelLive,
  },
  allowAgentCapture: {
    type: "boolean",
    label: "Let agents see the simulator",
    description:
      "Registers the simulator_capture, simulator_drive and simulator_stills tools. A captured frame is sent to your model provider as an image.",
    default: DEFAULTS.allowAgentCapture,
  },
  postChangedPreviews: {
    type: "boolean",
    label: "Offer changed previews to the thread",
    description: "Show a banner above the composer when a preview render finishes in this thread.",
    default: DEFAULTS.postChangedPreviews,
  },
} as const;

/** The raw shape `settings.get()` returns, before normalization. */
export type RawSettings = Record<string, string | boolean | undefined>;

/**
 * Parse a number the user typed.
 *
 * Accepts a lone comma as a decimal separator, because the alternative is a
 * European keyboard silently producing `0`. Rejects anything non-finite, which
 * is why the check is `Number.isFinite` rather than `!Number.isNaN` — `1e999`
 * parses to `Infinity` and would sail through the second test.
 */
export function parseUserNumber(raw: string | boolean | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return fallback;
  const normalized =
    trimmed.includes(",") && !trimmed.includes(".") ? trimmed.replace(",", ".") : trimmed;
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseBoolean(raw: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  return fallback;
}

function parseString(raw: string | boolean | undefined, fallback: string): string {
  return typeof raw === "string" ? raw.trim() : fallback;
}

/**
 * The single normalizer. Every consumer reads settings through this — never
 * through `settings.get()` directly — so bounds are enforced in exactly one
 * place and a nonsense value can never reach the code that acts on it.
 */
export function normalizeSettings(raw: RawSettings): Settings {
  return {
    projectPath: parseString(raw.projectPath, DEFAULTS.projectPath),
    scheme: parseString(raw.scheme, DEFAULTS.scheme),
    defaultDevice: parseString(raw.defaultDevice, DEFAULTS.defaultDevice),
    stillsDevice: parseString(raw.stillsDevice, DEFAULTS.stillsDevice),
    // A threshold of exactly 0 is legitimate: "any changed pixel is a change".
    diffThreshold: clamp(parseUserNumber(raw.diffThreshold, DEFAULTS.diffThreshold), 0, 1),
    retainLooks: Math.round(clamp(parseUserNumber(raw.retainLooks, DEFAULTS.retainLooks), 1, 500)),
    diskBudgetMb: Math.round(
      clamp(parseUserNumber(raw.diskBudgetMb, DEFAULTS.diskBudgetMb), 64, 1_000_000),
    ),
    exposeTtlMinutes: Math.round(
      clamp(parseUserNumber(raw.exposeTtlMinutes, DEFAULTS.exposeTtlMinutes), 1, MAX_EXPOSE_TTL_MINUTES),
    ),
    showDeviceChrome: parseBoolean(raw.showDeviceChrome, DEFAULTS.showDeviceChrome),
    allowIntelLive: parseBoolean(raw.allowIntelLive, DEFAULTS.allowIntelLive),
    allowAgentCapture: parseBoolean(raw.allowAgentCapture, DEFAULTS.allowAgentCapture),
    postChangedPreviews: parseBoolean(raw.postChangedPreviews, DEFAULTS.postChangedPreviews),
  };
}
