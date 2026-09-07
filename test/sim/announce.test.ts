/**
 * A driving session is announced once, at its start, and not again until the
 * thread has been quiet for longer than the window.
 */
import { describe, expect, it } from "vitest";
import { DriveAnnouncer } from "../../src/sim/announce.js";

function announcer(quietMs = 1_000) {
  let now = 0;
  const instance = new DriveAnnouncer(quietMs, () => now);
  return { instance, advance: (ms: number) => (now += ms) };
}

describe("DriveAnnouncer", () => {
  it("announces the first acquisition of a thread", () => {
    const { instance } = announcer();
    expect(instance.touch("thr_a")).toBe(true);
  });

  it("stays silent while the same thread keeps driving inside the window", () => {
    const { instance, advance } = announcer(1_000);
    expect(instance.touch("thr_a")).toBe(true);
    advance(400);
    expect(instance.touch("thr_a")).toBe(false);
    advance(900);
    // 900ms since the last touch, not since the first: the window slides.
    expect(instance.touch("thr_a")).toBe(false);
  });

  it("announces again once the thread has been quiet for longer than the window", () => {
    const { instance, advance } = announcer(1_000);
    instance.touch("thr_a");
    advance(1_001);
    expect(instance.touch("thr_a")).toBe(true);
  });

  it("treats a gap of exactly the window as still driving", () => {
    const { instance, advance } = announcer(1_000);
    instance.touch("thr_a");
    advance(1_000);
    expect(instance.touch("thr_a")).toBe(false);
  });

  it("tracks threads independently", () => {
    const { instance, advance } = announcer(1_000);
    expect(instance.touch("thr_a")).toBe(true);
    advance(100);
    expect(instance.touch("thr_b")).toBe(true);
    advance(100);
    expect(instance.touch("thr_a")).toBe(false);
    expect(instance.touch("thr_b")).toBe(false);
  });

  it("announces again after forget, whatever the clock says", () => {
    const { instance } = announcer(1_000);
    instance.touch("thr_a");
    instance.forget("thr_a");
    expect(instance.touch("thr_a")).toBe(true);
  });
});
