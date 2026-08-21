import { describe, expect, it } from "vitest";
import { appLabel, liveVeil, metaLine } from "../../app/sim/copy.js";
import type { DeviceList, LiveState } from "../../app/sim/useLive.js";

/**
 * One assertion per named state from the design, against **the sentence**.
 *
 * The sentence is the contract — a class name is not. `liveVeil` is a pure
 * function of state precisely so this suite needs no DOM, no bb and no Mac.
 */
function state(over: Partial<LiveState> = {}): LiveState {
  return {
    kind: "idle",
    device: null,
    screen: null,
    foregroundBundleId: null,
    reason: null,
    crashes: 0,
    slowBoot: false,
    streamUrl: null,
    directStreamUrl: null,
    generation: 0,
    showDeviceChrome: false,
    ...over,
  };
}

const IPHONE = { udid: "u1", name: "iPhone 17 Pro", osVersion: "26.5" };
const IPAD = { udid: "u2", name: "iPad Pro 13-inch", osVersion: "26.5" };

function devices(over: Partial<DeviceList> = {}): DeviceList {
  return {
    devices: [
      { udid: IPHONE.udid, name: IPHONE.name, state: "Shutdown", osVersion: "26.5", platform: "iOS", family: "iphone", isAvailable: true, lastBootedAt: null, lastBuiltAt: null },
      { udid: IPAD.udid, name: IPAD.name, state: "Shutdown", osVersion: "26.5", platform: "iPadOS", family: "ipad", isAvailable: true, lastBootedAt: null, lastBuiltAt: null },
    ],
    bootedUdids: [],
    suggested: IPHONE,
    hasDrivableRuntime: true,
    installedPlatforms: ["iOS", "iPadOS"],
    machine: null,
    otherMachines: [],
    error: null,
    ...over,
  };
}

describe("first mount", () => {
  it("is a skeleton with no text and no spinner", () => {
    // The one honest place for a skeleton: there is no previous verdict to keep,
    // and "No simulator is running" would be a guess.
    const veil = liveVeil(null, null);
    expect(veil.skeleton).toBe(true);
    expect(veil.sentence).toBeNull();
    expect(veil.actions).toEqual([]);
  });
});

describe("nothing chosen", () => {
  it("says no simulator is running, and names the one it would boot", () => {
    const veil = liveVeil(state(), devices());
    expect(veil.sentence).toBe("No simulator is running.");
    expect(veil.actions).toEqual([{ label: "Boot iPhone 17 Pro", kind: "boot", udid: "u1" }]);
  });

  it("names what is already running, and offers to watch it", () => {
    const veil = liveVeil(
      state(),
      devices({ bootedUdids: [IPHONE.udid, IPAD.udid] }),
    );
    expect(veil.sentence).toBe("iPhone 17 Pro and iPad Pro 13-inch are already running.");
    expect(veil.actions[0]?.label).toBe("Watch iPhone 17 Pro");
  });
});

describe("no runtimes", () => {
  it("says where to get one", () => {
    const veil = liveVeil(
      state(),
      devices({ hasDrivableRuntime: false, installedPlatforms: [], suggested: null }),
    );
    expect(veil.sentence).toBe(
      "No simulator runtimes are installed. Open Xcode → Settings → Components, download an iOS runtime, then press Refresh.",
    );
  });

  it("names what *is* installed when nothing drivable is", () => {
    // The difference between a dead end and a fixable situation.
    const veil = liveVeil(
      state(),
      devices({ hasDrivableRuntime: false, installedPlatforms: ["watchOS"], suggested: null }),
    );
    expect(veil.sentence).toBe(
      "Xcode Simulators's Live mode drives iOS, iPadOS and tvOS simulators. The only runtime installed here is watchOS.",
    );
  });
});

