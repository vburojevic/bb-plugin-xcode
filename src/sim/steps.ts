/**
 * One input vocabulary, shared by the panel's controls and by the agent tool.
 *
 * The panel sends a single step over RPC; `simulator_drive` sends a batch of up
 * to 24. Defining them once means a gesture cannot behave differently depending
 * on who asked for it — and it means the drive-script parser, the tool's schema
 * and the control bar all agree on what a swipe is.
 *
 * Coordinates are normalized `0–1`, which is what the device session expects:
 * it multiplies by the frame size before handing them to the injector. Nothing
 * here ever sees a pixel.
 */
import { z } from "zod";
import { BUTTONS, NAMED_KEYS, normalizeOrientation, sleep, textToKeystrokes, type HidSocket } from "./hid.js";

const unit = z.number().min(0).max(1);

/**
 * A point, either as coordinates or as something on screen.
 *
 * `element` lets a model say "tap Sign in" rather than guessing pixels; it is
 * resolved against the device's accessibility tree at execution time. The two
 * forms are exclusive, and a step that carries neither is a schema error rather
 * than a tap at the origin.
 */
export const pointSchema = z.union([
  z.object({ x: unit, y: unit }).strict(),
  z.object({ element: z.object({ label: z.string().min(1) }).strict() }).strict(),
]);

export type Point = z.infer<typeof pointSchema>;

export const stepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tap"), at: pointSchema }).strict(),
  z.object({ kind: z.literal("doubleTap"), at: pointSchema }).strict(),
  z.object({ kind: z.literal("longPress"), at: pointSchema, holdMs: z.number().int().min(100).max(5000).optional() }).strict(),
  z
    .object({
      kind: z.literal("swipe"),
      from: pointSchema,
      to: pointSchema,
      durationMs: z.number().int().min(50).max(3000).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("scroll"),
      dx: z.number().min(-1).max(1),
      dy: z.number().min(-1).max(1),
      at: pointSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pinch"),
      at: pointSchema,
      from: z.number().min(0).max(1),
      to: z.number().min(0).max(1),
      durationMs: z.number().int().min(50).max(3000).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("type"), text: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal("key"), name: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("button"), name: z.enum(BUTTONS) }).strict(),
  z.object({ kind: z.literal("rotate"), orientation: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("keyboard") }).strict(),
  z.object({ kind: z.literal("wait"), ms: z.number().int().min(10).max(10_000) }).strict(),
]);

export type Step = z.infer<typeof stepSchema>;

/** `simulator_drive` takes a batch; more than this is a script, not a demo. */
export const MAX_STEPS = 24;

/**
 * Resolves an element label to a point.
 *
 * Injected rather than imported so a step can be executed against a device with
 * no accessibility service — and so the pure executor stays testable.
 */
export type ResolvePoint = (point: Point) => Promise<{ x: number; y: number }>;

/** The default: coordinates only, and an honest refusal for anything else. */
export const coordinatesOnly: ResolvePoint = async (point) => {
  if ("x" in point) return { x: point.x, y: point.y };
  throw new Error(
    `Cannot find "${point.element.label}": this simulator's accessibility service is not answering.`,
  );
};

export interface StepResult {
  /** One line per step, for the tool's text log and the CLI's output. */
  log: string;
  /** Characters that could not be typed, rather than approximated. */
  dropped: string[];
}

/**
 * What the executor may lean on beyond the socket.
 *
 * `pasteText` routes text through the device pasteboard and the ⌘V chord —
 * the path for characters the US-layout HID keyboard cannot type. Injected
 * rather than imported so the pure executor stays testable, and so a caller
 * with no device driver simply gets the honest keystroke path.
 */
export interface StepCaps {
  pasteText?: (text: string) => Promise<void>;
}

/**
 * Run one step.
 *
 * Every touch gesture goes through `HidSocket.gesture`, whose `finally` always
 * ends the gesture — HID runs in-process in the native addon and malformed
 * bodies are swallowed by a guard rather than thrown, so a `begin` with no
 * `end` leaves a finger down and wedges input until the device reboots, with no
 * error anywhere.
 */
