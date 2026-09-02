/**
 * The one realtime channel, and the only shapes allowed on it.
 *
 * Frame pixels never go through realtime. The signals say *what changed*, and
 * the frontend refetches by RPC — which is what keeps a 60fps stream and a
 * broadcast socket in different worlds.
 *
 * Signals are ephemeral and are never replayed, so the frontend reconciles on
 * every `useRealtimeConnectionState()` transition to `"connected"` after the
 * first. That keeps a laptop opened after an hour from rendering stale
 * simulator state.
 */

/** The env var name is `XCSIM_CHANNEL` in the child; this is the value. */
export const CHANNEL = "simulator-changed";

export type SignalKind = "look" | "live";

export interface Signal {
  kind: SignalKind;
}

export function signal(kind: SignalKind): Signal {
  return { kind };
}

/**
 * A thread has started driving the simulator through the agent tools or the
 * CLI. Its own composer, and nothing else, reacts by opening the simulator tab
 * — see `app/sim/useOpenOnDrive.ts`. Separate from `CHANNEL` so the panels
 * that refetch on every `simulator-changed` do not pay for a signal that is
 * not about state.
 */
export const DRIVE_CHANNEL = "simulator-driven";

export interface DriveSignal {
  threadId: string;
  deviceUdid: string;
}
