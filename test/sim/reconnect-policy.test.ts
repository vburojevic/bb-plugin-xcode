import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isStreamRecoveryEvidence,
  RetryBudget,
  VisibleReattachGate,
} from "../../app/sim/reconnect-policy.js";

describe("the full-ladder retry budget", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("offers exactly three retries at 250 ms, 1 s, and 3 s before exhaustion", async () => {
    const retry = vi.fn();
    const budget = new RetryBudget();

    expect(budget.schedule(retry)).toBe(true);
    await vi.advanceTimersByTimeAsync(249);
    expect(retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(1);

    expect(budget.schedule(retry)).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(retry).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(2);

    expect(budget.schedule(retry)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(retry).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(3);

    expect(budget.schedule(retry)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one pending retry and clears it on a painted frame", async () => {
    const retry = vi.fn();
    const budget = new RetryBudget();

    expect(budget.schedule(retry)).toBe(true);
    expect(budget.schedule(retry)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);

    budget.reset();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(retry).not.toHaveBeenCalled();

    // A painted frame earns a complete fresh ladder, beginning at 250 ms.
    expect(budget.schedule(retry)).toBe(true);
    await vi.advanceTimersByTimeAsync(249);
    expect(retry).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("cancels its only timeout without manufacturing a retry", async () => {
    const retry = vi.fn();
    const budget = new RetryBudget();

    expect(budget.schedule(retry)).toBe(true);
    budget.cancel();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it("does not treat an H.264 bootstrap JPEG as codec recovery", () => {
    expect(isStreamRecoveryEvidence("h264", "bootstrap")).toBe(false);
    expect(isStreamRecoveryEvidence("h264", "decoded")).toBe(true);
    expect(isStreamRecoveryEvidence("mjpeg", "decoded")).toBe(true);
  });
});

describe("a visible parked selection", () => {
  it("issues one reattach until the stream identity changes", async () => {
    const reattach = vi.fn(() => Promise.resolve());
    const gate = new VisibleReattachGate();
    const parked = {
      kind: "waiting-frame",
      device: { udid: "11111111-2222-3333-4444-555555555555" },
      // The same-origin proxy URL is composable while the host is parked; the
      // absent direct URL is the server's proof that there is no child behind it.
      streamUrl: "/stream?g=4",
      directStreamUrl: null,
      generation: 4,
    };

    gate.update(parked, true, reattach);
    gate.update(parked, true, reattach);
    await Promise.resolve();
    expect(reattach).toHaveBeenCalledTimes(1);
    expect(reattach).toHaveBeenCalledWith(parked.device.udid);

    gate.update({ ...parked, directStreamUrl: "http://127.0.0.1/stream?g=5", generation: 5 }, true, reattach);
    gate.update({ ...parked, generation: 5 }, true, reattach);
    await Promise.resolve();
    expect(reattach).toHaveBeenCalledTimes(2);
  });

  it("does no work while hidden and treats the next visible session as fresh", async () => {
    const reattach = vi.fn(() => Promise.resolve());
    const gate = new VisibleReattachGate();
    const parked = {
      kind: "waiting-frame",
      device: { udid: "11111111-2222-3333-4444-555555555555" },
      streamUrl: "/stream?g=4",
      directStreamUrl: null,
      generation: 4,
    };

    gate.update(parked, false, reattach);
    expect(reattach).not.toHaveBeenCalled();
    gate.update(parked, true, reattach);
    gate.update(parked, false, reattach);
    gate.update(parked, true, reattach);
    await Promise.resolve();
    expect(reattach).toHaveBeenCalledTimes(2);
  });
});
