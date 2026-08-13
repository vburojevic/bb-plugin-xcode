/**
 * The exposure guard: consent, a capability token, a TTL, and every teardown
 * trigger.
 *
 * **Consent is per session, explicit, never a default.** The dialog states
 * three facts in words: what is on screen right now, who can reach it, and for
 * how long. The confirm button reads `Expose for 30 minutes`, not `OK`.
 *
 * **The capability token lives in memory only** — never in the database, never
 * in kv, never in a log line, never in an RPC response to any surface other
 * than the one that requested it, never in a tool result. Nothing about an
 * exposure is persisted, so a bb restart ends it.
 *
 * **Teardown is automatic** on whichever comes first: TTL expiry; the opening
 * panel unmounting with no viewer client for five minutes; the device shutting
 * down; plugin dispose; or a bb restart.
 *
 * That five minutes is not a guess. Un-declaring a port restarts the host's
 * *whole* tunnel — `applyShareSet` calls `stopCurrentConnection()` on any
 * removed port, with the upstream comment "Restarting revokes already-live HTTP
 * and WebSocket streams to every removed target" — so every teardown
 * momentarily drops other plugins' shares and the user's own
 * `bb connect expose` on that Mac. Sixty seconds of idle would do that far too
 * eagerly.
 */
import { randomBytes } from "node:crypto";

/** How long after the last viewer disconnects before an exposure tears down. */
export const IDLE_TEARDOWN_MS = 5 * 60_000;

export type ExposureReason =
  | "ttl"
  | "idle"
  | "device-gone"
  | "stopped"
  | "disposed";

export interface Exposure {
  /** Capability token. In memory only, and never logged. */
  token: string;
  udid: string;
  deviceName: string;
  port: number;
  url: string;
  startedAt: number;
  expiresAt: number;
}

export interface GuardDeps {
  now?: () => number;
  /** Called with the reason whenever an exposure ends, for logging and teardown. */
  onEnd: (exposure: Exposure, reason: ExposureReason) => void;
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export class ExposureGuard {
  private active: Exposure | null = null;
  private ttlTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private viewers = 0;

  constructor(private readonly deps: GuardDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** At most one live exposure, ever. Two would be two blast radii. */
  current(): Exposure | null {
    if (this.active === null) return null;
    if (this.active.expiresAt <= this.now()) {
      this.end("ttl");
      return null;
    }
    return this.active;
  }

  /** What the banner and the header chip read. Never the token. */
  summary(): { msLeft: number } | null {
    const exposure = this.current();
    return exposure === null ? null : { msLeft: exposure.expiresAt - this.now() };
  }

  start(input: { udid: string; deviceName: string; port: number; url: string; ttlMs: number }): Exposure {
    this.end("stopped");
    const at = this.now();
    const exposure: Exposure = {
      token: newToken(),
      udid: input.udid,
      deviceName: input.deviceName,
      port: input.port,
      url: input.url,
      startedAt: at,
      expiresAt: at + input.ttlMs,
    };
    this.active = exposure;
    this.viewers = 0;
    this.ttlTimer = setTimeout(() => this.end("ttl"), input.ttlMs);
    this.ttlTimer.unref?.();
    // Nothing has connected yet, so the idle clock starts immediately: an
    // exposure nobody opened should not sit there for half an hour.
    this.armIdle();
    return exposure;
  }

  /** Validate a token from a request. Constant-time is unnecessary here: it is
   * compared against a value only this process knows, and a miss is a 404
   * rather than a hint. The length check is what stops a trivial guess. */
  isValid(token: string): boolean {
    const exposure = this.current();
    if (exposure === null) return false;
    if (token.length !== exposure.token.length) return false;
    return token === exposure.token;
  }

  noteViewerOpened(): void {
    this.viewers += 1;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  noteViewerClosed(): void {
    this.viewers = Math.max(0, this.viewers - 1);
    if (this.viewers === 0) this.armIdle();
  }

  private armIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.end("idle"), IDLE_TEARDOWN_MS);
    this.idleTimer.unref?.();
  }

  /** The device went away. An exposure of a dead device is a live URL to nothing. */
  noteDeviceGone(udid: string): void {
    if (this.active?.udid === udid) this.end("device-gone");
  }

  end(reason: ExposureReason): void {
    const exposure = this.active;
    if (this.ttlTimer !== null) clearTimeout(this.ttlTimer);
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.ttlTimer = null;
    this.idleTimer = null;
    this.active = null;
    this.viewers = 0;
    if (exposure === null) return;
    try {
      this.deps.onEnd(exposure, reason);
    } catch {
      // Teardown reporting must never throw into a timer.
    }
  }
}

/**
 * The consent dialog's three facts, in words.
 *
 * "Anyone signed in to your bb account, on any device" is the honest blast
 * radius: meaningfully smaller than the open internet, and still a real one.
 */
export function consentText(input: {
  deviceName: string;
  foregroundBundleId: string | null;
  minutes: number;
}): { title: string; facts: string[]; confirmLabel: string } {
  const onScreen =
    input.foregroundBundleId === null
      ? `${input.deviceName} is showing its home screen right now.`
      : `${input.deviceName} is showing ${input.foregroundBundleId} right now.`;
  return {
    title: `Expose ${input.deviceName}?`,
    facts: [
      onScreen,
      "Anyone signed in to your bb account, on any device, will be able to see and touch it — a meaningfully smaller blast radius than the open internet, and still a real one.",
      `It tears itself down after ${input.minutes} minutes, or five minutes after the last viewer disconnects.`,
      "Stopping it briefly interrupts other shares on this Mac, including your own `bb connect expose`.",
    ],
    confirmLabel: `Expose for ${input.minutes} minutes`,
  };
}

/** What `bb sims status` says once an exposure exists. Never the URL. */
export const HIDDEN_LINK = "exposed (link hidden — reopen the panel)";
