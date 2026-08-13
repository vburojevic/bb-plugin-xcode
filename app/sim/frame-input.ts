/**
 * Turning pointer and keyboard events into steps.
 *
 * Pure, so the mapping is testable without a DOM and without a device: given a
 * rectangle and two points, this decides whether you tapped or swiped, and
 * given a key it decides whether you meant to type or to move.
 */
import type { Step } from "../../src/sim/steps.js";

/** Below this much movement, a drag is a tap with a shaky hand. */
export const TAP_SLOP = 0.015;

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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * A tap or a swipe, depending on how far the pointer travelled.
 *
 * The duration is the real one, so a slow drag reads as a slow drag: iOS's own
 * recognizers care, and a 250ms swipe where the user spent a second is a
 * different gesture.
 */
export function pointerStep(
  from: { x: number; y: number },
  to: { x: number; y: number },
  durationMs: number,
): Step {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < TAP_SLOP) {
    return durationMs >= 500
      ? { kind: "longPress", at: { x: from.x, y: from.y }, holdMs: Math.min(5000, Math.round(durationMs)) }
      : { kind: "tap", at: { x: from.x, y: from.y } };
  }
  return {
    kind: "swipe",
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    durationMs: Math.min(3000, Math.max(50, Math.round(durationMs))),
  };
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
 */
export function wheelStep(rect: Rect, deltaX: number, deltaY: number): Step | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const dx = clampSigned(deltaX / rect.width);
  const dy = clampSigned(deltaY / rect.height);
  if (dx === 0 && dy === 0) return null;
  return { kind: "scroll", dx, dy };
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}
