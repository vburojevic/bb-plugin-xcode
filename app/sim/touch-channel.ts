/**
 * The live-touch transport: ordered, coalescing, never blocking the pointer.
 *
 * A drag produces pointermove at display rate (up to 120/s), and every one of
 * these is a network round trip. The two rules that make it feel like glass
 * anyway:
 *
 *  - **Begin and end are boundaries.** They are never dropped, merged or
 *    reordered — a tap is exactly `begin` then `end`, and anything else is a
 *    different gesture.
 *  - **Moves are latest-wins.** While one send is in flight, every newer move
 *    replaces the queued one. The device needs to know where the finger is
 *    *now*, not every place it used to be; a backlog of stale positions is
 *    what a laggy drag is made of.
 *
 * Everything here is synchronous except `send`, and the class needs no DOM —
 * the tests drive it with a controllable send.
 */
export type TouchPhase = "begin" | "move" | "end";

export interface TouchEvent {
  phase: TouchPhase;
  x: number;
  y: number;
}

export class TouchChannel {
  private events: TouchEvent[] = [];
  private pumping = false;

  constructor(
    private readonly send: (phase: TouchPhase, x: number, y: number) => Promise<unknown>,
    /** A send failed; the gesture in flight is compromised and was dropped. */
    private readonly onError?: () => void,
  ) {}

  push(phase: TouchPhase, x: number, y: number): void {
    const last = this.events[this.events.length - 1];
    if (phase === "move" && last !== undefined && last.phase === "move") {
      // Collapse into the queued move: this is the latest-wins rule, and the
      // boundary rule holds because we only ever append — a queued move can
      // never leapfrog a begin or an end.
      last.x = x;
      last.y = y;
    } else {
      this.events.push({ phase, x, y });
    }
    if (!this.pumping) void this.pump();
  }

  /** How many events are queued unsent. For tests and diagnostics. */
  get pending(): number {
    return this.events.length;
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      for (;;) {
        const next = this.events.shift();
        if (next === undefined) break;
        try {
          await this.send(next.phase, next.x, next.y);
        } catch {
          // A failed send breaks the gesture's continuity — a begin that never
          // arrived makes every move after it meaningless. Drop the rest of
          // the gesture rather than delivering a finger that never went down.
          this.events = [];
          this.onError?.();
          break;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
