/**
 * The pure streaming policies: who may use the direct route, when the decoder
 * queue is too deep, and what the timestamps mean. These are the decisions
 * that used to be discovered by failing — two doomed fetches per stream for a
 * remote viewer, a wedged decoder that looked like a stalled device.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DecoderGeneration,
  DECODE_DROP_AT,
  DECODE_PAUSE_AT,
  DECODE_RESUME_AT,
  shouldDropToKeyframe,
  shouldPauseForDecoder,
  shouldResumeDecoding,
  timestampFor,
  viewerCanReachLoopback,
  waitForDecoderDrain,
} from "../../app/sim/stream-core.js";

afterEach(() => {
  vi.useRealTimers();
});

class FakeFrame {
  closeCalls = 0;

  constructor(readonly id: string) {}

  close(): void {
    this.closeCalls += 1;
  }
}

interface FakeDecoderCallbacks {
  output(frame: FakeFrame): void;
  error(error: string): void;
}

class FakeDecoder {
  closeCalls = 0;

  constructor(readonly callbacks: FakeDecoderCallbacks) {}

  close(): void {
    this.closeCalls += 1;
  }
}

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
    expect(viewerCanReachLoopback({ protocol: "https:", hostname: "remote.example.getbb.app" })).toBe(false);
    expect(viewerCanReachLoopback({ protocol: "http:", hostname: "remote.example.getbb.app" })).toBe(false);
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

  it("bounds a stuck drain wait and removes every listener on the deadline", async () => {
    vi.useFakeTimers();
    const decoder = Object.assign(new EventTarget(), { decodeQueueSize: DECODE_PAUSE_AT + 1 });
    const abort = new AbortController();

    const waiting = expect(
      waitForDecoderDrain(decoder, {
        signal: abort.signal,
        current: () => true,
        timeoutMs: 125,
      }),
    ).rejects.toThrow(/decoder queue did not drain/i);
    await vi.advanceTimersByTimeAsync(125);
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a drain wait immediately when its stream is aborted", async () => {
    vi.useFakeTimers();
    const decoder = Object.assign(new EventTarget(), { decodeQueueSize: DECODE_PAUSE_AT + 1 });
    const abort = new AbortController();
    const waiting = waitForDecoderDrain(decoder, {
      signal: abort.signal,
      current: () => true,
      timeoutMs: 125,
    });

    abort.abort();
    await expect(waiting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
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

describe("decoder generations", () => {
  it("closes replacements once, rejects stale callbacks, and closes every frame", () => {
    const painted: string[] = [];
    const errors: string[] = [];
    const generations = new DecoderGeneration<FakeDecoder, FakeFrame, string>({
      output: (frame) => painted.push(frame.id),
      error: (error) => errors.push(error),
    });

    const first = generations.replace((callbacks) => new FakeDecoder(callbacks));
    const second = generations.replace((callbacks) => {
      expect(first.closeCalls).toBe(1);
      return new FakeDecoder(callbacks);
    });
    const stale = new FakeFrame("stale");
    const current = new FakeFrame("current");
    first.callbacks.output(stale);
    first.callbacks.error("stale error");
    second.callbacks.output(current);

    expect(painted).toEqual(["current"]);
    expect(errors).toEqual([]);
    expect(stale.closeCalls).toBe(1);
    expect(current.closeCalls).toBe(1);
    generations.close();
    generations.close();
    expect(first.closeCalls).toBe(1);
    expect(second.closeCalls).toBe(1);

    const afterClose = new FakeFrame("after close");
    second.callbacks.output(afterClose);
    expect(painted).toEqual(["current"]);
    expect(afterClose.closeCalls).toBe(1);
  });

  it("still closes the frame when the current output handler throws", () => {
    const generations = new DecoderGeneration<FakeDecoder, FakeFrame, string>({
      output: () => {
        throw new Error("paint failed");
      },
      error: () => {},
    });
    const decoder = generations.replace((callbacks) => new FakeDecoder(callbacks));
    const frame = new FakeFrame("current");

    expect(() => decoder.callbacks.output(frame)).toThrow("paint failed");
    expect(frame.closeCalls).toBe(1);
  });
});
