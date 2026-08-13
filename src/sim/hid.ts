/**
 * HID: the wire encoders, and one persistent control socket per device.
 *
 * ## Why the server owns the socket
 *
 * Two bb windows on the same device would otherwise both open control sockets
 * and fight. The socket is server-owned and the frontend sends input over RPC.
 * The rejected alternative — a direct browser WebSocket to loopback — would
 * shave a millisecond or two, but it lets two windows race, needs a loopback
 * origin the page may not have, and dies entirely under `https:`. Local RPC on
 * loopback costs one to three milliseconds and works identically in every
 * deployment.
 *
 * ## Why never the CLI
 *
 * serve-sim's `gesture` subcommand hardcodes tag `0x03`, so every documented
 * pinch recipe parses as a single touch with undefined coordinates and logs
 * `touch ignored bad input`. And each CLI invocation opens a fresh WebSocket,
 * so a `begin`/`end` pair issued as two calls lands tens of milliseconds apart
 * and reads as a long-press. One persistent socket removes the whole class.
 *
 * ## Stuck fingers
 *
 * HID runs in-process in the native addon and malformed bodies are swallowed by
 * a guard rather than thrown, so a `begin` with no `end` leaves a finger down
 * and wedges input until the device reboots — with no error anywhere. Every
 * gesture is emitted from one function whose `finally` always sends `end`, and
 * the socket emits a synthetic `end` on close, on abort, and on a five-second
 * watchdog.
 */
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Tags — verified byte-for-byte against serve-sim 0.1.45's DeviceSession
// ---------------------------------------------------------------------------

export const TAG = {
  touch: 0x03,
  button: 0x04,
  multiTouch: 0x05,
  key: 0x06,
  orientation: 0x07,
  caDebug: 0x08,
  memoryWarning: 0x09,
  digitalCrown: 0x0a,
  scroll: 0x0b,
  softwareKeyboard: 0x0c,
  /** Server → client only: `{width, height, orientation}`. */
  config: 0x82,
} as const;

export type TouchPhase = "begin" | "move" | "end";
export type KeyPhase = "down" | "up";
export type ButtonPhase = "down" | "up" | "press";

/**
 * The complete button vocabulary. serve-sim's `sendButton` accepts exactly
 * these and prints "Unknown button" for anything else — silently, from inside a
 * child process, where nobody would ever see it.
 *
 * There is deliberately no `shake`: serve-sim has no shake gesture in its HID
 * tags, its button list or its native sources, so offering one would be a
 * control that does nothing.
 */
export const BUTTONS = ["home", "swipe_home", "app_switcher", "lock", "siri", "side_button"] as const;
export type ButtonName = (typeof BUTTONS)[number];

export function isButtonName(value: string): value is ButtonName {
  return (BUTTONS as readonly string[]).includes(value);
}

/**
 * Orientations, in serve-sim's spelling.
 *
 * The wire wants underscores; people, CLIs and this plugin's own drive scripts
 * write hyphens. Normalized in one place so neither spelling is wrong.
 */
