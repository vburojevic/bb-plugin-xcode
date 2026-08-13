import { describe, expect, it } from "vitest";
import {
  BUTTONS,
  decodeConfig,
  encodeButton,
  encodeButtonHid,
  encodeCaDebug,
  encodeKey,
  encodeMemoryWarning,
  encodeMultiTouch,
  encodeOrientation,
  encodeScroll,
  encodeSoftwareKeyboard,
  encodeTouch,
  KEY_LEFT_SHIFT,
  normalizeOrientation,
  TAG,
  textToKeystrokes,
} from "../../src/sim/hid.js";

/**
 * Byte-for-byte against serve-sim 0.1.45's `DeviceSession.handleHidMessage`:
 * one tag byte followed by a JSON body, or a bare tag byte for the two that
 * take none.
 */
function decode(frame: Buffer): { tag: number; body: unknown } {
  return {
    tag: frame[0]!,
    body: frame.length > 1 ? (JSON.parse(frame.subarray(1).toString("utf8")) as unknown) : undefined,
  };
}

describe("tag encoders", () => {
  it("encodes a touch", () => {
    expect(decode(encodeTouch("begin", 0.5, 0.25))).toEqual({
      tag: 0x03,
      body: { type: "begin", x: 0.5, y: 0.25 },
    });
  });

  it("carries the edge only when there is one", () => {
    expect(decode(encodeTouch("begin", 0.5, 0.95, 3)).body).toEqual({
      type: "begin",
      x: 0.5,
      y: 0.95,
      edge: 3,
    });
  });

  it("clamps coordinates into the normalized range", () => {
    expect(decode(encodeTouch("move", -1, 4)).body).toEqual({ type: "move", x: 0, y: 1 });
    // A NaN coordinate must not reach the device as a NaN: the native binding
    // throws on a value it cannot coerce, and serve-sim swallows that throw —
    // leaving a finger down with no error anywhere.
    expect(decode(encodeTouch("move", Number.NaN, 0.5)).body).toEqual({ type: "move", x: 0, y: 0.5 });
  });

  it("encodes the multi-touch body the CLI cannot send", () => {
    // serve-sim's `gesture` subcommand hardcodes tag 0x03, so every documented
    // pinch recipe parses as a single touch with undefined coordinates.
    expect(decode(encodeMultiTouch("begin", 0.3, 0.3, 0.7, 0.7))).toEqual({
      tag: 0x05,
      body: { type: "begin", x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7 },
    });
  });

  it("encodes a named button and an arbitrary HID one differently", () => {
    expect(decode(encodeButton("home"))).toEqual({ tag: 0x04, body: { button: "home" } });
    expect(decode(encodeButtonHid(12, 233, "down"))).toEqual({
      tag: 0x04,
      body: { page: 12, usage: 233, phase: "down" },
    });
  });

  it("encodes keys, orientation, scroll and the debug taps", () => {
    expect(decode(encodeKey("down", 0x04))).toEqual({ tag: 0x06, body: { type: "down", usage: 4 } });
    expect(decode(encodeOrientation("landscape_left"))).toEqual({
      tag: 0x07,
      body: { orientation: "landscape_left" },
    });
    expect(decode(encodeScroll(0, -0.25))).toEqual({ tag: 0x0b, body: { dx: 0, dy: -0.25 } });
    expect(decode(encodeScroll(0, -0.25, 0.5, 0.5)).body).toEqual({
      dx: 0,
      dy: -0.25,
      x: 0.5,
      y: 0.5,
    });
    expect(decode(encodeCaDebug("debug_color_blended", true))).toEqual({
      tag: 0x08,
      body: { option: "debug_color_blended", enabled: true },
    });
  });

  it("sends the two bodiless tags as a single byte", () => {
    expect(encodeMemoryWarning()).toEqual(Buffer.from([0x09]));
    expect(encodeSoftwareKeyboard()).toEqual(Buffer.from([0x0c]));
  });

  it("uses the tag numbers the device session switches on", () => {
    expect(TAG).toEqual({
      touch: 3,
      button: 4,
      multiTouch: 5,
      key: 6,
      orientation: 7,
      caDebug: 8,
      memoryWarning: 9,
      digitalCrown: 10,
      scroll: 11,
      softwareKeyboard: 12,
      config: 130,
    });
  });
});

describe("the 0x82 config push", () => {
  it("decodes dimensions and orientation", () => {
    const frame = Buffer.concat([
      Buffer.from([0x82]),
      Buffer.from(JSON.stringify({ width: 1206, height: 2622, orientation: "portrait" })),
    ]);
    expect(decodeConfig(frame)).toEqual({ width: 1206, height: 2622, orientation: "portrait" });
  });

  it("refuses anything that is not a config frame", () => {
    expect(decodeConfig(Buffer.from([0x03, 0x7b, 0x7d]))).toBeNull();
    expect(decodeConfig(Buffer.from([0x82]))).toBeNull();
    expect(decodeConfig(Buffer.concat([Buffer.from([0x82]), Buffer.from("not json")]))).toBeNull();
  });
});

describe("orientation spellings", () => {
  it("accepts hyphens and underscores, because both are written in practice", () => {
    expect(normalizeOrientation("landscape-left")).toBe("landscape_left");
    expect(normalizeOrientation("LANDSCAPE_LEFT")).toBe("landscape_left");
    expect(normalizeOrientation("portrait-upside-down")).toBe("portrait_upside_down");
  });

  it("refuses one that does not exist", () => {
    expect(normalizeOrientation("sideways")).toBeNull();
  });
});

describe("the button vocabulary", () => {
  it("is exactly what serve-sim's sendButton accepts", () => {
    // Anything else prints "Unknown button" from inside a child process, where
    // nobody would ever see it. There is deliberately no `shake`: serve-sim has
    // no shake gesture anywhere.
    expect([...BUTTONS]).toEqual(["home", "swipe_home", "app_switcher", "lock", "siri", "side_button"]);
    expect(BUTTONS).not.toContain("shake");
  });
});

describe("typing", () => {
  it("maps unshifted characters to their usage codes", () => {
    expect(textToKeystrokes("ab1 ").strokes).toEqual([
      { usage: 0x04, shift: false },
      { usage: 0x05, shift: false },
      { usage: 0x1e, shift: false },
      { usage: 0x2c, shift: false },
    ]);
  });

  it("holds shift for capitals and for shifted punctuation", () => {
    expect(textToKeystrokes("A!").strokes).toEqual([
      { usage: 0x04, shift: true },
      { usage: 0x1e, shift: true },
    ]);
  });

  it("drops what it cannot type rather than approximating it", () => {
    // Typing `cafe` when the model asked for `café` is a worse failure than
    // saying one character could not be typed.
    const result = textToKeystrokes("café 🎉");
    expect(result.dropped).toEqual(["é", "🎉"]);
    // c, a, f and the space survive; the two it cannot represent do not.
    expect(result.strokes).toHaveLength(4);
  });

  it("uses left shift, which is the modifier the injector expects", () => {
    expect(KEY_LEFT_SHIFT).toBe(0xe1);
  });
});
