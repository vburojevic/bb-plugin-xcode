import { describe, expect, it } from "vitest";
import { formatAgo, formatBytes, formatDuration, formatRatio, joinWords, shortSha } from "../../src/sim/format.js";
import { normalizeSettings, parseUserNumber } from "../../src/sim/settings.js";

/**
 * A sibling plugin shipped a real bug where a European locale rendered a
 * duration as `0,55s` and `parseFloat` silently returned `0`.
 *
 * The whole suite runs a second time under
 * `TZ=Europe/Zagreb LANG=de_DE.UTF-8 LC_ALL=de_DE.UTF-8` (`npm run test:intl`),
 * and these are the assertions that would break first.
 */
describe("durations", () => {
  it("formats 550ms as 0.55s in every locale", () => {
    expect(formatDuration(550)).toBe("0.55s");
  });

  it("keeps one shape below a second and switches to minutes above sixty", () => {
    expect(formatDuration(42)).toBe("0.04s");
    expect(formatDuration(61_000)).toBe("1m 1s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("says nothing rather than NaN", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("ratios", () => {
  it("renders a fraction as a two-decimal percentage", () => {
    // The ratio is 0–1; the percentage odiff prints is 0–100. They are never
    // allowed to meet, and this is the only place one becomes the other.
    expect(formatRatio(0.0625)).toBe("6.25%");
    expect(formatRatio(0)).toBe("0.00%");
  });
});

describe("bytes", () => {
  it("reads as a person would say it", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1_503_238_553)).toBe("1.4 GB");
  });
});

describe("relative time", () => {
  const now = 1_700_000_000_000;
  it("is coarse on purpose", () => {
    expect(formatAgo(now - 30_000, now)).toBe("just now");
    expect(formatAgo(now - 60_000, now)).toBe("a minute ago");
    expect(formatAgo(now - 4 * 60_000, now)).toBe("4 minutes ago");
    expect(formatAgo(now - 26 * 3_600_000, now)).toBe("yesterday");
  });
});

describe("words", () => {
  it("joins a list the way a sentence does", () => {
    expect(joinWords([])).toBe("");
    expect(joinWords(["iPhone 17 Pro"])).toBe("iPhone 17 Pro");
    expect(joinWords(["iPhone 17 Pro", "iPad Pro 13-inch"])).toBe("iPhone 17 Pro and iPad Pro 13-inch");
    expect(joinWords(["a", "b", "c"])).toBe("a, b and c");
  });

  it("never presents a short sha as if it were a full one", () => {
    expect(shortSha("a1b2c3d4e5f6")).toBe("a1b2c3d");
    expect(shortSha(null)).toBeNull();
  });
});

describe("numbers the user typed", () => {
  it("reads a lone comma as a decimal separator", () => {
    // A European keyboard types `0,01`. `Number.parseFloat("0,01")` is 0, and a
    // diff threshold of zero marks every frame changed forever.
    expect(parseUserNumber("0,01", 99)).toBe(0.01);
    expect(parseUserNumber("0.01", 99)).toBe(0.01);
  });

  it("falls back to the default rather than to a nonsense value", () => {
    expect(parseUserNumber("", 20)).toBe(20);
    expect(parseUserNumber("   ", 20)).toBe(20);
    expect(parseUserNumber("banana", 20)).toBe(20);
    expect(parseUserNumber(undefined, 20)).toBe(20);
    // `1e999` parses to Infinity, which is why the guard is `isFinite` and not
    // `!isNaN`.
    expect(parseUserNumber("1e999", 20)).toBe(20);
  });
});

describe("settings normalization", () => {
  it("clamps every numeric field into its documented range", () => {
    const settings = normalizeSettings({
      diffThreshold: "5",
      retainLooks: "0",
      diskBudgetMb: "1",
    });
    expect(settings.diffThreshold).toBe(1);
    expect(settings.retainLooks).toBe(1);
    expect(settings.diskBudgetMb).toBe(64);
  });

  it("defaults everything that is absent", () => {
    const settings = normalizeSettings({});
    expect(settings.diffThreshold).toBe(0.01);
    expect(settings.retainLooks).toBe(20);
    expect(settings.diskBudgetMb).toBe(2048);
    expect(settings.showDeviceChrome).toBe(false);
    expect(settings.allowAgentCapture).toBe(false);
  });

  it("keeps a threshold of exactly zero, which is a legitimate choice", () => {
    expect(normalizeSettings({ diffThreshold: "0" }).diffThreshold).toBe(0);
  });

  it("reads a boolean written as a string", () => {
    expect(normalizeSettings({ allowIntelLive: "true" }).allowIntelLive).toBe(true);
    expect(normalizeSettings({ allowAgentCapture: "false" }).allowAgentCapture).toBe(false);
  });
});
