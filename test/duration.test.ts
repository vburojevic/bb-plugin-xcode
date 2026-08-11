import { describe, expect, it } from "vitest";

import { formatDuration } from "../src/duration";

describe("formatDuration", () => {
  it("never shows milliseconds", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1)).toBe("1s");
    expect(formatDuration(400)).toBe("1s");
    expect(formatDuration(999)).toBe("1s");
  });

  it("never shows a decimal", () => {
    // `4.4s` implied a precision a two-second `ps` tick cannot deliver.
    expect(formatDuration(4_400)).toBe("5s");
    expect(formatDuration(4_000)).toBe("4s");
    expect(formatDuration(59_000)).toBe("59s");
  });

  it("rounds up, so anything that happened reads as at least a second", () => {
    expect(formatDuration(1)).toBe("1s");
    expect(formatDuration(1_001)).toBe("2s");
  });

  /**
   * The case rounding up creates: 59.6s becomes 60 whole seconds, which must
   * render as one minute rather than the nonsensical `60s`.
   */
  it("rolls a rounded-up minute over instead of printing 60s", () => {
    expect(formatDuration(59_600)).toBe("1m 00s");
    expect(formatDuration(60_000)).toBe("1m 00s");
  });

  it("pads the minor component so a column stays aligned", () => {
    expect(formatDuration(61_000)).toBe("1m 01s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(2_154_000)).toBe("35m 54s");
  });

  it("rolls up into hours", () => {
    expect(formatDuration(3_600_000)).toBe("1h 00m");
    expect(formatDuration(3_660_000)).toBe("1h 01m");
    expect(formatDuration(46_140_000)).toBe("12h 49m");
  });

  it("has one answer for a missing or nonsensical duration", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});
