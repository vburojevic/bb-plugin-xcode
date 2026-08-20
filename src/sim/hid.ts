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

export const HID_MAX_MESSAGE_BYTES = 4096;
export const HID_HANDSHAKE_TIMEOUT_MS = 5000;
export const HID_MAX_SCREEN_EDGE = 32_768;

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
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width <= 0 ||
      height <= 0 ||
      width > HID_MAX_SCREEN_EDGE ||
      height > HID_MAX_SCREEN_EDGE
    ) return null;
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

/** Left GUI — the ⌘ key. iOS honours hardware-keyboard ⌘V in any text field. */
export const KEY_LEFT_GUI = 0xe3;
/** The `v` key, for the paste chord. */
export const KEY_V = 0x19;

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

/**
 * How long a tap holds contact.
 *
 * The old 16ms down-up read as a glitch to some of iOS's recognizers — below
 * the floor of what a human finger produces, let alone what a tap recognizer
 * tuned for human fingers expects. ~45ms is the bottom of a real tap.
 */
export const TAP_DWELL_MS = 45;

/** serve-sim's own bottom-edge constant, used by the swipe-to-home gesture. */
export const EDGE_BOTTOM = 3;

/**
 * One event on the live input stream.
 *
 * `t` is a millisecond timestamp from the sender's own clock — the panel's
 * `event.timeStamp`, or `Date.now()` for a legacy single-event caller. Only the
 * *deltas* are ever read: the replay pump reproduces the spacing between
 * events, never their absolute times, so two senders with different epochs
 * cannot corrupt each other — a jump merely rebases the clock.
 */
export type LiveStreamEvent =
  | { kind: "touch"; phase: TouchPhase; x: number; y: number; t: number }
  | { kind: "multi"; phase: TouchPhase; x1: number; y1: number; x2: number; y2: number; t: number }
  | { kind: "scroll"; dx: number; dy: number; x?: number; y?: number; t: number };

/**
 * A computed wait longer than this is a clock artefact, not a gesture.
 *
 * A held finger legitimately produces long gaps — a long-press streams no
 * moves — and those replay as real waiting because the *arrival* is equally
 * late. A gap bigger than this with events already queued behind it means the
 * sender's clock jumped (a suspended tab, a switched source), and the honest
 * move is to rebase and inject now rather than to freeze input.
 */
export const MAX_LIVE_LAG_MS = 1500;

/**
 * Where a live drag has to start to be the home gesture.
 *
 * The bottom ~6% of the screen is the bezel zone: on Face ID hardware and in
 * Simulator.app alike, a drag that begins there and travels up is "go home",
 * not a scroll that started low. Marking those touches with `EDGE_BOTTOM` is
 * what makes the panel's frame behave like the device's glass edge.
 */
export const EDGE_GESTURE_START_Y = 0.94;

export interface HidSocketOptions {
  port: number;
  udid: string;
  secret: string;
  onConfig(config: ScreenConfig): void;
  onClose(reason: string): void;
  /** Test seam: a fake WebSocket constructor. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
}

type Sender = (data: Buffer) => void;

export class HidSocket {
  private socket: WebSocket | null = null;
  private fingerDown = false;
  private stuckTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private config: ScreenConfig | null = null;
  /**
   * Where the finger is, as far as the device knows.
   *
   * Every `end` must go out at this point. The one that used to go out at the
   * default (0.5, 0.5) is why taps "did nothing": the touch began where the
   * user pressed and then teleported to the centre of the screen before it
   * ended, so iOS delivered it to whatever lives in the middle.
   */
  private lastPoint = { x: 0.5, y: 0.5 };
  /**
   * Whether the current contact is two fingers, and where they are.
   *
   * The guard's lift has to know: ending a pinch with a single-finger `end`
   * leaves the second finger down, and a device with a phantom finger ignores
   * every real one after it.
   */
  private isMulti = false;
  private lastMultiPoint = { x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6 };
  /**
   * Gestures, serialized. An overlap used to throw "a gesture is already in
   * flight" back at the user for tapping twice quickly; gestures are physical
   * things that happen one after another, so they queue one after another.
   */
  private queue: Promise<unknown> = Promise.resolve();
  /** True while a scripted gesture's body is running; live events are refused. */
  private scriptedActive = false;

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
      : new WebSocket(url, {
          headers,
          handshakeTimeout: HID_HANDSHAKE_TIMEOUT_MS,
          maxPayload: HID_MAX_MESSAGE_BYTES,
          perMessageDeflate: false,
        });
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
    this.isMulti = false;
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

  private armStuckTimer(): void {
    this.clearStuckTimer();
    this.stuckTimer = setTimeout(() => this.liftFinger(), STUCK_FINGER_MS);
    this.stuckTimer.unref?.();
  }

