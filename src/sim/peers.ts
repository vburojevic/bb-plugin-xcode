/**
 * Optional integrations. Every one is detected, every one has a working default
 * when absent, and none can fail the plugin.
 *
 * **Detection is `enabled === true && (status === "running" || "degraded")`.**
 * There is no `"ok"` plugin status — the enum is `error | running | missing |
 * incompatible | disabled | degraded | needs-configuration`, verified in
 * `types/bb-plugin-sdk.d.ts`. A draft of this matched `"ok"`, so both
 * integrations would have evaluated false forever, silently by design, and
 * nobody would ever have debugged it.
 *
 * `degraded` means a background service is still stopping and the plugin is
 * still callable, so it is accepted deliberately rather than by accident.
 */

export interface PluginSummary {
  id: string;
  enabled: boolean;
  status: string;
}

/** The statuses at which a peer can actually answer. */
export const AVAILABLE_STATUSES = new Set(["running", "degraded"]);

export function isAvailable(plugins: readonly PluginSummary[], id: string): boolean {
  const peer = plugins.find((plugin) => plugin.id === id);
  return peer !== undefined && peer.enabled && AVAILABLE_STATUSES.has(peer.status);
}

/** Re-checked lazily at most this often, at the moment a run starts. */
export const PEER_CACHE_MS = 60_000;

export class PeerDetector {
  private cache: { at: number; plugins: PluginSummary[] } | null = null;

  constructor(
    private readonly list: () => Promise<PluginSummary[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * One call in response to an action, never a schedule.
   *
   * A failure means "absent" rather than "error": a peer that cannot be listed
   * cannot be delegated to either, and the fallback path is always present.
   */
  async plugins(): Promise<PluginSummary[]> {
    const at = this.now();
    if (this.cache !== null && at - this.cache.at < PEER_CACHE_MS) return this.cache.plugins;
    try {
      const plugins = await this.list();
      this.cache = { at, plugins };
      return plugins;
    } catch {
      this.cache = { at, plugins: [] };
      return [];
    }
  }

  async has(id: string): Promise<boolean> {
    return isAvailable(await this.plugins(), id);
  }

  invalidate(): void {
    this.cache = null;
  }
}

export const XCODE_PLUGIN_ID = "xcode";
export const CONNECT_PLUGIN_ID = "connect";

/**
 * The line a run's Facts carries about how it built.
 *
 * The coupling to the Xcode plugin is a different argv plus one read of a
 * plugin list — **zero cross-plugin RPC calls** — so a skew in its RPC contract
 * cannot break this. The narrower claim is the true one: `bb xcode run --wait
 * --` is itself a contract, and a renamed flag or a missing `bb` on PATH falls
 * back to the direct driver with this line attached.
 */
export function describeBuildPath(via: "xcode-plugin" | "xcodebuild"): string {
  return via === "xcode-plugin"
    ? "Built via the Xcode plugin."
    : "Built with xcodebuild directly — install bb-plugin-xcode for parsed errors.";
}