describe("booting", () => {
  it("promises about twenty seconds", () => {
    const veil = liveVeil(state({ kind: "booting", device: IPHONE }), devices());
    expect(veil.sentence).toBe("Booting iPhone 17 Pro — about twenty seconds the first time.");
  });

  it("ages the promise rather than letting it read as a hang", () => {
    const veil = liveVeil(state({ kind: "booting", device: IPHONE, slowBoot: true }), devices());
    expect(veil.sentence).toBe(
      "Still booting — a first boot after an Xcode update can take a few minutes.",
    );
  });
});

describe("boot failed", () => {
  it("shows the reason from simctl, with the fix in it", () => {
    const veil = liveVeil(
      state({
        kind: "boot-failed",
        device: IPHONE,
        reason: "iOS 26.5 is not downloaded. Get it in Xcode → Settings → Components.",
      }),
      devices(),
    );
    expect(veil.sentence).toBe("iOS 26.5 is not downloaded. Get it in Xcode → Settings → Components.");
    expect(veil.tone).toBe("dead");
    expect(veil.actions[0]?.kind).toBe("retry");
  });
});

describe("waiting for the first frame", () => {
  it("is a real state, not a loading state", () => {
    // `/config` reports 0×0 until the first MJPEG callback, and a spinner here
    // reads as broken.
    const veil = liveVeil(state({ kind: "waiting-frame", device: IPHONE }), devices());
    expect(veil.sentence).toBe("Waiting for the first frame.");
    expect(veil.skeleton).toBe(false);
  });
});

describe("streaming", () => {
  it("says nothing at all, and lights the dot", () => {
    const veil = liveVeil(state({ kind: "streaming", device: IPHONE }), devices());
    expect(veil.sentence).toBeNull();
    expect(veil.tone).toBe("live");
  });
});

describe("stalled", () => {
  it("blames nothing until it has looked", () => {
    const veil = liveVeil(state({ kind: "stalled", device: IPHONE }), devices());
    expect(veil.sentence).toBe("The stream stopped. Checking the simulator.");
    expect(veil.tone).toBe("stalled");
  });
});

describe("the capture host restarting", () => {
  it("names the capture process rather than blaming the device", () => {
    // Without this state the crash falls through to "the stream stopped,
    // checking the simulator", which sends the user to reboot a healthy device.
    const veil = liveVeil(state({ kind: "host-restarted", device: IPHONE, crashes: 1 }), devices());
    expect(veil.sentence).toBe(
      "Xcode Simulators's capture process restarted. Reconnecting to iPhone 17 Pro.",
    );
    expect(veil.tone).toBe("stalled");
  });

  it("escalates on the second crash inside a minute", () => {
    const veil = liveVeil(state({ kind: "host-restarted", device: IPHONE, crashes: 2 }), devices());
    expect(veil.sentence).toBe("The capture process has crashed twice.");
    expect(veil.detail).toBe("`bb plugin logs xcode-simulators` has the reason.");
    expect(veil.tone).toBe("dead");
  });
});

describe("erasing", () => {
  it("has its own state, because erase shuts the device down", () => {
    // Without it the panel says "iPhone 17 Pro shut down" seconds after you
    // asked it to erase, which reads as a crash.
    const veil = liveVeil(state({ kind: "erasing", device: IPHONE }), devices());
    expect(veil.sentence).toBe("Erasing iPhone 17 Pro — it will come back in a moment.");
  });
});

describe("the device going away", () => {
  it("says so and offers to bring it back", () => {
    const veil = liveVeil(state({ kind: "dead", device: IPHONE }), devices());
    expect(veil.sentence).toBe("iPhone 17 Pro shut down.");
    expect(veil.tone).toBe("dead");
    expect(veil.actions).toEqual([{ label: "Boot it again", kind: "boot", udid: "u1" }]);
  });
});

describe("Intel", () => {
  it("blames the capture path rather than the binary, and says Stills still work", () => {
    const veil = liveVeil(state({ kind: "intel-blocked" }), devices());
    expect(veil.sentence).toContain("universal binary and will load on Intel");
    expect(veil.detail).toContain("Stills work here");
    expect(veil.detail).toContain("allowIntelLive");
  });

  it("has a distinct state for the addon loading and producing nothing", () => {
    const veil = liveVeil(state({ kind: "intel-failed" }), devices());
    expect(veil.sentence).toBe(
      "Live could not start on this Intel Mac — the capture addon loaded but produced no frames. Stills still work.",
    );
  });
});

