/**
 * The two stream URLs, and which one is a candidate rather than an answer.
 *
 * Pure string composition, so the interesting part — that the direct URL never
 * carries the master secret, and never exists when there is nothing to stream —
 * is provable without a simulator.
 */
import { describe, expect, it } from "vitest";
import { directStreamUrlFor, streamUrlFor } from "../../src/sim/rpc.js";
import type { LiveState } from "../../src/sim/live.js";

const UDID = "11111111-2222-3333-4444-555555555555";
const MASTER = "master-secret-value-that-is-long-enough";
const STREAM = "stream-token-value-that-is-long-enough";

function state(over: Partial<LiveState> = {}): LiveState {
  return {
    kind: "streaming",
    device: { udid: UDID, name: "iPhone 17 Pro", osVersion: "26.5" },
    screen: null,
    foregroundBundleId: null,
    reason: null,
    crashes: 0,
    slowBoot: false,
    generation: 3,
    showDeviceChrome: false,
    ...over,
  } as LiveState;
}

const address = { port: 59505, streamToken: STREAM };

describe("the direct stream URL", () => {
  it("points at the capture host and carries only the stream token", () => {
    const url = directStreamUrlFor(state(), address);
    expect(url).toBe(
      `http://127.0.0.1:59505/helper/${UDID}/stream.mjpeg?k=${STREAM}&g=3`,
    );
    // The master secret also opens the HID socket. It must never be the thing
    // sitting in an <img src> in the DOM.
    expect(url).not.toContain(MASTER);
  });

  it("does not exist when the capture host is down", () => {
    expect(directStreamUrlFor(state(), null)).toBeNull();
  });

  it("exists for exactly the states that have frames to show", () => {
    for (const kind of ["streaming", "waiting-frame", "stalled"] as const) {
      expect(directStreamUrlFor(state({ kind }), address), kind).not.toBeNull();
    }
    for (const kind of ["idle", "booting", "boot-failed", "dead", "erasing"] as const) {
      expect(directStreamUrlFor(state({ kind }), address), kind).toBeNull();
    }
    expect(directStreamUrlFor(state({ device: null }), address)).toBeNull();
  });

  it("changes with the generation, so a restarted host is not reused", () => {
    const before = directStreamUrlFor(state({ generation: 3 }), address);
    const after = directStreamUrlFor(state({ generation: 4 }), address);
    expect(before).not.toBe(after);
  });
});

describe("the proxied stream URL", () => {
  it("stays same-origin and carries no credential at all", () => {
    const url = streamUrlFor("xcode", state());
    expect(url).toBe(`/api/v1/plugins/xcode/http/stream?udid=${UDID}&g=3`);
    expect(url?.startsWith("/")).toBe(true);
    expect(url).not.toContain(STREAM);
    expect(url).not.toContain(MASTER);
  });

  it("is the one the presence route is derived from", () => {
    // The panel rewrites this string rather than composing a second one from a
    // plugin id, so the two can never disagree about where the routes live.
    const url = streamUrlFor("xcode", state());
    expect(url?.replace("/http/stream?", "/http/presence?")).toBe(
      `/api/v1/plugins/xcode/http/presence?udid=${UDID}&g=3`,
    );
  });
});
