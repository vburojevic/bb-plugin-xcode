import { describe, expect, it } from "vitest";
import {
  captureSlug,
  compareForDisplay,
  detectTruncation,
  deviceKey,
  describePreviewName,
  exceedsThreshold,
  isDismissed,
  isFlaky,
  looksLikeRekey,
  mayClaimUnchanged,
  newLookId,
  severityOf,
  sidecarFor,
  ulid,
  watermarkOf,
} from "../../src/sim/model.js";

describe("severity", () => {
  it("puts missing above everything, because it is the alarming one", () => {
    // SnapshotPreviews writes nothing and fails nothing when a render fails, so
    // a missing frame is the one result that looks like success from every
    // other angle.
    expect(severityOf("missing")).toBeLessThan(severityOf("errored"));
    expect(severityOf("errored")).toBeLessThan(severityOf("layout-changed"));
    expect(severityOf("layout-changed")).toBeLessThan(severityOf("changed"));
    expect(severityOf("changed")).toBeLessThan(severityOf("unchanged"));
  });

  it("sorts a flaky change below a stable one of the same status", () => {
    const rows = [
      { status: "changed" as const, identity: "a", flaky: true },
      { status: "changed" as const, identity: "b", flaky: false },
    ];
    expect([...rows].sort(compareForDisplay).map((row) => row.identity)).toEqual(["b", "a"]);
  });

  it("is stable by identity so two runs of one set render in the same order", () => {
    const rows = [
      { status: "changed" as const, identity: "z" },
      { status: "changed" as const, identity: "a" },
    ];
    expect([...rows].sort(compareForDisplay).map((row) => row.identity)).toEqual(["a", "z"]);
  });
});

describe("sidecarFor", () => {
  it("swaps the suffix rather than replacing an extension", () => {
    // `MyModule/LoginView.swift_Dark Mode` sanitizes to a name with embedded
    // dots, and upstream derives the sidecar as
    // `imageFileName.dropLast(".png".count) + ".json"`. Anything shaped like
    // `path.with_extension()` corrupts it.
    expect(sidecarFor("MyModule_LoginView.swift_Dark_Mode.png")).toBe(
      "MyModule_LoginView.swift_Dark_Mode.json",
    );
  });

  it("still answers for a name that is not a png", () => {
    expect(sidecarFor("weird")).toBe("weird.json");
  });
});

describe("describePreviewName", () => {
  it("splits the group from the display name", () => {
    expect(describePreviewName("MyModule_LoginView.swift_Dark_Mode.png")).toEqual({
      groupName: "MyModule / LoginView.swift / Dark",
      displayName: "Mode",
    });
  });

  it("leaves a single-segment name alone", () => {
    expect(describePreviewName("Solo.png")).toEqual({ groupName: "", displayName: "Solo" });
  });
});

describe("thresholds", () => {
  it("tolerates the Float round-trip a sidecar can contain", () => {
    // `diff_threshold` round-trips through `1 - precision` in Float upstream, so
    // a sidecar written as 0.05 can read back as 0.050000012.
    const sidecarThreshold = 0.050000012;
    expect(exceedsThreshold(0.05, sidecarThreshold)).toBe(false);
    expect(exceedsThreshold(0.0500001, sidecarThreshold)).toBe(false);
    expect(exceedsThreshold(0.06, sidecarThreshold)).toBe(true);
  });

  it("treats a threshold of zero as any changed pixel", () => {
    expect(exceedsThreshold(0, 0)).toBe(false);
    expect(exceedsThreshold(0.001, 0)).toBe(true);
  });
});

describe("the re-key heuristic", () => {
  it("does not fire at 24% and does fire at 26%", () => {
    expect(looksLikeRekey(24, 100)).toBe(false);
    expect(looksLikeRekey(26, 100)).toBe(true);
  });

  it("does not divide by zero on an empty run", () => {
    expect(looksLikeRekey(0, 0)).toBe(false);

    // A small project is not a re-key. 2 of 3 is 67% and entirely ordinary.
    expect(looksLikeRekey(2, 3)).toBe(false);
    expect(looksLikeRekey(4, 4)).toBe(false);
    expect(looksLikeRekey(5, 6)).toBe(true);
  });
});