describe("simctl failing", () => {
  it("is never rendered as an empty device list", () => {
    const veil = liveVeil(state({ kind: "simctl-failed", reason: "xcrun: error" }), devices());
    expect(veil.sentence).toBe(
      "Xcode Simulators could not ask about simulators — `xcrun simctl list` failed.",
    );
  });

  it("surfaces the device list's own failure while idle", () => {
    const veil = liveVeil(
      state(),
      devices({ error: "Xcode Simulators could not ask about simulators — xcrun: error" }),
    );
    expect(veil.sentence).toContain("could not ask about simulators");
  });
});

describe("a bb server that is not on macOS", () => {
  it("explains rather than showing an empty panel", () => {
    const veil = liveVeil(state({ kind: "unsupported" }), null);
    expect(veil.sentence).toContain("only works when the bb server itself runs on macOS");
  });
});

describe("the meta line", () => {
  it("reads as a sentence, with the app named rather than its bundle id", () => {
    expect(metaLine(state({ kind: "streaming", device: IPHONE, foregroundBundleId: "com.example.almanac" }))).toBe(
      "Almanac on iPhone 17 Pro, iOS 26.5",
    );
  });

  it("says home screen rather than naming SpringBoard", () => {
    expect(
      metaLine(state({ kind: "streaming", device: IPHONE, foregroundBundleId: "com.apple.springboard" })),
    ).toBe("Home screen on iPhone 17 Pro, iOS 26.5");
    expect(metaLine(state({ kind: "streaming", device: IPHONE }))).toBe(
      "Home screen on iPhone 17 Pro, iOS 26.5",
    );
  });

  it("says nothing at all when there is no device", () => {
    expect(metaLine(state())).toBeNull();
  });

  it("derives a label from the last component of a bundle id", () => {
    expect(appLabel("com.example.almanac")).toBe("Almanac");
    expect(appLabel(null)).toBeNull();
    expect(appLabel("")).toBeNull();
  });
});

describe("the stream the browser could not load", () => {
  /**
   * The reported bug: a broken-image icon and no text.
   *
   * The panel opens `/stream?udid=…` in an `<img>`. When the simulator has shut
   * down since the last poll that route answers 409, the element renders the
   * browser's own torn-page glyph, and the server — which still believes it is
   * streaming — supplies no sentence at all. Measured on a real machine: the
   * device was shut down by other tooling between the poll and the request.
   */
  it("says what happened instead of leaving a broken image with no text", () => {
    const streaming = state({
      kind: "streaming",
      device: IPHONE,
      streamUrl: "/api/v1/plugins/xcode/http/stream?udid=u1",
    });

    // What the server thinks: everything is fine, so there is nothing to say.
    expect(liveVeil(streaming, devices()).sentence).toBeNull();

    // What the browser knows, which is strictly newer.
    const veil = liveVeil(streaming, devices(), true);
    expect(veil.sentence).toBe("iPhone 17 Pro stopped sending frames.");
    expect(veil.detail).toContain("shut down");
    expect(veil.actions.map((action) => action.kind)).toEqual(["refresh", "boot"]);
    expect(veil.actions[1]?.udid).toBe(IPHONE.udid);
    expect(veil.skeleton).toBe(false);
  });

  it("still names a device it does not know, rather than saying nothing", () => {
    const veil = liveVeil(state({ kind: "streaming" }), devices(), true);
    expect(veil.sentence).toBe("The simulator stopped sending frames.");
    // With no device there is nothing to offer a boot for.
    expect(veil.actions.map((action) => action.kind)).toEqual(["refresh"]);
  });

  it("outranks first mount only when there is a state at all", () => {
    // A failure reported before any state has arrived must not replace the
    // skeleton with a sentence about a device nobody has chosen yet.
    expect(liveVeil(null, null, true).skeleton).toBe(true);
  });
});
