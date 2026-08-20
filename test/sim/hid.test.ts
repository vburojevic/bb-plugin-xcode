import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import {
  BUTTONS,
  decodeConfig,
  EDGE_BOTTOM,
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
  HidSocket,
  KEY_LEFT_SHIFT,
  normalizeOrientation,
  TAG,
  TAP_DWELL_MS,
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

// ---------------------------------------------------------------------------
// The socket: what actually leaves for the device, in what order
// ---------------------------------------------------------------------------

/** A WebSocket good enough to drive the socket's contract with one. */
class FakeWebSocket {
  readyState = 1; // OPEN
  sent: Buffer[] = [];
  private handlers = new Map<string, Array<(...args: never[]) => void>>();

  on(event: string, cb: (...args: never[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  send(data: Buffer): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  fire(event: string, ...args: never[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
}

function touchFrames(ws: FakeWebSocket): Array<{ type: string; x: number; y: number }> {
  return ws.sent
    .map((frame) => decode(frame))
    .filter((frame) => frame.tag === TAG.touch)
    .map((frame) => frame.body as { type: string; x: number; y: number });
}

async function openedSocket(): Promise<{ hid: HidSocket; ws: FakeWebSocket }> {
  const ws = new FakeWebSocket();
  const hid = new HidSocket({
    port: 1,
    udid: "UDID",
    secret: "s",
    onConfig: () => {},
    onClose: () => {},
    connect: () => ws as unknown as WebSocket,
  });
  const opening = hid.open();
  ws.fire("open");
  await opening;
  return { hid, ws };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Long enough for the live pump — including the tap-dwell floor — to drain. */
const settle = (): Promise<void> => sleepMs(TAP_DWELL_MS + 25);

describe("the socket", () => {
  it("ends a tap where the tap happened — never at screen centre", async () => {
    // The regression test for "I can't tap stuff": the end used to go out at
    // the default (0.5, 0.5), so iOS delivered every tap to the middle.
    const { hid, ws } = await openedSocket();
    await hid.tap(0.2, 0.8);
    const frames = touchFrames(ws);
    expect(frames[0]).toEqual({ type: "begin", x: 0.2, y: 0.8 });
    expect(frames.at(-1)).toEqual({ type: "end", x: 0.2, y: 0.8 });
  });

  it("ends a swipe where the swipe ends", async () => {
    const { hid, ws } = await openedSocket();
    await hid.swipe({ x: 0.5, y: 0.8 }, { x: 0.5, y: 0.2 }, 60);
    const frames = touchFrames(ws);
    expect(frames[0]).toEqual({ type: "begin", x: 0.5, y: 0.8 });
    expect(frames.at(-1)).toEqual({ type: "end", x: 0.5, y: 0.2 });
  });

  it("queues a second gesture behind the first instead of throwing", async () => {
    const { hid, ws } = await openedSocket();
    const first = hid.longPress(0.5, 0.5, 150);
    const second = hid.tap(0.1, 0.1);
    // Neither rejects: gestures are physical things, they happen in order.
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();

    const frames = touchFrames(ws);
    const pressEnd = frames.findIndex((f) => f.type === "end" && f.x === 0.5 && f.y === 0.5);
    const tapBegin = frames.findIndex((f) => f.type === "begin" && f.x === 0.1 && f.y === 0.1);
    expect(pressEnd).toBeGreaterThan(-1);
    expect(tapBegin).toBeGreaterThan(pressEnd);
  });

  it("streams live touches in order, and drops orphans", async () => {
    const { hid, ws } = await openedSocket();

    // A move with no finger down is meaningless and must not reach the device.
    hid.touchMove(0.9, 0.9);
    hid.touchEnd(0.9, 0.9);
    await settle();
    expect(touchFrames(ws)).toHaveLength(0);

    hid.touchBegin(0.3, 0.4);
    hid.touchMove(0.35, 0.45);
    hid.touchEnd(0.4, 0.5);
    await settle();
    expect(touchFrames(ws)).toEqual([
      { type: "begin", x: 0.3, y: 0.4 },
      { type: "move", x: 0.35, y: 0.45 },
      { type: "end", x: 0.4, y: 0.5 },
    ]);
  });

  it("holds a too-fast live tap to the dwell floor", async () => {
    // Trackpad tap-to-click puts down and up on the same millisecond — below
    // what any iOS tap recognizer accepts as contact. The tap arrived
    // perfectly and did nothing, which read as "I can't tap anything".
    const { hid, ws } = await openedSocket();
    hid.touchBegin(0.2, 0.2);
    hid.touchEnd(0.2, 0.2);
    await sleepMs(15);
    expect(touchFrames(ws).map((f) => f.type)).toEqual(["begin"]);
    await sleepMs(60);
    expect(touchFrames(ws).map((f) => f.type)).toEqual(["begin", "end"]);
  });

  it("replays a batch at its timestamps' spacing", async () => {
    const { hid, ws } = await openedSocket();
    hid.streamLive([
      { kind: "touch", phase: "begin", x: 0.5, y: 0.5, t: 1000 },
      { kind: "touch", phase: "move", x: 0.5, y: 0.4, t: 1060 },
    ]);
    await sleepMs(20);
    // The move's moment is 60ms after the begin's; it must not have gone yet.
    expect(touchFrames(ws).map((f) => f.type)).toEqual(["begin"]);
    await sleepMs(70);
    expect(touchFrames(ws).map((f) => f.type)).toEqual(["begin", "move"]);
  });

  it("lifts a stale finger when a fresh begin arrives over it", async () => {
    // A lost end — a dropped batch, a killed panel — used to wedge input for
    // the five seconds the watchdog took to notice, because every new begin
    // was silently swallowed.
    const { hid, ws } = await openedSocket();
    hid.touchBegin(0.3, 0.3);
    hid.touchMove(0.4, 0.4);
    await settle();
    hid.touchBegin(0.8, 0.8);
    await settle();
    expect(touchFrames(ws)).toEqual([
      { type: "begin", x: 0.3, y: 0.3 },
      { type: "move", x: 0.4, y: 0.4 },
      // The stale finger is lifted where it actually was...
      { type: "end", x: 0.4, y: 0.4 },
      // ...and the fresh gesture proceeds.
      { type: "begin", x: 0.8, y: 0.8 },
    ]);
  });

  it("streams two live fingers as multi-touch frames", async () => {
    const { hid, ws } = await openedSocket();
    hid.streamLive([
      { kind: "multi", phase: "begin", x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6, t: 0 },
      { kind: "multi", phase: "move", x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7, t: 8 },
      { kind: "multi", phase: "end", x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7, t: 16 },
    ]);
    await settle();
    const frames = ws.sent.map((frame) => decode(frame)).filter((frame) => frame.tag === TAG.multiTouch);
    expect(frames.map((frame) => (frame.body as { type: string }).type)).toEqual([
      "begin",
      "move",
      "end",
    ]);
  });

  it("carries scroll events on the live stream", async () => {
    const { hid, ws } = await openedSocket();
    hid.streamLive([{ kind: "scroll", dx: 0, dy: -0.25, x: 0.5, y: 0.5, t: 0 }]);
    await settle();
    const scrolls = ws.sent.map((frame) => decode(frame)).filter((frame) => frame.tag === TAG.scroll);
    expect(scrolls).toHaveLength(1);
    expect(scrolls[0]!.body).toEqual({ dx: 0, dy: -0.25, x: 0.5, y: 0.5 });
  });

  it("refuses live events while a scripted gesture owns the finger", async () => {
    const { hid, ws } = await openedSocket();
    const press = hid.longPress(0.5, 0.5, 100);
    await tick(); // let the press's begin leave
    expect(hid.streamLive([{ kind: "touch", phase: "begin", x: 0.9, y: 0.9, t: 0 }])).toBe(false);
    await press;
    // One begin only: the live finger was refused while the gesture owned it.
    expect(touchFrames(ws).filter((f) => f.type === "begin")).toHaveLength(1);
  });

  it("lifts a live finger at its own point when the socket closes", async () => {
    const { hid, ws } = await openedSocket();
    hid.touchBegin(0.3, 0.4);
    hid.touchMove(0.6, 0.7);
    await settle();
    hid.close();
    expect(touchFrames(ws).at(-1)).toEqual({ type: "end", x: 0.6, y: 0.7 });
  });

  it("lifts both fingers when a pinch is cut short", async () => {
    // A pinch aborted with a single-finger end leaves the second finger on
    // the glass, and a device with a phantom finger ignores every real one.
    const { hid, ws } = await openedSocket();
    const pinch = hid.pinch({ x: 0.5, y: 0.5 }, 0.2, 0.6, 120);
    await sleepMs(30);
    hid.close();
    await pinch.catch(() => undefined);
    const multi = ws.sent.map((frame) => decode(frame)).filter((frame) => frame.tag === TAG.multiTouch);
    expect((multi.at(-1)!.body as { type: string }).type).toBe("end");
  });

  it("marks a drag from the bezel zone as the home gesture, and a mid-screen one as not", async () => {
    const { hid, ws } = await openedSocket();

    // From the bottom ~6%: an edge touch, on begin and every move.
    hid.touchBegin(0.5, 0.97);
    hid.touchMove(0.5, 0.6);
    hid.touchEnd(0.5, 0.35);
    await settle();
    const edged = ws.sent.map((frame) => decode(frame)).filter((frame) => frame.tag === TAG.touch);
    expect((edged[0]!.body as { edge?: number }).edge).toBe(EDGE_BOTTOM);
    expect((edged[1]!.body as { edge?: number }).edge).toBe(EDGE_BOTTOM);

    // From anywhere else: no edge, or Simulator.app's own gestures break.
    hid.touchBegin(0.5, 0.5);
    hid.touchMove(0.5, 0.4);
    hid.touchEnd(0.5, 0.3);
    await settle();
    const plain = ws.sent
      .map((frame) => decode(frame))
      .filter((frame) => frame.tag === TAG.touch)
      .slice(3);
    expect((plain[0]!.body as { edge?: number }).edge).toBeUndefined();
    expect((plain[1]!.body as { edge?: number }).edge).toBeUndefined();
  });
});
