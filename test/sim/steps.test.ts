import { describe, expect, it, vi } from "vitest";
import { coordinatesOnly, executeStep, MAX_STEPS, stepSchema } from "../../src/sim/steps.js";
import type { HidSocket } from "../../src/sim/hid.js";

/** A socket that records what it was asked to do, and nothing else. */
function fakeSocket() {
  const calls: string[] = [];
  const socket = {
    calls,
    tap: vi.fn(async (x: number, y: number) => void calls.push(`tap ${x},${y}`)),
    doubleTap: vi.fn(async (x: number, y: number) => void calls.push(`doubleTap ${x},${y}`)),
    longPress: vi.fn(async (x: number, y: number, ms: number) => void calls.push(`longPress ${x},${y} ${ms}`)),
    swipe: vi.fn(async (from: { x: number; y: number }, to: { x: number; y: number }, ms: number) =>
      void calls.push(`swipe ${from.x},${from.y}->${to.x},${to.y} ${ms}`),
    ),
    scroll: vi.fn((dx: number, dy: number) => void calls.push(`scroll ${dx},${dy}`)),
    pinch: vi.fn(async (at: { x: number }, from: number, to: number) =>
      void calls.push(`pinch ${at.x} ${from}->${to}`),
    ),
    type: vi.fn(async (text: string) => {
      calls.push(`type ${text}`);
      return { dropped: [] as string[] };
    }),
    key: vi.fn(async (usage: number) => void calls.push(`key ${usage}`)),
    button: vi.fn((name: string) => void calls.push(`button ${name}`)),
    rotate: vi.fn((orientation: string) => void calls.push(`rotate ${orientation}`)),
    softwareKeyboard: vi.fn(() => void calls.push("keyboard")),
  };
  return socket as unknown as HidSocket & typeof socket;
}

describe("the step schema", () => {
  it("accepts a point as coordinates or as an element, and nothing else", () => {
    expect(stepSchema.safeParse({ kind: "tap", at: { x: 0.5, y: 0.5 } }).success).toBe(true);
    expect(stepSchema.safeParse({ kind: "tap", at: { element: { label: "Sign in" } } }).success).toBe(true);
    // A step with neither is a schema error rather than a tap at the origin.
    expect(stepSchema.safeParse({ kind: "tap", at: {} }).success).toBe(false);
    expect(stepSchema.safeParse({ kind: "tap", at: { x: 0.5 } }).success).toBe(false);
  });

  it("refuses coordinates outside the normalized range", () => {
    // Pixels would silently land in the top-left corner of the device.
    expect(stepSchema.safeParse({ kind: "tap", at: { x: 400, y: 900 } }).success).toBe(false);
    expect(stepSchema.safeParse({ kind: "tap", at: { x: -0.1, y: 0.5 } }).success).toBe(false);
  });

  it("refuses an unknown key on a step", () => {
    expect(stepSchema.safeParse({ kind: "tap", at: { x: 0.5, y: 0.5 }, force: 3 }).success).toBe(false);
  });

  it("bounds a drive batch at something a person would demo", () => {
    expect(MAX_STEPS).toBe(24);
  });
});

describe("executing steps", () => {
  it("performs each gesture and describes what it did", async () => {
    const socket = fakeSocket();
    const at = { x: 0.5, y: 0.25 };

    expect((await executeStep(socket, { kind: "tap", at })).log).toBe("tapped 0.50,0.25");
    expect((await executeStep(socket, { kind: "doubleTap", at })).log).toBe("double-tapped 0.50,0.25");
    expect((await executeStep(socket, { kind: "longPress", at, holdMs: 900 })).log).toBe(
      "held 0.50,0.25 for 900ms",
    );
    expect(
      (await executeStep(socket, { kind: "swipe", from: at, to: { x: 0.5, y: 0.75 } })).log,
    ).toBe("swiped 0.50,0.25 → 0.50,0.75");
    expect((await executeStep(socket, { kind: "scroll", dx: 0, dy: 0.3 })).log).toBe("scrolled down");
    expect((await executeStep(socket, { kind: "pinch", at, from: 0.2, to: 0.6 })).log).toBe(
      "zoomed in at 0.50,0.25",
    );
    expect((await executeStep(socket, { kind: "keyboard" })).log).toBe("toggled the software keyboard");
  });

  it("names the SpringBoard relaunch on the home button", async () => {
    // Xcode 26+ silently drops the Indigo HID home button and serve-sim
    // relaunches SpringBoard instead. Saying so beats letting a caller conclude
    // the press did nothing.
    const socket = fakeSocket();
    expect((await executeStep(socket, { kind: "button", name: "home" })).log).toBe(
      "pressed home (relaunches SpringBoard)",
    );
    expect((await executeStep(socket, { kind: "button", name: "app_switcher" })).log).toBe(
      "pressed app switcher",
    );
  });

  it("accepts both orientation spellings and refuses a third", async () => {
    const socket = fakeSocket();
    expect((await executeStep(socket, { kind: "rotate", orientation: "landscape-left" })).log).toBe(
      "rotated to landscape left",
    );
    await expect(executeStep(socket, { kind: "rotate", orientation: "sideways" })).rejects.toThrow(
      /is not an orientation/,
    );
  });

  it("reports characters it could not type rather than approximating them", async () => {
    const socket = fakeSocket();
    socket.type.mockResolvedValueOnce({ dropped: ["é", "🎉"] });
    const result = await executeStep(socket, { kind: "type", text: "café 🎉" });
    expect(result.dropped).toEqual(["é", "🎉"]);
    expect(result.log).toContain("2 characters could not be typed");
  });

  it("names the keys it knows when given one it does not", async () => {
    const socket = fakeSocket();
    await expect(executeStep(socket, { kind: "key", name: "any" })).rejects.toThrow(
      /is not a key\. Use one of: backspace, delete, down/,
    );
  });

  it("refuses an element it cannot resolve, rather than tapping the origin", async () => {
    const socket = fakeSocket();
    await expect(
      executeStep(socket, { kind: "tap", at: { element: { label: "Sign in" } } }, coordinatesOnly),
    ).rejects.toThrow(/Cannot find "Sign in"/);
  });

  it("uses a resolver when one is given", async () => {
    const socket = fakeSocket();
    const result = await executeStep(
      socket,
      { kind: "tap", at: { element: { label: "Sign in" } } },
      async () => ({ x: 0.5, y: 0.9 }),
    );
    // The log names the element, not the coordinates it happened to resolve to:
    // that is what the caller asked for.
    expect(result.log).toBe('tapped "Sign in"');
    expect(socket.calls).toEqual(["tap 0.5,0.9"]);
  });
});
