import { describe, expect, it } from "vitest";
import { bannerRows, changedIdentitiesOf, failureSentence, MAX_ROWS } from "../../src/sim/banner.js";
import { watermarkOf } from "../../src/sim/model.js";
import { allowsFrame, parseViewerPath, REMOTE_BUTTONS, viewerPage } from "../../src/sim/viewer.js";
import { consentText, ExposureGuard, HIDDEN_LINK, IDLE_TEARDOWN_MS } from "../../src/sim/guard.js";
import { CONNECT_REASONS, detectConnect, publicUrl, TEARDOWN_WARNING } from "../../src/sim/connect.js";
import { TAG } from "../../src/sim/hid.js";
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
  it("puts a failed run above a settled one", () => {
    // A run you kicked off and walked away from must tell you when it dies, in
    // the surface whose whole purpose is telling you about work you are not
    // watching.
    const rows = bannerRows({
      look: look({ status: "failed", error: "Build failed (exit 65)." }),
      dismissed: null,
      exposure: null,
      offerRuns: true,
    });
    expect(rows[0]?.kind).toBe("failure");
    expect(rows[0]?.sentence).toBe("Preview render failed — the build did not compile.");
  });

  it("puts an exposure above everything, because a trust state outranks a liveness one", () => {
    const rows = bannerRows({
      look: look({ changedIdentities: ["preview:a.png"] }),
      dismissed: null,
      exposure: { msLeft: 27 * 60_000 },
      offerRuns: true,
    });
    expect(rows[0]?.kind).toBe("exposure");
    expect(rows[0]?.sentence).toBe("Simulator exposed to your bb account — 27 more minutes");
  });

  it("never shows more than two rows", () => {
    const rows = bannerRows({
      look: look({ status: "failed", error: "x" }),
      dismissed: null,
      exposure: { msLeft: 60_000 },
      offerRuns: true,
    });
    expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
  });
});

describe("the dismissal watermark", () => {
  it("is the set of changed identities, so the same twelve stay gone", () => {
    const twelve = Array.from({ length: 12 }, (_unused, index) => `preview:${index}.png`);
    const rows = bannerRows({
      look: look({ changedIdentities: twelve }),
      dismissed: watermarkOf(twelve),
      exposure: null,
      offerRuns: true,
    });
    expect(rows).toEqual([]);
  });

  it("returns the moment a thirteenth changes", () => {
    const twelve = Array.from({ length: 12 }, (_unused, index) => `preview:${index}.png`);
    const rows = bannerRows({
      look: look({ changedIdentities: [...twelve, "preview:new.png"] }),
      dismissed: watermarkOf(twelve),
      exposure: null,
      offerRuns: true,
    });
    expect(rows[0]?.sentence).toBe("13 previews moved since `a1b2c3d`");
  });

  it("watermarks a failure on the look id, because there is no changed set", () => {
    const failed = look({ status: "failed", error: "x" });
    const rows = bannerRows({ look: failed, dismissed: "failed:lk_1", exposure: null, offerRuns: true });
    expect(rows).toEqual([]);
  });
});

