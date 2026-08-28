/**
 * One bounded chance to replay the whole source ladder.
 *
 * The browser already falls through codecs and routes immediately; retrying
 * each rung independently would multiply the attempts and keep a dead host
 * busy indefinitely. The budget therefore advances only after the *whole*
 * ladder fails, owns at most one timeout, and forgets everything once a frame
 * proves the path healthy again.
 */
export class RetryBudget {
  private readonly delays = [250, 1_000, 3_000] as const;
  private used = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Schedule the next full-ladder replay; false means the terminal action owns recovery. */
  schedule(retry: () => void): boolean {
    if (this.timer !== null) return true;
    const delay = this.delays[this.used];
    if (delay === undefined) return false;
    this.used += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      retry();
    }, delay);
    return true;
  }

  /** A new healthy/session boundary gets all three chances and no stale callback. */
  reset(): void {
    this.cancel();
    this.used = 0;
  }

  /** Source and visibility changes must not leave an old ladder callback behind. */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

interface ReattachState {
  kind: string;
  device: { udid: string } | null;
  streamUrl: string | null;
  directStreamUrl: string | null;
  generation: number;
}

/**
 * Several React roots share the Live store, so each can observe the same parked
 * state in one render. Keying the request here turns that fan-out into one
 * `liveStart`, while a real stream identity or visibility boundary opens the
 * gate for the next park.
 */
export class VisibleReattachGate {
  private claimed: string | null = null;

  update(
    state: ReattachState | null,
    visible: boolean,
    reattach: (udid: string) => Promise<unknown>,
  ): void {
    const parked =
      visible &&
      state?.kind === "waiting-frame" &&
      state.device !== null &&
      // The proxy URL is composable without a child. The direct URL is not:
      // its absence is the server's proof that capture is actually parked.
      state.directStreamUrl === null;
    if (!parked || state === null || state.device === null) {
      this.claimed = null;
      return;
    }

    const key = `${state.device.udid}:${state.generation}`;
    if (this.claimed === key) return;
    this.claimed = key;
    void reattach(state.device.udid).catch(() => {
      if (this.claimed === key) this.claimed = null;
    });
  }

  reset(): void {
    this.claimed = null;
  }
}
