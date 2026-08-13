/**
 * bb connect detection and the shared-port lifecycle.
 *
 * Detection is cheapest first, and **any failure at any step means
 * "unavailable", never "error"** — an Expose control that is disabled with a
 * sentence is a fine outcome, and a plugin that fails because a peer is absent
 * is not.
 *
 * 1. Is the connect plugin installed, enabled and running (or degraded)?
 * 2. Does its `status` RPC report `paired`? Asked with a **narrow** schema
 *    wanting only that one field, behind an 8-second deadline. `unknown_method`
 *    means the peer's contract moved — fall through rather than fail.
 * 3. `ensureSharedPortTunnel(hostId)` → `{ label, baseDomain }`. Authoritative
 *    *and* the mechanism, so success here is what enables the button.
 *
 * When connect is absent the Expose control is disabled with one sentence and
 * **nothing else changes**: the panel still streams, `bb sims url` still prints
 * a URL that works in any browser on that Mac, and every other feature is
 * untouched. Local-only is a first-class mode.
 */
import { withDeadline } from "./safe.js";
import { CONNECT_PLUGIN_ID, isAvailable, type PluginSummary } from "./peers.js";

export type ConnectState =
  | { available: true; label: string; baseDomain: string }
  | { available: false; reason: "not-installed" | "not-paired" | "no-tunnel"; detail: string };

/** The sentences the disabled control shows. One per reason, and no more. */
export const CONNECT_REASONS: Record<Exclude<ConnectState, { available: true }>["reason"], string> = {
  "not-installed": "bb connect is not installed on this Mac, so there is nothing to expose through.",
  "not-paired": "bb connect is not paired on this Mac — pair it in Settings, then reopen this panel.",
  "no-tunnel": "bb connect could not assign a tunnel for this Mac.",
};

export interface ConnectDeps {
  plugins: () => Promise<PluginSummary[]>;
  /** `bb.sdk.plugins.callRpc` against connect's `status`, narrowly typed. */
  connectStatus: () => Promise<{ paired: boolean }>;
  ensureTunnel: (hostId: string) => Promise<{ label: string; baseDomain: string }>;
  hostId: () => string | null;
}

/** The peer's status call gets a deadline; a hung peer must not hang a panel. */
export const STATUS_DEADLINE_MS = 8000;

export async function detectConnect(deps: ConnectDeps): Promise<ConnectState> {
  if (!isAvailable(await deps.plugins(), CONNECT_PLUGIN_ID)) {
    return { available: false, reason: "not-installed", detail: CONNECT_REASONS["not-installed"] };
  }

  try {
    const status = await withDeadline(deps.connectStatus(), STATUS_DEADLINE_MS, "bb connect status");
    if (!status.paired) {
      return { available: false, reason: "not-paired", detail: CONNECT_REASONS["not-paired"] };
    }
  } catch {
    // `unknown_method` means the peer's contract moved; a deadline means it is
    // busy. Neither is a reason to fail — fall through to the tunnel, which is
    // authoritative anyway.
  }

  const hostId = deps.hostId();
  if (hostId === null) {
    return { available: false, reason: "no-tunnel", detail: CONNECT_REASONS["no-tunnel"] };
  }

  try {
    const tunnel = await withDeadline(deps.ensureTunnel(hostId), STATUS_DEADLINE_MS, "the connect tunnel");
    return { available: true, label: tunnel.label, baseDomain: tunnel.baseDomain };
  } catch {
    return { available: false, reason: "not-paired", detail: CONNECT_REASONS["not-paired"] };
  }
}

/**
 * The public URL for an exposed port.
 *
 * Composed rather than requested: the daemon derives the label and domain from
 * its trusted gate, and a plugin cannot choose either.
 */
export function publicUrl(label: string, baseDomain: string, port: number, token: string): string {
  return `https://${label}--${port}.${baseDomain}/s/${token}/`;
}

/**
 * The warning that goes with every teardown.
 *
 * Un-declaring a port restarts the host's whole tunnel — `applyShareSet` calls
 * `stopCurrentConnection()` on any removed port, with the upstream comment
 * *"Restarting revokes already-live HTTP and WebSocket streams to every removed
 * target"* — so stopping an exposure briefly drops other plugins' shares and
 * the user's own `bb connect expose` on that Mac. Saying so is the difference
 * between a known cost and someone blaming their dev server.
 */
export const TEARDOWN_WARNING =
  "Stopping this briefly interrupts other shares on this Mac, including your own `bb connect expose`.";