  /** A touch frame that also remembers where it happened. */
  private touchSend(phase: TouchPhase, x: number, y: number, edge?: number): void {
    this.lastPoint = { x: clamp01(x), y: clamp01(y) };
    this.send(encodeTouch(phase, x, y, edge));
  }

  /** A multi-touch frame that also remembers where both fingers are. */
  private multiSend(phase: TouchPhase, x1: number, y1: number, x2: number, y2: number): void {
    this.lastMultiPoint = { x1: clamp01(x1), y1: clamp01(y1), x2: clamp01(x2), y2: clamp01(y2) };
    this.send(encodeMultiTouch(phase, x1, y1, x2, y2));
  }

  private liftFinger(): void {
    this.clearStuckTimer();
    if (!this.fingerDown) return;
    this.fingerDown = false;
    const wasMulti = this.isMulti;
    this.isMulti = false;
    this.liveEdge = undefined;
    try {
      // At the point the fingers actually are — never at a default — and with
      // as many fingers as are actually down: a pinch lifted with a
      // single-finger end leaves the second finger wedged on the glass.
      if (wasMulti) {
        const m = this.lastMultiPoint;
        this.multiSend("end", m.x1, m.y1, m.x2, m.y2);
      } else {
        this.touchSend("end", this.lastPoint.x, this.lastPoint.y);
      }
    } catch {
      // The socket died mid-gesture. There is no finger to lift on a device we
      // can no longer reach.
    }
  }

  /** The body of a gesture: tracked touch frames plus the raw send. */
  private async gestureLocked(body: (g: { touch: (phase: TouchPhase, x: number, y: number, edge?: number) => void; send: Sender }) => Promise<void>): Promise<void> {
    if (this.fingerDown) {
      // With gestures queued this only fires when a *live* touch is still
      // down — someone is physically mid-drag on the panel.
      throw new Error("A finger is already down on this simulator.");
    }
    this.fingerDown = true;
    this.scriptedActive = true;
    this.armStuckTimer();
    try {
      await body({ touch: (phase, x, y, edge) => this.touchSend(phase, x, y, edge), send: this.send });
    } finally {
      this.scriptedActive = false;
      this.liftFinger();
    }
  }

  /**
   * The one queue every scripted gesture goes through.
   *
   * `finally` (inside `gestureLocked`) always ends the gesture, and the
   * watchdog covers the case where the body neither returns nor throws — an
   * await that never settles — which is the only way a finger could otherwise
   * stay down. The queue itself swallows nothing: callers still get their
   * rejection, the next gesture simply does not inherit it.
   */
  private enqueueGesture<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // -------------------------------------------------------------------------
  // The live stream: the panel's pointer events, replayed at their own pace
  //
  // These are not gestures and never enter the gesture queue: the panel sends
  // begin, a stream of moves and an end, and iOS does all the recognising —
  // tap, long-press, double-tap, drag — exactly as if a finger were on the
  // glass.
  //
  // RPC is plain HTTP with no ordering between concurrent calls, so the panel
  // ships events in ordered *batches* — one in flight, the rest accumulating —
  // and each event carries the timestamp of the pointer event that made it.
  // The pump here replays the batch at those timestamps' spacing. That is the
  // difference between a flick that arrives as three teleporting positions and
  // one that arrives as the curve the finger actually drew: iOS computes
  // scroll momentum from the last few samples before the lift, and momentum
  // computed from teleports is why remote swiping felt terrible.
  // -------------------------------------------------------------------------

  /** The edge a live drag started on, carried by every frame until it ends. */
  private liveEdge: number | undefined;
  private liveQueue: LiveStreamEvent[] = [];
  private livePumping = false;
  /** The replay clock: wall time that stands for sender time `t`. */
  private liveBase: { wall: number; t: number } | null = null;
  /** When the current live touch's begin was injected, for the dwell floor. */
  private liveBeganAt = 0;

  /**
   * Take a batch of live events onto the replay queue.
   *
   * Refused — `false`, whole batch — while a scripted gesture's body owns the
   * finger: a drive step mid-flight cannot have a human finger spliced into
   * it. The panel reads the boolean and says so, instead of a tap silently
   * doing nothing.
   */
  streamLive(events: readonly LiveStreamEvent[]): boolean {
    if (this.scriptedActive) return false;
    this.liveQueue.push(...events);
    if (!this.livePumping) void this.pumpLive();
    return true;
  }