describe("the flaky heuristic", () => {
  it("needs three of the last five, not two", () => {
    expect(isFlaky(2, 5)).toBe(false);
    expect(isFlaky(3, 5)).toBe(true);
  });

  it("says nothing until there are five runs to say it about", () => {
    expect(isFlaky(3, 4)).toBe(false);
  });
});

describe("the truncated-run detector", () => {
  const manifest = ["a", "b", "c", "d", "e"];

  it("names where the runner stopped when the tail is contiguous", () => {
    expect(detectTruncation(manifest, new Set(["c", "d", "e"]))).toEqual({
      stoppedAfter: "b",
      neverReached: 3,
    });
  });

  it("stays quiet when the misses are scattered", () => {
    // Scattered misses really are individual failures and deserve individual
    // rows; collapsing them would hide four separate problems behind one line.
    expect(detectTruncation(manifest, new Set(["a", "c", "e"]))).toBeNull();
  });

  it("stays quiet when an unlucky last entry is the only tail member", () => {
    expect(detectTruncation(manifest, new Set(["a", "e"]))).toBeNull();
  });

  it("does not call a wholly failed run truncated", () => {
    expect(detectTruncation(manifest, new Set(manifest))).toBeNull();
  });
});

describe("the banner watermark", () => {
  it("is the set of changed identities, not a timestamp", () => {
    // Dismiss it and it stays gone through re-renders of the same twelve, and
    // returns the moment a thirteenth changes.
    const first = watermarkOf(["b", "a"]);
    expect(isDismissed(first, ["a", "b"])).toBe(true);
    expect(isDismissed(first, ["a", "b", "c"])).toBe(false);
  });

  it("is not dismissed when nothing was ever dismissed", () => {
    expect(isDismissed(null, ["a"])).toBe(false);
  });
});

describe("empty is never success", () => {
  const base = { manifestRan: true, expectedCount: 148, frameCount: 148 };

  it("allows the claim only when the manifest ran and every name produced a frame", () => {
    expect(mayClaimUnchanged(base)).toBe(true);
    expect(mayClaimUnchanged({ ...base, manifestRan: false })).toBe(false);
    expect(mayClaimUnchanged({ ...base, expectedCount: null })).toBe(false);
    expect(mayClaimUnchanged({ ...base, expectedCount: 0, frameCount: 0 })).toBe(false);
    expect(mayClaimUnchanged({ ...base, frameCount: 147 })).toBe(false);
  });
});

describe("ids", () => {
  it("sorts lexicographically in creation order", () => {
    const early = ulid(1_000_000_000_000, () => 0);
    const late = ulid(1_000_000_000_001, () => 0);
    expect(early < late).toBe(true);
  });

  it("matches the pattern the directive validates against", () => {
    expect(newLookId(Date.now())).toMatch(/^lk_[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("capture identity", () => {
  it("never produces an empty slug", () => {
    expect(captureSlug("", 42)).toBe("capture-42");
    expect(captureSlug("!!!", 42)).toBe("capture-42");
  });

  it("collapses punctuation to single hyphens", () => {
    expect(captureSlug("Recipe list — empty!", 0)).toBe("recipe-list-empty");
  });
});

describe("deviceKey", () => {
  it("includes the architecture", () => {
    // SnapshotPreviews' gettimeofday pin is compiled out on x86_64, so an Intel
    // machine legitimately produces different baselines from an Apple silicon
    // one and comparing them is noise.
    expect(deviceKey({ name: "iPhone 17 Pro", osVersion: "26.5", scale: 3, arch: "arm64" })).not.toBe(
      deviceKey({ name: "iPhone 17 Pro", osVersion: "26.5", scale: 3, arch: "x64" }),
    );
  });
});