describe("the banner's other rules", () => {
  it("shows a progress row that cannot be dismissed", () => {
    // It is not something you dismiss; it goes when it is done.
    const rows = bannerRows({
      look: look({ status: "running", frameCount: 41, expectedCount: 148 }),
      dismissed: null,
      exposure: null,
      offerRuns: true,
    });
    expect(rows[0]?.sentence).toBe("Rendering previews — 41/148");
    expect(rows[0]?.dismissible).toBe(false);
  });

  it("is indeterminate when the manifest gave no denominator", () => {
    const rows = bannerRows({
      look: look({ status: "running", expectedCount: null }),
      dismissed: null,
      exposure: null,
      offerRuns: true,
    });
    expect(rows[0]?.sentence).toBe("Rendering previews…");
  });

  it("offers nothing when the user turned the offer off", () => {
    const rows = bannerRows({
      look: look({ changedIdentities: ["preview:a.png"] }),
      dismissed: null,
      exposure: null,
      offerRuns: false,
    });
    expect(rows).toEqual([]);
  });

  it("still shows an exposure when run offers are off, because it is not an offer", () => {
    const rows = bannerRows({
      look: null,
      dismissed: null,
      exposure: { msLeft: 60_000 },
      offerRuns: false,
    });
    expect(rows[0]?.kind).toBe("exposure");
    expect(rows[0]?.dismissible).toBe(false);
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

describe("the exposure guard", () => {
  it("holds at most one exposure", () => {
    const ended: string[] = [];
    const guard = new ExposureGuard({ onEnd: (_exposure, reason) => ended.push(reason) });
    guard.start({ udid: "u1", deviceName: "A", port: 1, url: "", ttlMs: 60_000 });
    guard.start({ udid: "u2", deviceName: "B", port: 2, url: "", ttlMs: 60_000 });
    expect(ended).toEqual(["stopped"]);
    expect(guard.current()?.udid).toBe("u2");
  });

  it("expires on its TTL without a timer having to fire", () => {
    let now = 1000;
    const guard = new ExposureGuard({ onEnd: () => {}, now: () => now });
    guard.start({ udid: "u", deviceName: "A", port: 1, url: "", ttlMs: 60_000 });
    now += 60_001;
    expect(guard.current()).toBeNull();
    expect(guard.summary()).toBeNull();
  });

  it("ends when the device it was exposing goes away", () => {
    // An exposure of a dead device is a live URL to nothing.
    const ended: string[] = [];
    const guard = new ExposureGuard({ onEnd: (_e, reason) => ended.push(reason) });
    guard.start({ udid: "u1", deviceName: "A", port: 1, url: "", ttlMs: 60_000 });
    guard.noteDeviceGone("other");
    expect(guard.current()).not.toBeNull();
    guard.noteDeviceGone("u1");
    expect(guard.current()).toBeNull();
    expect(ended).toEqual(["device-gone"]);
  });

  it("validates only its own token", () => {
    const guard = new ExposureGuard({ onEnd: () => {} });
    const exposure = guard.start({ udid: "u", deviceName: "A", port: 1, url: "", ttlMs: 60_000 });
    expect(guard.isValid(exposure.token)).toBe(true);
    expect(guard.isValid("x".repeat(exposure.token.length))).toBe(false);
    expect(guard.isValid("")).toBe(false);
    guard.end("stopped");
    expect(guard.isValid(exposure.token)).toBe(false);
  });

  it("mints a fresh token every time", () => {
    const guard = new ExposureGuard({ onEnd: () => {} });
    const first = guard.start({ udid: "u", deviceName: "A", port: 1, url: "", ttlMs: 60_000 }).token;
    const second = guard.start({ udid: "u", deviceName: "A", port: 1, url: "", ttlMs: 60_000 }).token;
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("waits five minutes rather than one before an idle teardown", () => {
    // Un-declaring a port restarts the host's whole tunnel, dropping other
    // plugins' shares. Sixty seconds would do that far too eagerly.
    expect(IDLE_TEARDOWN_MS).toBe(5 * 60_000);
  });
});

describe("the consent dialog", () => {
  it("states three facts in words and names the duration on the button", () => {
    const consent = consentText({
      deviceName: "iPhone 17 Pro",
      foregroundBundleId: "com.example.almanac",
      minutes: 30,
    });
    expect(consent.confirmLabel).toBe("Expose for 30 minutes");
    expect(consent.facts[0]).toContain("com.example.almanac");
    expect(consent.facts[1]).toContain("Anyone signed in to your bb account");
    expect(consent.facts[1]).toContain("still a real one");
    expect(consent.facts[2]).toContain("30 minutes");
    // Stopping it interrupts other shares; saying so is the difference between
    // a known cost and someone blaming their dev server.
    expect(consent.facts[3]).toContain("interrupts other shares");
  });

  it("says home screen rather than naming nothing", () => {
    const consent = consentText({ deviceName: "iPhone 17 Pro", foregroundBundleId: null, minutes: 5 });
    expect(consent.facts[0]).toContain("home screen");
  });

  it("never puts the link in a status read", () => {
    expect(HIDDEN_LINK).toBe("exposed (link hidden — reopen the panel)");
  });
});

describe("the viewer's boundary", () => {
  it("serves only the token shape", () => {
    expect(parseViewerPath("/s/abcdefghijklmnop/stream.mjpeg")).toEqual({
      token: "abcdefghijklmnop",
      what: "stream.mjpeg",
    });
    expect(parseViewerPath("/s/short/config")).toBeNull();
    expect(parseViewerPath("/api")).toBeNull();
    expect(parseViewerPath("/exec")).toBeNull();
    expect(parseViewerPath("/s/../../etc/passwd")).toBeNull();
  });

  it("passes the viewing tags and drops the debugging ones", () => {
    const frame = (tag: number, body?: unknown) =>
      body === undefined
        ? Buffer.from([tag])
        : Buffer.concat([Buffer.from([tag]), Buffer.from(JSON.stringify(body))]);

    expect(allowsFrame(frame(TAG.touch, { type: "begin", x: 0.5, y: 0.5 }))).toBe(true);
    expect(allowsFrame(frame(TAG.multiTouch, { type: "begin" }))).toBe(true);
    expect(allowsFrame(frame(TAG.key, { type: "down", usage: 4 }))).toBe(true);
    expect(allowsFrame(frame(TAG.orientation, { orientation: "portrait" }))).toBe(true);
    expect(allowsFrame(frame(TAG.scroll, { dx: 0, dy: 0.1 }))).toBe(true);
    expect(allowsFrame(frame(TAG.softwareKeyboard))).toBe(true);

    // Debugging affordances, not viewing affordances, and they change the
    // device's behaviour.
    expect(allowsFrame(frame(TAG.caDebug, { option: "debug_color_blended", enabled: true }))).toBe(false);
    expect(allowsFrame(frame(TAG.memoryWarning))).toBe(false);
    expect(allowsFrame(frame(TAG.digitalCrown, { delta: 1 }))).toBe(false);
    expect(allowsFrame(Buffer.alloc(0))).toBe(false);
  });

  it("allows only three buttons across the remote boundary", () => {
    const button = (name: string) =>
      Buffer.concat([Buffer.from([TAG.button]), Buffer.from(JSON.stringify({ button: name }))]);
    expect([...REMOTE_BUTTONS].sort()).toEqual(["app_switcher", "home", "swipe_home"]);
    expect(allowsFrame(button("home"))).toBe(true);
    expect(allowsFrame(button("app_switcher"))).toBe(true);
    // `lock` and `siri` change the device in ways a remote viewer cannot undo.
    expect(allowsFrame(button("lock"))).toBe(false);
    expect(allowsFrame(button("siri"))).toBe(false);
    expect(allowsFrame(Buffer.from([TAG.button]))).toBe(false);
  });

  it("serves a page that loads nothing from anywhere else", () => {
    const page = viewerPage(false);
    expect(page).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/);
    // Coarse pointers: the frame must not pan, zoom or select under a finger.
    expect(page).toContain("touch-action: none");
    expect(page).toContain("viewport-fit=cover");
    expect(page).toContain("env(safe-area-inset-top)");
    // The simulator's software keyboard is not reachable from a remote viewer.
    expect(page).toContain("keys.focus()");
  });
});

describe("connect detection", () => {
  const base = {
    connectStatus: async () => ({ paired: true }),
    ensureTunnel: async () => ({ label: "abc", baseDomain: "example.invalid" }),
    hostId: () => "host_1",
  };

  it("is unavailable when connect is not installed", async () => {
    const state = await detectConnect({ ...base, plugins: async () => [] });
    expect(state).toEqual({
      available: false,
      reason: "not-installed",
      detail: CONNECT_REASONS["not-installed"],
    });
  });

  it("is unavailable when connect is installed but disabled", async () => {
    const state = await detectConnect({
      ...base,
      plugins: async () => [{ id: "connect", enabled: false, status: "running" }],
    });
    expect(state.available).toBe(false);
  });

  it("accepts a degraded peer, which is still callable", async () => {
    const state = await detectConnect({
      ...base,
      plugins: async () => [{ id: "connect", enabled: true, status: "degraded" }],
    });
    expect(state.available).toBe(true);
  });

  it("falls through when the peer's contract moved rather than failing", async () => {
    // `unknown_method` means the peer changed; the tunnel is authoritative.
    const state = await detectConnect({
      ...base,
      plugins: async () => [{ id: "connect", enabled: true, status: "running" }],
      connectStatus: async () => {
        throw new Error("unknown_method");
      },
    });
    expect(state.available).toBe(true);
  });

  it("says pair it when the tunnel cannot be assigned", async () => {
    const state = await detectConnect({
      ...base,
      plugins: async () => [{ id: "connect", enabled: true, status: "running" }],
      ensureTunnel: async () => {
        throw new Error("no enrollment");
      },
    });
    expect(state.available).toBe(false);
    if (!state.available) expect(state.detail).toContain("pair it in Settings");
  });

  it("composes the public URL from the daemon's own label and domain", () => {
    expect(publicUrl("abc", "example.invalid", 51234, "tok")).toBe(
      "https://abc--51234.example.invalid/s/tok/",
    );
  });

  it("carries the teardown warning as a stated cost", () => {
    expect(TEARDOWN_WARNING).toContain("interrupts other shares");
  });
});