export async function executeStep(
  socket: HidSocket,
  step: Step,
  resolve: ResolvePoint = coordinatesOnly,
  caps: StepCaps = {},
): Promise<StepResult> {
  switch (step.kind) {
    case "tap": {
      const at = await resolve(step.at);
      await socket.tap(at.x, at.y);
      return { log: `tapped ${describePoint(step.at, at)}`, dropped: [] };
    }
    case "doubleTap": {
      const at = await resolve(step.at);
      await socket.doubleTap(at.x, at.y);
      return { log: `double-tapped ${describePoint(step.at, at)}`, dropped: [] };
    }
    case "longPress": {
      const at = await resolve(step.at);
      const holdMs = step.holdMs ?? 700;
      await socket.longPress(at.x, at.y, holdMs);
      return { log: `held ${describePoint(step.at, at)} for ${holdMs}ms`, dropped: [] };
    }
    case "swipe": {
      const [from, to] = await Promise.all([resolve(step.from), resolve(step.to)]);
      await socket.swipe(from, to, step.durationMs ?? 250);
      return {
        log: `swiped ${describePoint(step.from, from)} → ${describePoint(step.to, to)}`,
        dropped: [],
      };
    }
    case "scroll": {
      const anchor = step.at === undefined ? undefined : await resolve(step.at);
      socket.scroll(step.dx, step.dy, anchor);
      return { log: `scrolled ${describeScroll(step.dx, step.dy)}`, dropped: [] };
    }
    case "pinch": {
      const at = await resolve(step.at);
      await socket.pinch(at, step.from, step.to, step.durationMs ?? 300);
      return {
        log: `${step.to > step.from ? "zoomed in" : "zoomed out"} at ${describePoint(step.at, at)}`,
        dropped: [],
      };
    }
    case "type": {
      // Text the US-layout HID keyboard cannot fully type goes through the
      // pasteboard instead — as a whole, never half-typed-half-pasted, so an
      // é in the middle does not split the string into two insertions.
      if (caps.pasteText !== undefined && textToKeystrokes(step.text).dropped.length > 0) {
        await caps.pasteText(step.text);
        return { log: `pasted ${JSON.stringify(step.text)} via the clipboard`, dropped: [] };
      }
      const { dropped } = await socket.type(step.text);
      const note =
        dropped.length === 0
          ? ""
          : ` (${dropped.length} character${dropped.length === 1 ? "" : "s"} could not be typed: ${dropped.join("")})`;
      return { log: `typed ${JSON.stringify(step.text)}${note}`, dropped };
    }
    case "key": {
      const usage = NAMED_KEYS[step.name.trim().toLowerCase()];
      if (usage === undefined) {
        throw new Error(
          `"${step.name}" is not a key. Use one of: ${Object.keys(NAMED_KEYS).sort().join(", ")}.`,
        );
      }
      await socket.key(usage);
      return { log: `pressed ${step.name}`, dropped: [] };
    }
    case "button": {
      socket.button(step.name);
      // Xcode 26+ silently drops the Indigo HID home button, so serve-sim
      // relaunches SpringBoard instead — which is neither instant nor animated
      // the way a real home press is. Saying so beats letting a caller conclude
      // the tap did nothing.
      const note = step.name === "home" ? " (relaunches SpringBoard)" : "";
      return { log: `pressed ${step.name.replace(/_/g, " ")}${note}`, dropped: [] };
    }
    case "rotate": {
      const orientation = normalizeOrientation(step.orientation);
      if (orientation === null) {
        throw new Error(
          `"${step.orientation}" is not an orientation. Use portrait, portrait-upside-down, landscape-left or landscape-right.`,
        );
      }
      socket.rotate(orientation);
      return { log: `rotated to ${orientation.replace(/_/g, " ")}`, dropped: [] };
    }
    case "keyboard": {
      socket.softwareKeyboard();
      return { log: "toggled the software keyboard", dropped: [] };
    }
    case "wait": {
      await sleep(step.ms);
      return { log: `waited ${step.ms}ms`, dropped: [] };
    }
  }
}

function describePoint(point: Point, resolved: { x: number; y: number }): string {
  if ("element" in point) return `"${point.element.label}"`;
  return `${resolved.x.toFixed(2)},${resolved.y.toFixed(2)}`;
}

function describeScroll(dx: number, dy: number): string {
  // The finger moves opposite to the content: scrolling content down is a
  // swipe up. Naming the direction the *content* moves is what a person means.
  const parts: string[] = [];
  if (dy !== 0) parts.push(dy > 0 ? "down" : "up");
  if (dx !== 0) parts.push(dx > 0 ? "right" : "left");
  return parts.length === 0 ? "nowhere" : parts.join(" and ");
}
