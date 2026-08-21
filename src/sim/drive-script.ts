/**
 * The drive script: `bb xcode sim drive "tap 0.5,0.9; type hello; swipe up"`.
 *
 * A tiny language, on purpose. It exists so a person at a terminal can drive a
 * simulator without writing JSON, and so the CLI and the agent tool run the
 * *same* steps — the parser's only job is to produce the `Step` union that
 * everything else already speaks.
 *
 * Every failure names the position and what was expected, because a script that
 * fails on step four should not read as a script that failed.
 */
import { BUTTONS, NAMED_KEYS, normalizeOrientation, isButtonName } from "./hid.js";
import { MAX_STEPS, type Point, type Step } from "./steps.js";

export class DriveScriptError extends Error {
  constructor(message: string, readonly index: number) {
    super(message);
    this.name = "DriveScriptError";
  }
}

/** Named swipe directions, as fractions of the screen. */
const SWIPES: Record<string, { from: { x: number; y: number }; to: { x: number; y: number } }> = {
  up: { from: { x: 0.5, y: 0.75 }, to: { x: 0.5, y: 0.25 } },
  down: { from: { x: 0.5, y: 0.25 }, to: { x: 0.5, y: 0.75 } },
  left: { from: { x: 0.75, y: 0.5 }, to: { x: 0.25, y: 0.5 } },
  right: { from: { x: 0.25, y: 0.5 }, to: { x: 0.75, y: 0.5 } },
};

/**
 * `0.5,0.9` or `"Sign in"`.
 *
 * A quoted string is an element label — which is what makes the script readable
 * in the case that matters: `tap "Sign in"` says what it does and survives a
 * layout change, where `tap 0.5,0.87` says nothing and breaks on the next
 * padding tweak.
 */
export function parsePoint(token: string, index: number): Point {
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(token);
  if (quoted !== null) {
    const label = (quoted[1] ?? quoted[2] ?? "").trim();
    if (label === "") throw new DriveScriptError("an element label cannot be empty", index);
    return { element: { label } };
  }
  const parts = token.split(",");
  if (parts.length !== 2) {
    throw new DriveScriptError(
      `expected "x,y" between 0 and 1, or a quoted label — got "${token}"`,
      index,
    );
  }
  const x = Number.parseFloat(parts[0]!);
  const y = Number.parseFloat(parts[1]!);
  // Never `!Number.isNaN`: `parseFloat("1e999")` is Infinity and would pass.
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    throw new DriveScriptError(
      `coordinates are fractions between 0 and 1 — got "${token}". Pixels would land in the corner.`,
      index,
    );
  }
  return { x, y };
}