  /**
   * One pump, draining in order. Every await is a deliberate pace: the queue
   * itself is FIFO and nothing reorders it.
   */
  private async pumpLive(): Promise<void> {
    this.livePumping = true;
    try {
      for (;;) {
        const event = this.liveQueue.shift();
        if (event === undefined) break;
        await this.paceLive(event.t);
        if (event.kind === "touch" && event.phase === "end") await this.holdTapDwell();
        this.injectLive(event);
      }
    } finally {
      this.livePumping = false;
      // A held finger keeps the clock: the end that is coming belongs to the
      // same gesture. A drained queue with no finger down is a boundary.
      if (!this.fingerDown) this.liveBase = null;
    }
  }

  /** Sleep until this event's moment on the replay clock, rebasing when late. */
  private async paceLive(t: number): Promise<void> {
    const now = Date.now();
    if (this.liveBase === null) {
      this.liveBase = { wall: now, t };
      return;
    }
    const wait = this.liveBase.wall + (t - this.liveBase.t) - now;
    if (wait <= 0 || wait > MAX_LIVE_LAG_MS) {
      // Late — the network held a batch — or the sender's clock jumped.
      // Inject now and measure the next delta from reality, so lateness never
      // compounds and a clock jump never freezes input.
      this.liveBase = { wall: now, t };
      return;
    }
    await sleep(wait);
  }

  /**
   * The dwell floor for a live tap.
   *
   * Trackpad tap-to-click produces down and up on the same millisecond, which
   * is below what any iOS tap recognizer accepts as contact — the tap reaches
   * the device perfectly and does nothing. Held to the same floor a scripted
   * tap uses.
   */
  private async holdTapDwell(): Promise<void> {
    if (!this.fingerDown || this.isMulti) return;
    const wait = TAP_DWELL_MS - (Date.now() - this.liveBeganAt);
    if (wait > 0) await sleep(wait);
  }

  private injectLive(event: LiveStreamEvent): void {
    try {
      switch (event.kind) {
        case "scroll":
          this.send(encodeScroll(event.dx, event.dy, event.x, event.y));
          return;
        case "touch":
          this.injectLiveTouch(event);
          return;
        case "multi":
          this.injectLiveMulti(event);
          return;
      }
    } catch {
      // The socket is gone; the close path reports it, and the rest of the
      // queue drains against a device that can no longer be reached.
    }
  }

  /**
   * A begin in the bezel zone is marked as an edge touch, so a drag from the
   * bottom of the frame is the home gesture — the same reading Simulator.app
   * gives a drag from the bottom of its window.
   */
  private injectLiveTouch(event: { phase: TouchPhase; x: number; y: number }): void {
    if (event.phase === "begin") {
      // A begin over a finger that is already down means an end was lost —
      // a dropped batch, a killed panel. Lift it and start clean: the old
      // behaviour (drop the begin) wedged input for the five seconds the
      // stuck-finger watchdog took to notice, which read as "I can't tap
      // anything".
      if (this.fingerDown) this.liftFinger();
      this.fingerDown = true;
      this.isMulti = false;
      this.liveEdge = event.y >= EDGE_GESTURE_START_Y ? EDGE_BOTTOM : undefined;
      this.liveBeganAt = Date.now();
      this.armStuckTimer();
      this.touchSend("begin", event.x, event.y, this.liveEdge);
      return;
    }
    // Orphans — a move or end with no finger down, or with two fingers down —
    // are meaningless and must not reach the device.
    if (!this.fingerDown || this.isMulti) return;
    if (event.phase === "move") {
      // A moving finger is demonstrably alive; only an *abandoned* one is
      // stuck. Re-arming here is what lets a slow six-second drag finish.
      this.armStuckTimer();
      this.touchSend("move", event.x, event.y, this.liveEdge);
      return;
    }
    this.fingerDown = false;
    this.liveEdge = undefined;
    this.clearStuckTimer();
    this.touchSend("end", event.x, event.y);
  }

  /** Two live fingers — the panel's trackpad pinch, streamed like the drag. */
  private injectLiveMulti(event: { phase: TouchPhase; x1: number; y1: number; x2: number; y2: number }): void {
    if (event.phase === "begin") {
      if (this.fingerDown) this.liftFinger();
      this.fingerDown = true;
      this.isMulti = true;
      this.liveBeganAt = Date.now();
      this.armStuckTimer();
      this.multiSend("begin", event.x1, event.y1, event.x2, event.y2);
      return;
    }
    if (!this.fingerDown || !this.isMulti) return;
    if (event.phase === "move") {
      this.armStuckTimer();
      this.multiSend("move", event.x1, event.y1, event.x2, event.y2);
      return;
    }
    this.fingerDown = false;
    this.isMulti = false;
    this.clearStuckTimer();
    this.multiSend("end", event.x1, event.y1, event.x2, event.y2);
  }

