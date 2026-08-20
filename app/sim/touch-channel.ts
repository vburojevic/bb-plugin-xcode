/**
 * The live-input transport: ordered, batched, never blocking the pointer.
 *
 * RPC is plain HTTP — no ordering between concurrent calls — so order is made
 * here: **exactly one batch in flight**, everything that arrives meanwhile
 * accumulates into the next one. Nothing is thrown away on the way: every
 * sample keeps its own timestamp, and the server replays a batch at the
 * timestamps' spacing. On a loopback link a batch is one or two events; over
 * a remote bb connection it is a whole stretch of the drag — delivered smooth, one
 * round-trip late, instead of as three teleporting positions.
 *
 * The predecessor of this class collapsed queued moves to the freshest one,
 * which was right for a transport that could only afford one event per
 * round-trip and is exactly wrong now: iOS computes flick momentum from the
 * spacing of the last few samples before the lift, and a collapsed drag has
 * no spacing left to read.
 *
 * Everything here is synchronous except `send`, and the class needs no DOM —
 * the tests drive it with a controllable send.
 */
export type TouchPhase = "begin" | "move" | "end";

export type StreamEvent =
  | { kind: "touch"; phase: TouchPhase; x: number; y: number; t: number }
  | { kind: "multi"; phase: TouchPhase; x1: number; y1: number; x2: number; y2: number; t: number }
  | { kind: "scroll"; dx: number; dy: number; x?: number; y?: number; t: number };

/** The contract's cap per call; a longer backlog ships as several batches. */
export const MAX_BATCH = 128;

/**
 * Thin the backlog beyond this — a link this far behind is not going to show
 * a faithful drag anyway, and an unbounded queue on a dead link is a leak.
 * Boundaries are never thinned: a begin or an end that vanishes is a stuck
 * finger, where a missing move is merely a straighter line.
 */
export const MAX_BACKLOG = 512;

export class TouchChannel {
  private backlog: StreamEvent[] = [];
  private inFlight = false;
  /**
   * A send failed mid-gesture, so the rest of that gesture is meaningless —
   * moves for a begin the device may never have seen. Dropped until the next
   * begin starts a fresh story. Scrolls are stateless and keep flowing.
   */
  private poisoned = false;
  /** Where the current contact is, for the recovery lift. */
  private lastTouch: { x: number; y: number; t: number } | null = null;
  private lastMulti: { x1: number; y1: number; x2: number; y2: number; t: number } | null = null;
  private contact: "touch" | "multi" | null = null;

  constructor(
    private readonly send: (events: StreamEvent[]) => Promise<unknown>,
    /** A send failed; the gesture in flight was compromised and dropped. */
    private readonly onError?: () => void,
  ) {}

  push(event: StreamEvent): void {
    if (this.poisoned) {
      const startsFresh = event.kind !== "scroll" && event.phase === "begin";
      if (!startsFresh && event.kind !== "scroll") return;
      if (startsFresh) this.poisoned = false;
    }
    if (event.kind === "touch") {
      this.lastTouch = { x: event.x, y: event.y, t: event.t };
      if (event.phase === "begin") this.contact = "touch";
      if (event.phase === "end") this.contact = null;
    } else if (event.kind === "multi") {
      this.lastMulti = { x1: event.x1, y1: event.y1, x2: event.x2, y2: event.y2, t: event.t };
      if (event.phase === "begin") this.contact = "multi";
      if (event.phase === "end") this.contact = null;
    }
    this.backlog.push(event);
    this.thin();
    if (!this.inFlight) void this.pump();
  }

  /** How many events are queued unsent. For tests and diagnostics. */
  get pending(): number {
    return this.backlog.length;
  }

  /** Drop every other move, never a boundary, until the backlog is sane. */
  private thin(): void {
    if (this.backlog.length <= MAX_BACKLOG) return;
    let parity = false;
    this.backlog = this.backlog.filter((event) => {
      const isMove = event.kind !== "scroll" && event.phase === "move";
      if (!isMove) return true;
      parity = !parity;
      return parity;
    });
  }

  private async pump(): Promise<void> {
    this.inFlight = true;
    try {
      // True while the head of the backlog is the recovery lift for a failed
      // gesture — a lift that fails too is not worth a second report or a
      // second lift.
      let recovering = false;
      while (this.backlog.length > 0) {
        const batch = this.backlog.splice(0, MAX_BATCH);
        try {
          await this.send(batch);
          recovering = false;
        } catch {
          // The batch may or may not have reached the device — an HTTP error
          // says nothing about delivery. Either way the gesture's continuity
          // is gone: drop its remnants, and *queue* a lift for whatever finger
          // might be down, so the device is not wedged until the server's
          // watchdog notices. Queued, not fired: a lift raced out-of-band
          // could land after a fresh begin and end the wrong gesture. An
          // orphan lift is dropped server-side; a missing one is five seconds
          // of dead input.
          this.poisoned = true;
          if (!recovering) this.onError?.();
          const lift: StreamEvent | null = recovering ? null : this.recoveryLift();
          // Anything already queued from a *fresh* gesture survives: scrolls,
          // and everything from the first new begin onward. Moves before that
          // begin belonged to the gesture that just died.
          const firstBegin = this.backlog.findIndex(
            (event) => event.kind !== "scroll" && event.phase === "begin",
          );
          const survivors = this.backlog.filter(
            (event, index) => event.kind === "scroll" || (firstBegin !== -1 && index >= firstBegin),
          );
          if (firstBegin !== -1) this.poisoned = false;
          this.backlog = lift === null ? survivors : [lift, ...survivors];
          recovering = lift !== null;
        }
      }
    } finally {
      this.inFlight = false;
      if (this.backlog.length > 0) void this.pump();
    }
  }

  /** The end frame for whatever contact is down, and the book closed on it. */
  private recoveryLift(): StreamEvent | null {
    const lift: StreamEvent | null =
      this.contact === "multi" && this.lastMulti !== null
        ? { kind: "multi", phase: "end", ...this.lastMulti }
        : this.contact === "touch" && this.lastTouch !== null
          ? { kind: "touch", phase: "end", ...this.lastTouch }
          : null;
    this.contact = null;
    return lift;
  }
}
