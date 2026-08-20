import { describe, expect, it } from "vitest";
import { bannerRows, changedIdentitiesOf, failureSentence, MAX_ROWS } from "../../src/sim/banner.js";
import { watermarkOf } from "../../src/sim/model.js";
import type { Look } from "../../src/sim/model.js";

type BannerLook = Look & { changedIdentities: string[]; baseCommit: string | null };

function look(over: Partial<BannerLook> = {}): BannerLook {
  return {
    id: "lk_1",
    projectId: "p",
    scopeKey: "s",
    kind: "stills",
    status: "ok",
    commitSha: "bbbbbbbb",
    branch: "main",
    deviceKey: "d",
    deviceUdid: "u",
    deviceName: "iPhone 17 Pro",
    osVersion: "26.5",
    scale: 3,
    startedAt: 1,
    endedAt: 2,
    frameCount: 148,
    expectedCount: 148,
    manifestRan: true,
    bytesTotal: 0,
    error: null,
    changedIdentities: [],
    baseCommit: "a1b2c3d4",
    ...over,
  };
}

describe("the banner's priority", () => {
  it("has no public-exposure row in its input or output", () => {
    expect(bannerRows({ look: null, dismissed: null, offerRuns: true })).toEqual([]);
  });

  it("surfaces a failed run", () => {
    const rows = bannerRows({
      look: look({ status: "failed", error: "Build failed (exit 65)." }),
      dismissed: null,
      offerRuns: true,
    });
    expect(rows[0]?.kind).toBe("failure");
    expect(rows[0]?.sentence).toBe("Preview render failed — the build did not compile.");
    expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
  });
});

describe("the dismissal watermark", () => {
  it("is the set of changed identities, so the same twelve stay gone", () => {
    const twelve = Array.from({ length: 12 }, (_unused, index) => `preview:${index}.png`);
    expect(
      bannerRows({
        look: look({ changedIdentities: twelve }),
        dismissed: watermarkOf(twelve),
        offerRuns: true,
      }),
    ).toEqual([]);
  });

  it("returns the moment a thirteenth changes", () => {
    const twelve = Array.from({ length: 12 }, (_unused, index) => `preview:${index}.png`);
    const rows = bannerRows({
      look: look({ changedIdentities: [...twelve, "preview:new.png"] }),
      dismissed: watermarkOf(twelve),
      offerRuns: true,
    });
    expect(rows[0]?.sentence).toBe("13 previews moved since `a1b2c3d`");
  });

  it("watermarks a failure on the look id, because there is no changed set", () => {
    const failed = look({ status: "failed", error: "x" });
    expect(
      bannerRows({ look: failed, dismissed: "failed:lk_1", offerRuns: true }),
    ).toEqual([]);
  });
});

describe("the banner's other rules", () => {
  it("shows a progress row that cannot be dismissed", () => {
    const rows = bannerRows({
      look: look({ status: "running", frameCount: 41, expectedCount: 148 }),
      dismissed: null,
      offerRuns: true,
    });
    expect(rows[0]?.sentence).toBe("Rendering previews — 41/148");
    expect(rows[0]?.dismissible).toBe(false);
  });

  it("is indeterminate when the manifest gave no denominator", () => {
    const rows = bannerRows({
      look: look({ status: "running", expectedCount: null }),
      dismissed: null,
      offerRuns: true,
    });
    expect(rows[0]?.sentence).toBe("Rendering previews…");
  });

  it("offers nothing when the user turned the offer off", () => {
    expect(
      bannerRows({
        look: look({ changedIdentities: ["preview:a.png"] }),
        dismissed: null,
        offerRuns: false,
      }),
    ).toEqual([]);
  });

  it("names the failure it can name and quotes the one it cannot", () => {
    expect(failureSentence(look({ error: "no snapshot target" }))).toBe(
      "Preview render failed — this project has no snapshot target.",
    );
    expect(failureSentence(look({ error: null }))).toBe("Preview render failed.");
    expect(failureSentence(look({ error: "something odd\nwith detail" }))).toBe(
      "Preview render failed — something odd",
    );
  });

  it("counts only what actually moved", () => {
    expect(
      changedIdentitiesOf([
        { identity: "a", status: "changed" },
        { identity: "b", status: "layout-changed" },
        { identity: "c", status: "unchanged" },
        { identity: "d", status: "added" },
      ]),
    ).toEqual(["a", "b"]);
  });
});
