/**
 * A short per-thread lease on a device.
 *
 * Three parallel agent threads — bb's core workflow — tapping one booted
 * simulator interleave gestures, and each gets back a frame of a screen another
 * agent navigated to. That is worse than having no eyes at all: a wrong
 * screenshot is confidently wrong.
 *
 * So a second thread either gets a second booted device or the sentence
 * *"Another thread is driving iPhone 17 Pro right now."* The lease is
 * re-entrant for its holder, because a drive followed by a capture is one
 * thread doing one thing.
 *
 * Every lease expires. A tool call that dies mid-gesture must not wedge the
 * device until the next reload.
 */

/** Long enough for a 24-step drive with waits; short enough to forgive a crash. */
export const LEASE_TTL_MS = 90_000;

export type LeaseOutcome =
  | { ok: true; release: () => void }
  | { ok: false; ok2?: never; reason: string };

interface Held {
  /** `null` means the panel, which is a person and outranks nothing. */
  threadId: string | null;
  expiresAt: number;
  depth: number;
}

export class LeaseRegistry {
  private held = new Map<string, Held>();

  constructor(
    private readonly deviceName: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Take the lease for `key`, or explain who has it.
   *
   * The panel (`threadId === null`) takes the lease the same way a thread does:
   * a person tapping while an agent drives produces exactly the same
   * interleaving, and the person will believe the result.
   */
  acquire(key: string, threadId: string | null): LeaseOutcome {
    const at = this.now();
    const current = this.held.get(key);

    if (current !== undefined && current.expiresAt > at && current.threadId !== threadId) {
      return {
        ok: false,
        reason: `Another thread is driving ${this.deviceName()} right now. Wait for it to finish rather than retrying.`,
      };
    }

    const next: Held =
      current !== undefined && current.expiresAt > at && current.threadId === threadId
        ? { threadId, expiresAt: at + LEASE_TTL_MS, depth: current.depth + 1 }
        : { threadId, expiresAt: at + LEASE_TTL_MS, depth: 1 };
    this.held.set(key, next);

    let released = false;
    return {
      ok: true,
      release: () => {
        // Exactly once: a `finally` that runs twice must not drop someone
        // else's lease.
        if (released) return;
        released = true;
        const holder = this.held.get(key);
        if (holder === undefined || holder.threadId !== threadId) return;
        if (holder.depth > 1) {
          this.held.set(key, { ...holder, depth: holder.depth - 1 });
          return;
        }
        this.held.delete(key);
      },
    };
  }

  /** Who holds it, for the panel's own "someone else is driving" affordance. */
  holder(key: string): string | null | undefined {
    const current = this.held.get(key);
    if (current === undefined || current.expiresAt <= this.now()) return undefined;
    return current.threadId;
  }

  releaseAll(): void {
    this.held.clear();
  }
}
