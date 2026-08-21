/**
 * The gear menu's allowlist, asserted from both sides: what it offers, and —
 * the part the security model leans on — what it must never offer.
 */
import { describe, expect, it } from "vitest";
import { isUiOptionKey, uiOptions } from "../../src/sim/options.js";
import { SETTINGS_DESCRIPTORS } from "../../src/sim/settings.js";

describe("the ui options allowlist", () => {
  it("answers defaults when nothing is set, and raw values when something is", () => {
    const defaults = uiOptions({});
    expect(defaults.map((option) => [option.key, option.value])).toEqual([
      ["showThreadActivity", true],
      ["postChangedPreviews", true],
      ["showDeviceChrome", false],
    ]);

    const flipped = uiOptions({ showThreadActivity: false, showDeviceChrome: true });
    expect(flipped.find((option) => option.key === "showThreadActivity")?.value).toBe(false);
    expect(flipped.find((option) => option.key === "showDeviceChrome")?.value).toBe(true);
  });

  it("ignores a non-boolean raw value rather than guessing at it", () => {
    const options = uiOptions({ showThreadActivity: "yes" as unknown as boolean });
    expect(options.find((option) => option.key === "showThreadActivity")?.value).toBe(true);
  });

  it("labels every row, because the menu renders them verbatim", () => {
    for (const option of uiOptions({})) {
      expect(option.label).not.toBe("");
      expect(option.detail).not.toBe("");
    }
  });

  it("NEVER offers allowAgentCapture, or any other trust decision", () => {
    // The RPC pair behind the gear rides bb's `auth: "local"` boundary, which
    // any same-user process can cross — an agent included. A menu that could
    // flip allowAgentCapture would let an agent grant itself simulator access.
    // This assertion is the fence; do not "fix" a failure here by widening it.
    expect(isUiOptionKey("allowAgentCapture")).toBe(false);
    expect(isUiOptionKey("allowIntelLive")).toBe(false);
    expect(isUiOptionKey("projectPath")).toBe(false);
    expect(isUiOptionKey("scheme")).toBe(false);
    expect(uiOptions({}).some((option) => option.key === "allowAgentCapture")).toBe(false);
  });

  it("offers only keys that are presentation, by enumeration", () => {
    // Every allowlisted key must be one of the known display toggles — a new
    // key added to the menu has to be added HERE too, which is the point: two
    // lists that must agree force the security question to be asked twice.
    const display = new Set(["showThreadActivity", "postChangedPreviews", "showDeviceChrome"]);
    for (const option of uiOptions({})) {
      expect(display.has(option.key)).toBe(true);
    }
  });

  it("covers keys the settings screen also knows, under the same spelling", () => {
    // showThreadActivity lives in the tracker's descriptor block; the two sim
    // keys must exist in the sim descriptors, or the gear writes a key the
    // settings screen cannot show.
    expect("postChangedPreviews" in SETTINGS_DESCRIPTORS).toBe(true);
    expect("showDeviceChrome" in SETTINGS_DESCRIPTORS).toBe(true);
  });
});
