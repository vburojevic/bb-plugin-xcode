/**
 * The pure streaming policies: who may use the direct route, when the decoder
 * queue is too deep, and what the timestamps mean. These are the decisions
 * that used to be discovered by failing — two doomed fetches per stream for a
 * remote viewer, a wedged decoder that looked like a stalled device.
 */
import { describe, expect, it } from "vitest";
import {
  DECODE_DROP_AT,
  DECODE_PAUSE_AT,
  DECODE_RESUME_AT,
  shouldDropToKeyframe,
  shouldPauseForDecoder,
  shouldResumeDecoding,
  timestampFor,
  viewerCanReachLoopback,
} from "../../app/sim/stream-core.js";

describe("who may use the direct route", () => {
  it("a loopback http page may", () => {
    expect(viewerCanReachLoopback({ protocol: "http:", hostname: "localhost" })).toBe(true);
    expect(viewerCanReachLoopback({ protocol: "http:", hostname: "127.0.0.1" })).toBe(true);
    expect(viewerCanReachLoopback({ protocol: "http:", hostname: "[::1]" })).toBe(true);
  });

  it("an https page may not, even on localhost — mixed content blocks it", () => {
    expect(viewerCanReachLoopback({ protocol: "https:", hostname: "localhost" })).toBe(false);
  });

  it("a page on another host may not — its 127.0.0.1 is the wrong machine", () => {
    // Every remote bb viewer looks like this.
    expect(viewerCanReachLoopback({ protocol: "https:", hostname: "veki.getbb.app" })).toBe(false);
    expect(viewerCanReachLoopback({ protocol: "http:", hostname: "veki.getbb.app" })).toBe(false);
  });
});

describe("decoder backpressure", () => {
  it("pauses above the high water mark and resumes below the low one", () => {
    expect(shouldPauseForDecoder(DECODE_PAUSE_AT + 1)).toBe(true);
    expect(shouldPauseForDecoder(DECODE_PAUSE_AT)).toBe(false);
    expect(shouldResumeDecoding(DECODE_RESUME_AT)).toBe(true);
    expect(shouldResumeDecoding(DECODE_RESUME_AT + 1)).toBe(false);
    // Hysteresis: between the two, neither fires, so the state holds.
    expect(DECODE_RESUME_AT).toBeLessThan(DECODE_PAUSE_AT);
  });

  it("drops to keyframes only when the queue is deep", () => {
    expect(shouldDropToKeyframe(DECODE_DROP_AT + 1)).toBe(true);
    expect(shouldDropToKeyframe(DECODE_DROP_AT)).toBe(false);
    // Dropping begins far above pausing: pause first, drop only when losing.
    expect(DECODE_DROP_AT).toBeGreaterThan(DECODE_PAUSE_AT);
  });
});

describe("timestamps", () => {
  it("is strictly increasing, which is all the decoder requires", () => {
    expect(timestampFor(1)).toBeGreaterThan(timestampFor(0));
    expect(timestampFor(100)).toBeGreaterThan(timestampFor(99));
  });

  it("steps at a 30 fps cadence, not the old 1000 fps nonsense", () => {
    expect(timestampFor(1) - timestampFor(0)).toBe(33_333);
  });
});
