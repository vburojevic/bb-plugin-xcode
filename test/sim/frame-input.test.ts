import { describe, expect, it } from "vitest";
import {
  contentRect,
  keyStep,
  PINCH_INITIAL_SPREAD,
  PINCH_MAX_SPREAD,
  PINCH_MIN_SPREAD,
  pinchFingers,
  pinchSpread,
  toNormalized,
  wheelStep,
} from "../../app/sim/frame-input.js";

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

  it("anchors the scroll under the cursor when a position is given", () => {
    // The list being pointed at is the list that should scroll — not whatever
    // happens to sit at the device's centre.
    expect(wheelStep(RECT, 0, 40, { x: 0.25, y: 0.75 })).toEqual({
      kind: "scroll",
      dx: 0,
      dy: 0.1,
      at: { x: 0.25, y: 0.75 },
    });
  });

  it("clamps a trackpad fling rather than sending a fraction above one", () => {
    expect(wheelStep(RECT, 0, 9999)).toEqual({ kind: "scroll", dx: 0, dy: 1 });
    expect(wheelStep(RECT, 0, -9999)).toEqual({ kind: "scroll", dx: 0, dy: -1 });
  });

  it("says nothing when nothing moved", () => {
    expect(wheelStep(RECT, 0, 0)).toBeNull();
    expect(wheelStep({ left: 0, top: 0, width: 0, height: 0 }, 0, 10)).toBeNull();
  });

  it("translates line-mode deltas — a remote viewer's Firefox sends lines, not pixels", () => {
    // 3 lines over a 400px-tall frame: 3 × 16px = 48px = 0.12. Read as raw
    // pixels it would be 0.0075 — a sixteenth of the intended scroll.
    expect(wheelStep(RECT, 0, 3, undefined, 1)).toEqual({ kind: "scroll", dx: 0, dy: 0.12 });
  });

  it("translates page-mode deltas as a fraction of the frame", () => {
    expect(wheelStep(RECT, 0, 0.5, undefined, 2)).toEqual({ kind: "scroll", dx: 0, dy: 0.5 });
  });
});

describe("the letterbox", () => {
  const screen = { width: 1320, height: 2868 };

  it("maps a tap to the picture, not to the element around it", () => {
    // The measured case: a 1080x871 panel showing a 1320x2868 device. The
    // picture is 401px wide, centred, and 679px of the element is background.
    const element = { left: 0, top: 0, width: 1080, height: 871 };
    // Height-limited: the picture is 401px wide and fills the 871px height,
    // leaving 679px of the element as background.
    const content = contentRect(element, screen);
    expect(Math.round(content.width)).toBe(401);
    expect(Math.round(content.height)).toBe(871);
    expect(Math.round(content.left)).toBe(340);

    // Dead centre stays dead centre either way.
    expect(toNormalized(content, element.width / 2, element.height / 2).x).toBeCloseTo(0.5, 5);

    // But the element's own edges are outside the picture entirely, and used to
    // read as 0 and 1 — a tap on background driving the device's far corner.
    expect(toNormalized(content, 1, 1).x).toBe(0);
    expect(toNormalized(content, 1079, 870).x).toBe(1);
  });

  it("letterboxes on whichever axis is tighter", () => {
    // Panel taller than the device: bars top and bottom instead.
    const wide = contentRect({ left: 0, top: 0, width: 400, height: 2000 }, screen);
    expect(Math.round(wide.width)).toBe(400);
    expect(Math.round(wide.top)).toBe(565);

    // An exact match adds nothing.
    const exact = contentRect({ left: 0, top: 0, width: 660, height: 1434 }, screen);
    expect(exact).toEqual({ left: 0, top: 0, width: 660, height: 1434 });
  });

  it("returns the element untouched when the screen size is not known yet", () => {
    // The first frames arrive before the dimension push; guessing an aspect
    // there would be worse than mapping against the element.
    const element = { left: 5, top: 7, width: 100, height: 200 };
    expect(contentRect(element, null)).toBe(element);
    expect(contentRect(element, { width: 0, height: 0 })).toBe(element);
    expect(contentRect({ left: 0, top: 0, width: 0, height: 0 }, screen)).toEqual({
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    });
  });
});

describe("the trackpad pinch", () => {
  it("spreads the fingers on spread, narrows them on squeeze", () => {
    // macOS reports a spreading pinch as negative deltaY.
    expect(pinchSpread(PINCH_INITIAL_SPREAD, -50)).toBeGreaterThan(PINCH_INITIAL_SPREAD);
    expect(pinchSpread(PINCH_INITIAL_SPREAD, 50)).toBeLessThan(PINCH_INITIAL_SPREAD);
  });

  it("clamps the spread to something two fingers could do", () => {
    expect(pinchSpread(PINCH_MAX_SPREAD, -10_000)).toBe(PINCH_MAX_SPREAD);
    expect(pinchSpread(PINCH_MIN_SPREAD, 10_000)).toBe(PINCH_MIN_SPREAD);
  });

  it("places the fingers on a diagonal around the cursor", () => {
    expect(pinchFingers({ x: 0.5, y: 0.5 }, 0.2)).toEqual({
      x1: 0.4,
      y1: 0.4,
      x2: 0.6,
      y2: 0.6,
    });
  });

  it("keeps both fingers on the glass near a corner", () => {
    const fingers = pinchFingers({ x: 0.02, y: 0.98 }, 0.4);
    expect(fingers.x1).toBeGreaterThanOrEqual(0);
    expect(fingers.y2).toBeLessThanOrEqual(1);
  });
});