  /** Finger down, as a single legacy event. `Date.now()` paces by arrival. */
  touchBegin(x: number, y: number): void {
    this.streamLive([{ kind: "touch", phase: "begin", x, y, t: Date.now() }]);
  }

  /** Finger moved. With no finger down there is nothing to move. */
  touchMove(x: number, y: number): void {
    this.streamLive([{ kind: "touch", phase: "move", x, y, t: Date.now() }]);
  }

  /** Finger up, at the point it was lifted. */
  touchEnd(x: number, y: number): void {
    this.streamLive([{ kind: "touch", phase: "end", x, y, t: Date.now() }]);
  }

  // -------------------------------------------------------------------------
  // Scripted gestures: the agent tool, the control bar, drive scripts
  // -------------------------------------------------------------------------

  /** How long a tap holds contact. 16ms reads as a glitch; this is a human tap's floor. */
  private async tapOnce(x: number, y: number): Promise<void> {
    await this.gestureLocked(async ({ touch }) => {
      touch("begin", x, y);
      await sleep(TAP_DWELL_MS);
    });
  }

  tap(x: number, y: number): Promise<void> {
    return this.enqueueGesture(() => this.tapOnce(x, y));
  }

  doubleTap(x: number, y: number): Promise<void> {
    return this.enqueueGesture(async () => {
      await this.tapOnce(x, y);
      await sleep(80);
      await this.tapOnce(x, y);
    });
  }

  longPress(x: number, y: number, holdMs = 700): Promise<void> {
    return this.enqueueGesture(async () => {
      await this.gestureLocked(async ({ touch }) => {
        touch("begin", x, y);
        // A press with no movement is a press; the moves keep the gesture alive
        // for iOS's own long-press recognizers.
        const steps = Math.max(1, Math.round(holdMs / 100));
        for (let i = 0; i < steps; i += 1) {
          await sleep(100);
          touch("move", x, y);
        }
      });
    });
  }

  swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    durationMs = 250,
    edge?: number,
  ): Promise<void> {
    return this.enqueueGesture(async () => {
      await this.gestureLocked(async ({ touch }) => {
        const steps = Math.max(2, Math.min(30, Math.round(durationMs / 16)));
        touch("begin", from.x, from.y, edge);
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          await sleep(durationMs / steps);
          // The last step is `to` exactly — interpolation drift
          // (0.19999999999999996) is a real coordinate on a 3× display.
          touch(
            "move",
            i === steps ? to.x : from.x + (to.x - from.x) * t,
            i === steps ? to.y : from.y + (to.y - from.y) * t,
            edge,
          );
        }
      });
    });
  }

  /**
   * A two-finger pinch, which is the gesture the CLI cannot send at all: its
   * `gesture` subcommand hardcodes tag `0x03`, so a pinch arrives as a single
   * touch with undefined coordinates.
   */
  pinch(
    center: { x: number; y: number },
    fromSpread: number,
    toSpread: number,
    durationMs = 300,
  ): Promise<void> {
    return this.enqueueGesture(async () => {
      await this.gestureLocked(async () => {
        const steps = Math.max(2, Math.min(30, Math.round(durationMs / 16)));
        const at = (spread: number): [number, number, number, number] => [
          center.x - spread / 2,
          center.y - spread / 2,
          center.x + spread / 2,
          center.y + spread / 2,
        ];
        // Marked as a two-finger contact so an abort mid-pinch — a thrown
        // send, the watchdog — lifts *both* fingers. A pinch lifted with a
        // single-finger end leaves the second one wedged on the glass.
        this.isMulti = true;
        this.multiSend("begin", ...at(fromSpread));
        for (let i = 1; i <= steps; i += 1) {
          const t = i / steps;
          await sleep(durationMs / steps);
          this.multiSend("move", ...at(fromSpread + (toSpread - fromSpread) * t));
        }
        this.multiSend("end", ...at(toSpread));
        // Both fingers are up; the guard's lift in `finally` has nothing to do.
        this.fingerDown = false;
        this.isMulti = false;
      });
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

  /**
   * ⌘V, as a hardware-keyboard chord.
   *
   * The other half of typing: the HID keyboard is a US layout and can type
   * ASCII only, so text with an é or an emoji goes to the *device pasteboard*
   * (`simctl pbcopy`) and this chord pastes it — iOS honours hardware-keyboard
   * shortcuts in any text field.
   */
  async pasteChord(): Promise<void> {
    this.send(encodeKey("down", KEY_LEFT_GUI));
    await sleep(8);
    this.send(encodeKey("down", KEY_V));
    await sleep(8);
    this.send(encodeKey("up", KEY_V));
    await sleep(8);
    this.send(encodeKey("up", KEY_LEFT_GUI));
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
