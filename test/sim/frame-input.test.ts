import { describe, expect, it } from "vitest";
import { keyStep, pointerStep, toNormalized, wheelStep } from "../../app/sim/frame-input.js";

const RECT = { left: 100, top: 50, width: 200, height: 400 };

describe("normalizing a pointer", () => {
  it("maps a client point into device coordinates", () => {
    expect(toNormalized(RECT, 200, 250)).toEqual({ x: 0.5, y: 0.5 });
    expect(toNormalized(RECT, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(toNormalized(RECT, 300, 450)).toEqual({ x: 1, y: 1 });
  });

  it("clamps a point dragged outside the frame", () => {
    // Pointer capture keeps a drag alive past the edge; the device has no
    // coordinates out there.
    expect(toNormalized(RECT, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(toNormalized(RECT, 9999, 9999)).toEqual({ x: 1, y: 1 });
  });

  it("does not divide by zero before the frame has a size", () => {
    expect(toNormalized({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toEqual({ x: 0, y: 0 });
  });
});

describe("pointer gestures", () => {
  const at = { x: 0.5, y: 0.5 };

  it("treats a shaky hand as a tap", () => {
    expect(pointerStep(at, { x: 0.505, y: 0.505 }, 80)).toEqual({ kind: "tap", at });
  });

  it("treats a slow press in place as a long press", () => {
    expect(pointerStep(at, at, 800)).toEqual({ kind: "longPress", at, holdMs: 800 });
  });

  it("treats real movement as a swipe, at the duration it actually took", () => {
    // A 250ms swipe where the user spent a second is a different gesture, and
    // iOS's own recognizers care.
    expect(pointerStep(at, { x: 0.5, y: 0.1 }, 900)).toEqual({
      kind: "swipe",
      from: at,
      to: { x: 0.5, y: 0.1 },
      durationMs: 900,
    });
  });

  it("bounds an absurd duration rather than passing it through", () => {
    const step = pointerStep(at, { x: 0.9, y: 0.9 }, 99_999);
    expect(step).toMatchObject({ kind: "swipe", durationMs: 3000 });
  });
});

describe("the keyboard contract", () => {
  const key = (over: Partial<Parameters<typeof keyStep>[0]>) =>
    keyStep({ key: "a", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...over }, false);

  it("moves a crosshair with the arrows rather than forwarding them", () => {
    // Keyboard users need a way to reach a point on the device at all.
    expect(key({ key: "ArrowRight" })).toEqual({ kind: "move", dx: 0.02, dy: 0 });
    expect(key({ key: "ArrowUp" })).toEqual({ kind: "move", dx: 0, dy: -0.02 });
    expect(key({ key: "ArrowDown", shiftKey: true })).toEqual({ kind: "move", dx: 0, dy: 0.1 });
  });

  it("taps the crosshair with Return once there is one", () => {
    const noCrosshair = keyStep(
      { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false },
      false,
    );
    expect(noCrosshair).toEqual({ kind: "step", step: { kind: "key", name: "enter" } });

    const withCrosshair = keyStep(
      { key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, altKey: false },
      true,
    );
    expect(withCrosshair).toEqual({ kind: "tap-crosshair" });
  });

  it("gives focus back on Escape rather than trapping it", () => {
    expect(key({ key: "Escape" })).toEqual({ kind: "release" });
  });

  it("never swallows a host shortcut", () => {
    // Command-K belongs to bb, not to the device.
    expect(key({ key: "k", metaKey: true })).toEqual({ kind: "ignore" });
    expect(key({ key: "c", ctrlKey: true })).toEqual({ kind: "ignore" });
  });

  it("lets Tab move focus out of a video", () => {
    expect(key({ key: "Tab" })).toEqual({ kind: "ignore" });
  });

  it("types a printable character and ignores everything else", () => {
    expect(key({ key: "a" })).toEqual({ kind: "step", step: { kind: "type", text: "a" } });
    expect(key({ key: "€" })).toEqual({ kind: "step", step: { kind: "type", text: "€" } });
    expect(key({ key: "Backspace" })).toEqual({ kind: "step", step: { kind: "key", name: "backspace" } });
    expect(key({ key: "F5" })).toEqual({ kind: "ignore" });
    expect(key({ key: "Dead" })).toEqual({ kind: "ignore" });
  });
});

describe("the wheel", () => {
  it("converts pixels of content into a normalized fraction", () => {
    expect(wheelStep(RECT, 0, 40)).toEqual({ kind: "scroll", dx: 0, dy: 0.1 });
  });

  it("clamps a trackpad fling rather than sending a fraction above one", () => {
    expect(wheelStep(RECT, 0, 9999)).toEqual({ kind: "scroll", dx: 0, dy: 1 });
    expect(wheelStep(RECT, 0, -9999)).toEqual({ kind: "scroll", dx: 0, dy: -1 });
  });

  it("says nothing when nothing moved", () => {
    expect(wheelStep(RECT, 0, 0)).toBeNull();
    expect(wheelStep({ left: 0, top: 0, width: 0, height: 0 }, 0, 10)).toBeNull();
  });
});
