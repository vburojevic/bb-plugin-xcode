/**
 * When does "an agent is driving the simulator" begin?
 *
 * Every tool call and every CLI gesture takes the lease and gives it back, so
 * the lease alone cannot tell a *session* from a *step*: a thread tapping five
 * times in ten seconds acquires five times. Announcing each one would reopen
 * the side panel five times — and, worse, reopen a tab the person had just
 * closed because they did not want it.
 *
 * So a session is a run of acquisitions by one thread with no gap longer than
 * `quietMs`, and it is announced exactly once, at its first acquisition. The
 * window slides: as long as the thread keeps driving, nothing new is said. A
 * closed tab therefore stays closed until the agent stops for a while and
 * comes back — the same rhythm the lease TTL already gives the human.
 *
 * Pure, and keyed on the thread rather than the device: it is the thread's
 * panel that opens, whichever simulator it happens to be driving.
 */

export const DRIVE_QUIET_MS = 90_000;

export class DriveAnnouncer {
  private lastSeen = new Map<string, number>();

  constructor(
    private readonly quietMs: number = DRIVE_QUIET_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record that `threadId` just took the lease. Returns true when this is the
   * first acquisition of a new session — the one worth telling the UI about.
   */
  touch(threadId: string): boolean {
    const at = this.now();
    const previous = this.lastSeen.get(threadId);
    this.lastSeen.set(threadId, at);
    return previous === undefined || at - previous > this.quietMs;
  }

  /** Forget a thread, so its next acquisition announces again. */
  forget(threadId: string): void {
    this.lastSeen.delete(threadId);
  }
}