export const ORIENTATIONS = ["portrait", "portrait_upside_down", "landscape_left", "landscape_right"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

export function normalizeOrientation(value: string): Orientation | null {
  const key = value.trim().toLowerCase().replace(/-/g, "_");
  return (ORIENTATIONS as readonly string[]).includes(key) ? (key as Orientation) : null;
}

/** One tag byte followed by a JSON body, or a bare tag byte for the two that take none. */
export function frame(tag: number, body?: Record<string, unknown>): Buffer {
  const head = Buffer.from([tag]);
  if (body === undefined) return head;
  return Buffer.concat([head, Buffer.from(JSON.stringify(body), "utf8")]);
}

/** Coordinates are normalized 0–1; the device session multiplies by the frame size. */
export function encodeTouch(phase: TouchPhase, x: number, y: number, edge?: number): Buffer {
  const body: Record<string, unknown> = { type: phase, x: clamp01(x), y: clamp01(y) };
  if (edge !== undefined) body.edge = edge;
  return frame(TAG.touch, body);
}

export function encodeMultiTouch(
  phase: TouchPhase,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Buffer {
  return frame(TAG.multiTouch, {
    type: phase,
    x1: clamp01(x1),
    y1: clamp01(y1),
    x2: clamp01(x2),
    y2: clamp01(y2),
  });
}

export function encodeButton(button: ButtonName): Buffer {
  return frame(TAG.button, { button });
}

/** An arbitrary hardware button by HID (page, usage) — power, volume, action. */
export function encodeButtonHid(page: number, usage: number, phase: ButtonPhase = "press"): Buffer {
  return frame(TAG.button, { page, usage, phase });
}

export function encodeKey(phase: KeyPhase, usage: number): Buffer {
  return frame(TAG.key, { type: phase, usage });
}

export function encodeOrientation(orientation: Orientation): Buffer {
  return frame(TAG.orientation, { orientation });
}

/** `dx`/`dy` are normalized fractions of the frame, like touch coordinates. */
export function encodeScroll(dx: number, dy: number, x?: number, y?: number): Buffer {
  const body: Record<string, unknown> = { dx, dy };
  if (x !== undefined) body.x = clamp01(x);
  if (y !== undefined) body.y = clamp01(y);
  return frame(TAG.scroll, body);
}

export function encodeMemoryWarning(): Buffer {
  return frame(TAG.memoryWarning);
}

export function encodeSoftwareKeyboard(): Buffer {
  return frame(TAG.softwareKeyboard);
}

export function encodeCaDebug(option: string, enabled: boolean): Buffer {
  return frame(TAG.caDebug, { option, enabled });
}

export interface ScreenConfig {
  width: number;
  height: number;
  orientation: string;
}

/**
 * Decode the `0x82` push.
 *
 * This is the only way the plugin learns the device's pixel dimensions — never
 * from configuration, and never from `/config`, which reports `0×0` until the
 * first MJPEG frame and would have every normalized coordinate divide by zero.
 */
export function decodeConfig(data: Buffer): ScreenConfig | null {
  if (data.length < 2 || data[0] !== TAG.config) return null;
  try {
    const raw = JSON.parse(data.subarray(1).toString("utf8")) as Record<string, unknown>;
    const width = typeof raw.width === "number" ? raw.width : 0;
    const height = typeof raw.height === "number" ? raw.height : 0;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
    return {
      width,
      height,
      orientation: typeof raw.orientation === "string" ? raw.orientation : "portrait",
    };
  } catch {
    return null;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/** USB HID Keyboard/Keypad usage page (0x07). */
const UNSHIFTED: Record<string, number> = {
  a: 0x04, b: 0x05, c: 0x06, d: 0x07, e: 0x08, f: 0x09, g: 0x0a, h: 0x0b, i: 0x0c,
  j: 0x0d, k: 0x0e, l: 0x0f, m: 0x10, n: 0x11, o: 0x12, p: 0x13, q: 0x14, r: 0x15,
  s: 0x16, t: 0x17, u: 0x18, v: 0x19, w: 0x1a, x: 0x1b, y: 0x1c, z: 0x1d,
  "1": 0x1e, "2": 0x1f, "3": 0x20, "4": 0x21, "5": 0x22,
  "6": 0x23, "7": 0x24, "8": 0x25, "9": 0x26, "0": 0x27,
  "\n": 0x28, "\t": 0x2b, " ": 0x2c,
  "-": 0x2d, "=": 0x2e, "[": 0x2f, "]": 0x30, "\\": 0x31,
  ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37, "/": 0x38,
};

/** Characters reached by holding shift, mapped to the key that produces them. */
const SHIFTED: Record<string, string> = {
  "!": "1", "@": "2", "#": "3", $: "4", "%": "5",
  "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
  _: "-", "+": "=", "{": "[", "}": "]", "|": "\\",
  ":": ";", '"': "'", "~": "`", "<": ",", ">": ".", "?": "/",
};

export const KEY_LEFT_SHIFT = 0xe1;

/** Named keys a drive script or the panel's keyboard control can send. */
export const NAMED_KEYS: Record<string, number> = {
  enter: 0x28, return: 0x28,
  escape: 0x29, esc: 0x29,
  backspace: 0x2a, delete: 0x2a,
  tab: 0x2b,
  space: 0x2c,
  right: 0x4f, left: 0x50, down: 0x51, up: 0x52,
};

export interface KeyStroke {
  usage: number;
  shift: boolean;
}

/**
 * Text to keystrokes.
 *
 * Unrepresentable characters — emoji, accented letters, anything outside the
 * US keyboard — are dropped rather than approximated, and the caller reports
 * how many. Typing `cafe` when the model asked for `café` is a worse failure
 * than saying one character could not be typed.
 */
export function textToKeystrokes(text: string): { strokes: KeyStroke[]; dropped: string[] } {
  const strokes: KeyStroke[] = [];
  const dropped: string[] = [];
  for (const character of text) {
    const lower = character.toLowerCase();
    if (character >= "A" && character <= "Z") {
      strokes.push({ usage: UNSHIFTED[lower]!, shift: true });
      continue;
    }
    const unshifted = UNSHIFTED[character];
    if (unshifted !== undefined) {
      strokes.push({ usage: unshifted, shift: false });
      continue;
    }
    const base = SHIFTED[character];
    if (base !== undefined) {
      strokes.push({ usage: UNSHIFTED[base]!, shift: true });
      continue;
    }
    if (character === "\r") continue;
    dropped.push(character);
  }
  return { strokes, dropped };
}

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

/** A finger left down for longer than this is a bug; lift it. */
export const STUCK_FINGER_MS = 5000;

/** serve-sim's own bottom-edge constant, used by the swipe-to-home gesture. */
export const EDGE_BOTTOM = 3;

export interface HidSocketOptions {
  port: number;
  udid: string;
  secret: string;
  onConfig(config: ScreenConfig): void;
  onClose(reason: string): void;
  /** Test seam: a fake WebSocket constructor. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
  now?: () => number;
}

type Sender = (data: Buffer) => void;

export class HidSocket {
  private socket: WebSocket | null = null;
  private fingerDown = false;
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private config: ScreenConfig | null = null;

  constructor(private readonly options: HidSocketOptions) {}

  /** The last dimensions pushed by the device, or `null` if it has not said yet. */
  screen(): ScreenConfig | null {
    return this.config;
  }

  open(): Promise<void> {
    const url = `ws://127.0.0.1:${this.options.port}/helper/${this.options.udid}/ws`;
    const headers = { "x-xcode-simulators-key": this.options.secret };
    const socket = this.options.connect
      ? this.options.connect(url, headers)
      : new WebSocket(url, { headers });
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      socket.on("open", () => {
        settled = true;
        resolve();
      });

      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        const config = decodeConfig(buffer);
        if (config === null) return;
        this.config = config;
        try {
          this.options.onConfig(config);
        } catch {
          // A throw from the config sink must not kill the socket.
        }
      });

      socket.on("error", (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }
        this.handleClose(error.message);
      });

      socket.on("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("The capture host closed the control socket."));
          return;
        }
        this.handleClose("closed");
      });
    });
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.clearStuckTimer();
    // The finger is down on a socket that is gone. Nothing can lift it now, and
    // the device will stay wedged — say so rather than losing it.
    this.fingerDown = false;
    try {
      this.options.onClose(reason);
    } catch {
      // Nothing left to report to.
    }
  }

  close(): void {
    if (this.fingerDown) this.liftFinger();
    this.closed = true;
    this.clearStuckTimer();
    try {
      this.socket?.close();
    } catch {
      // Already gone.
    }
    this.socket = null;
  }

  private send: Sender = (data) => {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new Error("The simulator's control socket is not connected.");
    }
    socket.send(data);
  };

  private clearStuckTimer(): void {
    if (this.stuckTimer !== null) clearTimeout(this.stuckTimer);
    this.stuckTimer = null;
  }

  private liftFinger(x = 0.5, y = 0.5): void {
    this.clearStuckTimer();
    if (!this.fingerDown) return;
    this.fingerDown = false;
    try {
      this.send(encodeTouch("end", x, y));
    } catch {
      // The socket died mid-gesture. There is no finger to lift on a device we
      // can no longer reach.
    }
  }

  /**
   * The one function every touch gesture goes through.
   *
   * `finally` always ends the gesture. The watchdog covers the case where the
   * body neither returns nor throws — an await that never settles — which is
   * the only way a finger could otherwise stay down.
   */
  private async gesture(body: (send: Sender) => Promise<void>): Promise<void> {
    if (this.fingerDown) {
      throw new Error("A gesture is already in flight on this simulator.");
    }
    this.fingerDown = true;
    const now = this.options.now ?? Date.now;
    const startedAt = now();
    this.stuckTimer = setTimeout(() => this.liftFinger(), STUCK_FINGER_MS);
    this.stuckTimer.unref?.();
    try {
      await body(this.send);
    } finally {
      // `startedAt` is read so a slow gesture can be told from a wedged one in
      // the log without adding a second timer.
      void startedAt;
      this.liftFinger();
    }
  }

  async tap(x: number, y: number): Promise<void> {
    await this.gesture(async (send) => {
      send(encodeTouch("begin", x, y));
      await sleep(16);
      send(encodeTouch("move", x, y));
    });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.tap(x, y);
    await sleep(80);
    await this.tap(x, y);
  }

  async longPress(x: number, y: number, holdMs = 700): Promise<void> {
    await this.gesture(async (send) => {
      send(encodeTouch("begin", x, y));
      // A press with no movement is a press; the moves keep the gesture alive
      // for iOS's own long-press recognizers.
      const steps = Math.max(1, Math.round(holdMs / 100));
      for (let i = 0; i < steps; i += 1) {
        await sleep(100);
        send(encodeTouch("move", x, y));
      }
    });
  }

  async swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs = 250,
    edge?: number,
  ): Promise<void> {
    await this.gesture(async (send) => {
      const steps = Math.max(2, Math.min(30, Math.round(durationMs / 16)));
      send(encodeTouch("begin", from.x, from.y, edge));
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        await sleep(durationMs / steps);
        send(encodeTouch("move", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, edge));
      }
    });
  }

  /**
   * A two-finger pinch, which is the gesture the CLI cannot send at all: its
   * `gesture` subcommand hardcodes tag `0x03`, so a pinch arrives as a single
   * touch with undefined coordinates.
   */
  async pinch(
    center: { x: number; y: number },
    fromSpread: number,
    toSpread: number,
    durationMs = 300,
  ): Promise<void> {
    await this.gesture(async (send) => {
      const steps = Math.max(2, Math.min(30, Math.round(durationMs / 16)));
      const at = (spread: number): [number, number, number, number] => [
        center.x - spread / 2,
        center.y - spread / 2,
        center.x + spread / 2,
        center.y + spread / 2,
      ];
      send(encodeMultiTouch("begin", ...at(fromSpread)));
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        await sleep(durationMs / steps);
        send(encodeMultiTouch("move", ...at(fromSpread + (toSpread - fromSpread) * t)));
      }
      // Multi-touch has its own end frame; the guard's single-finger lift would
      // leave the second finger down.
      send(encodeMultiTouch("end", ...at(toSpread)));
    });
  }

  /** Scroll is a wheel event, not a drag: no finger to leave behind. */
  scroll(dx: number, dy: number, anchor?: { x: number; y: number }): void {
    this.send(encodeScroll(dx, dy, anchor?.x, anchor?.y));
  }

  async type(text: string): Promise<{ dropped: string[] }> {
    const { strokes, dropped } = textToKeystrokes(text);
    for (const stroke of strokes) {
      if (stroke.shift) this.send(encodeKey("down", KEY_LEFT_SHIFT));
      this.send(encodeKey("down", stroke.usage));
      await sleep(8);
      this.send(encodeKey("up", stroke.usage));
      if (stroke.shift) this.send(encodeKey("up", KEY_LEFT_SHIFT));
      await sleep(8);
    }
    return { dropped };
  }

  async key(usage: number): Promise<void> {
    this.send(encodeKey("down", usage));
    await sleep(8);
    this.send(encodeKey("up", usage));
  }

  button(name: ButtonName): void {
    this.send(encodeButton(name));
  }

  rotate(orientation: Orientation): void {
    this.send(encodeOrientation(orientation));
  }

  softwareKeyboard(): void {
    this.send(encodeSoftwareKeyboard());
  }

  memoryWarning(): void {
    this.send(encodeMemoryWarning());
  }

  /** Swipe up from the bottom edge — the Face ID "go home" gesture. */
  async swipeHome(): Promise<void> {
    await this.swipe({ x: 0.5, y: 0.95 }, { x: 0.5, y: 0.35 }, 200, EDGE_BOTTOM);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