/**
 * Split on `;`, respecting quotes.
 *
 * `type "hello; world"` is one step, not two — and a person who quotes a
 * semicolon has said exactly what they meant.
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const character of script) {
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === ";" || character === "\n") {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  out.push(current.trim());
  return out.filter((statement) => statement !== "");
}

/** Split a statement into a verb and its arguments, keeping quoted runs whole. */
export function tokenize(statement: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const character of statement) {
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function unquote(token: string): string {
  const quoted = /^"(.*)"$|^'(.*)'$/.exec(token);
  return quoted === null ? token : (quoted[1] ?? quoted[2] ?? "");
}

export function parseDriveScript(script: string): Step[] {
  const statements = splitStatements(script);
  if (statements.length === 0) {
    throw new DriveScriptError("the script is empty", 0);
  }
  if (statements.length > MAX_STEPS) {
    throw new DriveScriptError(
      `${statements.length} steps is more than the ${MAX_STEPS} a single drive may carry. Split it up.`,
      MAX_STEPS,
    );
  }

  return statements.map((statement, index) => parseStatement(statement, index));
}

function parseStatement(statement: string, index: number): Step {
  const tokens = tokenize(statement);
  const verb = (tokens[0] ?? "").toLowerCase();
  const args = tokens.slice(1);
  const need = (position: number, what: string): string => {
    const token = args[position];
    if (token === undefined) throw new DriveScriptError(`${verb} needs ${what}`, index);
    return token;
  };

  switch (verb) {
    case "tap":
      return { kind: "tap", at: parsePoint(need(0, "a point"), index) };
    case "doubletap":
    case "double-tap":
      return { kind: "doubleTap", at: parsePoint(need(0, "a point"), index) };
    case "press":
    case "longpress":
    case "long-press": {
      const at = parsePoint(need(0, "a point"), index);
      const holdMs = args[1] === undefined ? undefined : parseDuration(args[1], index);
      return holdMs === undefined ? { kind: "longPress", at } : { kind: "longPress", at, holdMs };
    }
    case "swipe": {
      const first = need(0, "a direction or a point");
      const named = SWIPES[first.toLowerCase()];
      if (named !== undefined) return { kind: "swipe", from: named.from, to: named.to };
      const to = args[1];
      if (to === undefined) {
        throw new DriveScriptError(
          `swipe needs a direction (${Object.keys(SWIPES).join(", ")}) or two points`,
          index,
        );
      }
      return { kind: "swipe", from: parsePoint(first, index), to: parsePoint(to, index) };
    }
    case "scroll": {
      const direction = need(0, `a direction (${Object.keys(SWIPES).join(", ")})`).toLowerCase();
      // Content moves the way you name: "scroll down" reveals what is below.
      const amounts: Record<string, { dx: number; dy: number }> = {
        up: { dx: 0, dy: -0.5 },
        down: { dx: 0, dy: 0.5 },
        left: { dx: -0.5, dy: 0 },
        right: { dx: 0.5, dy: 0 },
      };
      const amount = amounts[direction];
      if (amount === undefined) {
        throw new DriveScriptError(`scroll takes ${Object.keys(amounts).join(", ")}`, index);
      }
      return { kind: "scroll", dx: amount.dx, dy: amount.dy };
    }
    case "pinch": {
      const direction = need(0, "in or out").toLowerCase();
      if (direction !== "in" && direction !== "out") {
        throw new DriveScriptError("pinch takes in or out", index);
      }
      const at = args[1] === undefined ? { x: 0.5, y: 0.5 } : parsePoint(args[1], index);
      return direction === "in"
        ? { kind: "pinch", at, from: 0.2, to: 0.7 }
        : { kind: "pinch", at, from: 0.7, to: 0.2 };
    }
    case "type": {
      // Everything after the verb, so `type hello there` needs no quotes.
      const text = args.length === 1 ? unquote(args[0]!) : args.map(unquote).join(" ");
      if (text === "") throw new DriveScriptError("type needs some text", index);
      return { kind: "type", text };
    }
    case "key": {
      const name = need(0, `a key (${Object.keys(NAMED_KEYS).sort().join(", ")})`).toLowerCase();
      if (NAMED_KEYS[name] === undefined) {
        throw new DriveScriptError(
          `"${name}" is not a key. Use one of: ${Object.keys(NAMED_KEYS).sort().join(", ")}.`,
          index,
        );
      }
      return { kind: "key", name };
    }
    case "button": {
      const name = need(0, `a button (${BUTTONS.join(", ")})`).toLowerCase();
      if (!isButtonName(name)) {
        throw new DriveScriptError(`"${name}" is not a button. Use one of: ${BUTTONS.join(", ")}.`, index);
      }
      return { kind: "button", name };
    }
    // The three buttons people reach for often enough to name directly.
    case "home":
      return { kind: "button", name: "home" };
    case "lock":
      return { kind: "button", name: "lock" };
    case "siri":
      return { kind: "button", name: "siri" };
    case "rotate": {
      const orientation = normalizeOrientation(need(0, "an orientation"));
      if (orientation === null) {
        throw new DriveScriptError(
          `"${args[0]}" is not an orientation. Use portrait, portrait-upside-down, landscape-left or landscape-right.`,
          index,
        );
      }
      return { kind: "rotate", orientation };
    }
    case "keyboard":
      return { kind: "keyboard" };
    case "wait":
      return { kind: "wait", ms: parseDuration(need(0, "a duration, e.g. 500ms or 1s"), index) };
    default:
      throw new DriveScriptError(
        `"${verb}" is not something this can do. Try: tap, double-tap, press, swipe, scroll, pinch, type, key, button, home, rotate, keyboard, wait.`,
        index,
      );
  }
}

/** `500`, `500ms` and `1s` all mean milliseconds by the time they leave here. */
export function parseDuration(token: string, index: number): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(token.trim());
  if (match === null) {
    throw new DriveScriptError(`"${token}" is not a duration. Try 500ms or 1s.`, index);
  }
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value)) {
    throw new DriveScriptError(`"${token}" is not a duration. Try 500ms or 1s.`, index);
  }
  const ms = Math.round(match[2] === "s" ? value * 1000 : value);
  if (ms < 10 || ms > 10_000) {
    throw new DriveScriptError(`a wait is between 10ms and 10s — got ${ms}ms`, index);
  }
  return ms;
}
