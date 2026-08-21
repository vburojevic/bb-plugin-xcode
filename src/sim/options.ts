/**
 * The panel's quick toggles: which settings the gear menu may read and write.
 *
 * This is an allowlist, and being *out* of it is load-bearing. Plugin RPC
 * rides bb's `auth: "local"` boundary, which any same-user process can cross
 * (see SECURITY.md) — so nothing reachable from here may change what an agent
 * is allowed to do. `allowAgentCapture` is a trust decision and lives only in
 * bb's own settings screen; a menu that could flip it would let an agent flip
 * it for itself. Everything below is presentation: the worst a hostile caller
 * can do is hide a banner.
 */
import type { RawSettings } from "./settings.js";

export interface UiOption {
  key: string;
  label: string;
  /** One clause under the label, for the menu row. */
  detail: string;
  value: boolean;
}

interface UiOptionSpec {
  key: string;
  label: string;
  detail: string;
  defaultValue: boolean;
}

const SPECS: readonly UiOptionSpec[] = [
  {
    key: "showThreadActivity",
    label: "Build activity in threads",
    detail: "Live builds as rows above the composer.",
    defaultValue: true,
  },
  {
    key: "postChangedPreviews",
    label: "Preview results in threads",
    detail: "A banner when a preview render finishes.",
    defaultValue: true,
  },
  {
    key: "showDeviceChrome",
    label: "Device chrome",
    detail: "A bezel around the live frame.",
    defaultValue: false,
  },
];

export function isUiOptionKey(key: string): boolean {
  return SPECS.some((spec) => spec.key === key);
}

export function uiOptions(raw: RawSettings): UiOption[] {
  return SPECS.map((spec) => ({
    key: spec.key,
    label: spec.label,
    detail: spec.detail,
    value: typeof raw[spec.key] === "boolean" ? (raw[spec.key] as boolean) : spec.defaultValue,
  }));
}
