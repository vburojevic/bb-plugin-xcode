/**
 * Turning pointer and keyboard events into steps.
 *
 * Pure, so the mapping is testable without a DOM and without a device.
 *
 * There is deliberately no pointer-gesture classifier here anymore. The panel
 * streams raw touches (`liveTouch`) and iOS does the recognising — tap,
 * long-press, drag — exactly as if a finger were on the glass. What remains is
 * the coordinate maths and the keyboard map, which the device cannot do for us.
 */
import type { Step } from "../../src/sim/steps.js";

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * A client point inside a rectangle, as normalized device coordinates.
 *
 * The rectangle is the rendered frame, which is letterboxed inside its
 * container by `object-fit: contain` — so callers pass the *image's* rect
 * rather than the container's, or every tap lands in the wrong place on a
 * wide panel.
 */
export function toNormalized(rect: Rect, clientX: number, clientY: number): { x: number; y: number } {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

/**
 * The rectangle the picture actually occupies inside its element.
 *
 * Both the `<img>` and the `<canvas>` are `object-fit: contain` inside a box
 * that is whatever shape the panel is. When the panel is wider than the device
 * — a nav panel on a wide window, every time — the frame is letterboxed, and
 * `getBoundingClientRect` describes the element, not the picture. Normalising
 * against the element then maps a tap to the wrong point on the device: on a
 * 1080x871 box showing a 1320x2868 screen, a tap at 45% of the element lands at
 * 36% of the device, and every horizontal coordinate is wrong by more the wider
 * the panel gets.
 *
 * Returns the element rect unchanged when the screen size is unknown, which is
 * the honest fallback: the first frames arrive before the dimension push does.
 */
export function contentRect(rect: Rect, screen: { width: number; height: number } | null): Rect {
  if (screen === null || screen.width <= 0 || screen.height <= 0) return rect;
  if (rect.width <= 0 || rect.height <= 0) return rect;

  const scale = Math.min(rect.width / screen.width, rect.height / screen.height);
  const width = screen.width * scale;
  const height = screen.height * scale;
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** How far one arrow press moves the crosshair; Shift makes it a coarse jump. */
export const CROSSHAIR_STEP = 0.02;
export const CROSSHAIR_STEP_COARSE = 0.1;

export type KeyOutcome =
  | { kind: "step"; step: Step }
  | { kind: "move"; dx: number; dy: number }
  | { kind: "tap-crosshair" }
  | { kind: "release" }
  | { kind: "ignore" };

/**
 * What a key press means while the frame holds focus.
 *
 * Arrow keys move a crosshair rather than being forwarded, because keyboard
 * users need a way to reach a point on the device at all — and `Return` then
 * taps it. Everything printable is typed. `Escape` hands focus back to the
 * control bar rather than trapping it.
 */
export function keyStep(event: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}, hasCrosshair: boolean): KeyOutcome {
  // Never swallow a host shortcut. Command-K belongs to bb, not to the device.
  if (event.metaKey || event.ctrlKey || event.altKey) return { kind: "ignore" };

  const jump = event.shiftKey ? CROSSHAIR_STEP_COARSE : CROSSHAIR_STEP;
  switch (event.key) {
    case "ArrowLeft":
      return { kind: "move", dx: -jump, dy: 0 };
    case "ArrowRight":
      return { kind: "move", dx: jump, dy: 0 };
    case "ArrowUp":
      return { kind: "move", dx: 0, dy: -jump };
    case "ArrowDown":
      return { kind: "move", dx: 0, dy: jump };
    case "Escape":
      return { kind: "release" };
    case "Enter":
      return hasCrosshair ? { kind: "tap-crosshair" } : { kind: "step", step: { kind: "key", name: "enter" } };
    case "Backspace":
      return { kind: "step", step: { kind: "key", name: "backspace" } };
    case "Tab":
      // Tab moves focus out of the frame. Trapping it would strand a keyboard
      // user inside a video.
      return { kind: "ignore" };
    default:
      break;
  }

  // A single printable character is text. Everything else — F-keys, Home, dead
  // keys — is not something the device has an obvious meaning for.
  if ([...event.key].length === 1) {
    return { kind: "step", step: { kind: "type", text: event.key } };
  }
  return { kind: "ignore" };
}

/**
 * A wheel event as a scroll step.
 *
 * The deltas are pixels of *content*, so they are divided by the rendered size
 * to get the normalized fraction the device session expects, and the sign is
 * preserved: scrolling content down is a swipe up, and the injector already
 * inverts it.
 *
 * `at` anchors the scroll to the pointer's position, so the list under the
 * cursor scrolls — rather than whatever happens to sit at the centre.
 */
export function wheelStep(
  rect: Rect,
  deltaX: number,
  deltaY: number,
  at?: { x: number; y: number },
): Step | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dx = clampSigned(deltaX / rect.width);
  const dy = clampSigned(deltaY / rect.height);
  if (dx === 0 && dy === 0) return null;
  return at === undefined ? { kind: "scroll", dx, dy } : { kind: "scroll", dx, dy, at: { x: at.x, y: at.y } };
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}
