import { describe, expect, it } from "vitest";
import {
  addonProbe,
  archProbe,
  macosProbe,
  odiffProbe,
  overallState,
  parseXcodeVersion,
  platformProbe,
  serveSimVersionProbe,
  xcodeSelectProbe,
  xcodeVersionProbe,
} from "../../src/sim/preflight.js";

/**
 * `bb xcode sim doctor`, the panel's Doctor section and the empty state render
 * **the same sentences**. Each assertion here is on the sentence, not on the
 * state token, because the sentence is the contract.
 */
describe("the platform probe", () => {
  it("is the first thing checked, and names the platform it found", () => {
    // bb supports a Linux server with enrolled Macs. Without this check that
    // topology gets told to run `xcode-select --install`.
    const probe = platformProbe("linux");
    expect(probe.state).toBe("blocked");
    expect(probe.detail).toBe(
      "Xcode Simulators drives Xcode and the iOS simulator, so it only works when the bb server itself runs on macOS. This server runs on Linux.",
    );
  });

  it("passes on macOS", () => {
    expect(platformProbe("darwin").state).toBe("ok");
  });
});

describe("the architecture probe", () => {
  it("blames the capture path rather than the binary", () => {
    // The addon is a universal N-API binary; it loads. The honest unknown is
    // whether its IOSurface path produces frames on x86_64.
    const probe = archProbe("x64");
    expect(probe.state).toBe("warn");
    expect(probe.detail).toContain("universal binary and will load on Intel");
    expect(probe.detail).toContain("its IOSurface path is untested there");
    expect(probe.detail).toContain("Stills work here");
    expect(probe.detail).toContain("allowIntelLive");
  });

  it("says nothing interesting on Apple silicon", () => {
    expect(archProbe("arm64").state).toBe("ok");
  });
});

describe("the macOS version probe", () => {
  it("compares integers rather than strings", () => {
    // "9.0" > "14.0" as strings. The comparison splits on "." and compares the
    // major as a number.
    expect(macosProbe("13.6").state).toBe("warn");
    expect(macosProbe("14.0").state).toBe("ok");
    expect(macosProbe("26.5.2").state).toBe("ok");
  });

  it("says Stills are unaffected, because they are", () => {
    expect(macosProbe("13.6").detail).toContain("Stills are unaffected");
  });
});

describe("the xcode-select probe", () => {
  it("branches on four states, each with its own fix", () => {
    expect(xcodeSelectProbe({ kind: "missing" }).detail).toBe(
      "The Xcode command-line tools are not installed. Run `xcode-select --install`.",
    );
    expect(xcodeSelectProbe({ kind: "stale", path: "/gone" }).detail).toBe(
      "`xcode-select -p` points at /gone, which is gone. Run `sudo xcode-select -s /Applications/Xcode.app`.",
    );
    expect(xcodeSelectProbe({ kind: "clt-only", path: "/Library/Developer/CommandLineTools" }).detail).toBe(
      "Only the Command Line Tools are selected, so `xcodebuild` cannot run. Point `xcode-select` at a full Xcode.",
    );
    expect(xcodeSelectProbe({ kind: "unlicensed" }).detail).toBe(
      "Xcode's licence has not been accepted. Run `sudo xcodebuild -license accept`.",
    );
  });
});

describe("the Xcode version probe", () => {
  it("warns that #Preview macros silently do not render below 15", () => {
    const probe = xcodeVersionProbe("14.3");
    expect(probe.state).toBe("warn");
    expect(probe.detail).toContain("silently do not render");
    expect(probe.detail).toContain("only PreviewProvider types will");
  });

  it("parses the JSON form and falls back to the first integer run", () => {
    expect(parseXcodeVersion('{"xcodeVersion":"26.6"}')).toBe("26.6");
    expect(parseXcodeVersion("Xcode 26.6\nBuild version 17F113")).toBe("26.6");
    expect(parseXcodeVersion("no version here")).toBeNull();
  });
});

describe("the capture addon probe", () => {
  it("never says `npm rebuild`", () => {
    // serve-sim has no install or gyp script and ships the addon prebuilt, so
    // `npm rebuild` rebuilds nothing and the stranger's one instruction would
    // be a dead end.
    const probe = addonProbe(false, "missing");
    expect(probe.detail).not.toContain("npm rebuild");
    expect(probe.detail).toContain("bb plugin update xcode-simulators");
    expect(probe.detail).toContain("node_modules/serve-sim/dist/native/");
  });
});

describe("the serve-sim version probe", () => {
  it("reports drift rather than failing", () => {
    // The quirk catalogue is reverse-engineered against unversioned internals
    // of a young package. Drift detection is the honest response.
    const probe = serveSimVersionProbe("0.1.52");
    expect(probe.state).toBe("warn");
    expect(probe.detail).toBe(
      "Xcode Simulators was tested against serve-sim 0.1.45; this install has 0.1.52. Live may behave differently.",
    );
  });

  it("is quiet at the pinned version", () => {
    expect(serveSimVersionProbe("0.1.45").state).toBe("ok");
  });

  it("points at the install shape when serve-sim is absent entirely", () => {
    expect(serveSimVersionProbe(null).detail).toContain("git install");
  });
});

describe("the odiff probe", () => {
  it("is a warning, never a blocker", () => {
    // Rendering without diffing is useful; failing the run is not.
    const probe = odiffProbe(null);
    expect(probe.state).toBe("warn");
    expect(probe.detail).toBe("odiff is missing, so previews will render but nothing will be compared.");
  });
});

describe("the overall state", () => {
  it("is the worst thing present", () => {
    const ok = { id: "a", label: "A", state: "ok" as const, detail: "" };
    const warn = { id: "b", label: "B", state: "warn" as const, detail: "" };
    const blocked = { id: "c", label: "C", state: "blocked" as const, detail: "" };
    expect(overallState([ok, ok])).toBe("ok");
    expect(overallState([ok, warn])).toBe("warn");
    expect(overallState([ok, warn, blocked])).toBe("blocked");
  });
});
