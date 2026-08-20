/** Independent ceilings for the two long-lived same-origin panel routes. */
export const MAX_PANEL_STREAMS = 4;
export const MAX_PANEL_PRESENCES = 4;

/**
 * A small synchronous semaphore for long-lived HTTP responses.
 *
 * Node enters each route handler on one event-loop turn, so acquisition needs
 * no promise or queue. Refusal is deliberate: reconnecting clients get a 503
 * instead of waiting forever while holding another request open.
 */
export class ConnectionLimit {
  #active = 0;

  constructor(readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new RangeError("A connection limit must be a positive integer.");
    }
  }

  get active(): number {
    return this.#active;
  }

  /** Acquire one slot, or return `null` when the ceiling is already full. */
  tryAcquire(): (() => void) | null {
    if (this.#active >= this.maximum) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }
}
