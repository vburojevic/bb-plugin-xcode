/**
 * The merged panel's subPath namespace: three tab literals, and everything
 * else — including every historical run-id deep link — reads as Builds.
 */
import { describe, expect, it } from "vitest";
import { PANEL_PATH, subPathForTab, tabOf } from "../../app/sim/route.js";

describe("the merged route", () => {
  it("owns the xcode panel path", () => {
    expect(PANEL_PATH).toBe("xcode");
  });

  it("maps subPaths to tabs", () => {
    expect(tabOf("")).toBe("builds");
    expect(tabOf("live")).toBe("live");
    expect(tabOf("doctor")).toBe("live");
    expect(tabOf("stills")).toBe("stills");
    expect(tabOf("stills/lk_abc")).toBe("stills");
    expect(tabOf("stills/lk_abc/Group/Preview")).toBe("stills");
  });

  it("reads a run id as Builds — the tracker's deep links keep working", () => {
    // Run ids are `r:<pid>:<epoch>`; nothing the simulator half owns starts
    // with `r:`, so the namespaces cannot collide.
    expect(tabOf("r:8412:1755672000")).toBe("builds");
    // And an unrecognised subPath does the least harm on Builds.
    expect(tabOf("someday-a-new-segment")).toBe("builds");
  });

  it("round-trips each tab through its subPath", () => {
    for (const tab of ["builds", "live", "stills"] as const) {
      expect(tabOf(subPathForTab(tab))).toBe(tab);
    }
  });
});
