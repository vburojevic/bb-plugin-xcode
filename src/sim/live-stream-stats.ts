/**
 * Ephemeral viewer evidence.
 *
 * This is intentionally not a database and has no sweeper. A renderer sends
 * one bounded sample every thirty paints (plus state changes); reads and
 * writes prune the fifteen-second window synchronously. Nothing wakes merely
 * to discover that nobody is watching a simulator.
 */
import type { LiveStreamHealth, LiveStreamSample } from "./contract.js";
import type { HostStreamStatus } from "./sim-host-client.js";

export const LIVE_STREAM_STATS_TTL_MS = 15_000;
export const LIVE_STREAM_STATS_FRESH_MS = 5_000;
const LIVE_STREAM_STATS_LIMIT = 48;

interface StoredSample {
  sample: LiveStreamSample;
  receivedAt: number;
}

export interface LiveStreamStatsQuery {
  deviceUdid?: string;
  hostGeneration?: number;
}

function keyOf(sample: LiveStreamSample): string {
  return `${sample.viewerId}\0${sample.deviceUdid}\0${sample.hostGeneration}`;
}

function average(values: Array<number | null>): number | null {
  const measured = values.filter((value): value is number => value !== null);
  if (measured.length === 0) return null;
  return Math.round((measured.reduce((sum, value) => sum + value, 0) / measured.length) * 10) / 10;
}

function maximum(values: Array<number | null>): number | null {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length === 0 ? null : Math.max(...measured);
}

export class LiveStreamStatsStore {
  private readonly entries = new Map<string, StoredSample>();

  constructor(private readonly now: () => number = Date.now) {}

  write(sample: LiveStreamSample): LiveStreamHealth {
    const now = this.now();
    this.prune(now);
    // `Map.set` does not move an existing key. Delete first so eviction is by
    // receive time rather than by whichever renderer happened to arrive first
    // during plugin startup — every cadence sample is a full replacement.
    this.entries.delete(keyOf(sample));
    this.entries.set(keyOf(sample), { sample: { ...sample }, receivedAt: now });
    while (this.entries.size > LIVE_STREAM_STATS_LIMIT) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return this.read({ deviceUdid: sample.deviceUdid, hostGeneration: sample.hostGeneration });
  }

  read(query: LiveStreamStatsQuery = {}): LiveStreamHealth {
    const now = this.now();
    this.prune(now);
    const stored = [...this.entries.values()]
      .filter(({ sample }) => query.deviceUdid === undefined || sample.deviceUdid === query.deviceUdid)
      .filter(({ sample }) => query.hostGeneration === undefined || sample.hostGeneration === query.hostGeneration)
      .sort((a, b) => b.receivedAt - a.receivedAt);
    const viewers = stored.map(({ sample, receivedAt }) => {
      const ageMs = Math.max(0, now - receivedAt);
      return {
        ...sample,
        receivedAt,
        ageMs,
        freshness: ageMs <= LIVE_STREAM_STATS_FRESH_MS && sample.state === "live" ? "fresh" as const : "stale" as const,
      };
    });
    if (viewers.length === 0) {
      return {
        status: "unavailable",
        deviceUdid: query.deviceUdid ?? null,
        hostGeneration: query.hostGeneration ?? null,
        viewerCount: 0,
        freshViewerCount: 0,
        staleViewerCount: 0,
        codec: null,
        route: null,
        qualityProfile: null,
        sourceFps: null,
        paintFps: null,
        bytesPerSecond: null,
        decoderQueuePeak: 0,
        sequenceGaps: 0,
        discontinuities: 0,
        resyncs: 0,
        reconnects: 0,
        repeatedSurfaces: 0,
        lastPaintAt: null,
        excessLatencyMs: null,
        viewers: [],
      };
    }

    const freshViewerCount = viewers.filter((viewer) => viewer.freshness === "fresh").length;
    const newest = viewers[0]!;
    return {
      status: freshViewerCount > 0 ? "live" : "stale",
      deviceUdid: query.deviceUdid ?? newest.deviceUdid,
      hostGeneration: query.hostGeneration ?? newest.hostGeneration,
      viewerCount: viewers.length,
      freshViewerCount,
      staleViewerCount: viewers.length - freshViewerCount,
      codec: newest.codec,
      route: newest.route,
      qualityProfile: newest.qualityProfile,
      sourceFps: average(viewers.map((viewer) => viewer.sourceFps)),
      paintFps: average(viewers.map((viewer) => viewer.paintFps)),
      bytesPerSecond: average(viewers.map((viewer) => viewer.bytesPerSecond)),
      decoderQueuePeak: Math.max(...viewers.map((viewer) => viewer.decoderQueuePeak)),
      sequenceGaps: Math.max(...viewers.map((viewer) => viewer.sequenceGaps)),
      discontinuities: Math.max(...viewers.map((viewer) => viewer.discontinuities)),
      resyncs: Math.max(...viewers.map((viewer) => viewer.resyncs)),
      reconnects: Math.max(...viewers.map((viewer) => viewer.reconnects)),
      repeatedSurfaces: Math.max(...viewers.map((viewer) => viewer.repeatedSurfaces)),
      lastPaintAt: Math.max(...viewers.map((viewer) => viewer.lastPaintAt ?? 0)) || null,
      excessLatencyMs: maximum(viewers.map((viewer) => viewer.excessLatencyMs)),
      viewers,
    };
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.receivedAt > LIVE_STREAM_STATS_TTL_MS) this.entries.delete(key);
    }
  }
}

export function formatStreamHealth(health: LiveStreamHealth): string {
  if (health.status === "unavailable") return "Stream health: unavailable.";
  const codec = health.codec === "h264" ? "H.264" : "MJPEG";
  const pace = health.paintFps === null ? "paint fps unmeasured" : `${Math.round(health.paintFps)} paint fps`;
  const excess = health.excessLatencyMs === null
    ? "excess viewer backlog unmeasured"
    : `${Math.round(health.excessLatencyMs)} ms excess viewer backlog`;
  return `Stream health (${health.status}): ${codec}/${health.route}/${health.qualityProfile}; ${pace}; ${excess}; ${health.sequenceGaps} gaps; ${health.resyncs} resyncs.`;
}

/**
 * The child owns encoder truth; renderer telemetry cannot infer whether a
 * reconnect created a second VideoToolbox session or merely a new consumer.
 * Keep that evidence adjacent without blending their clocks or lifetimes.
 */
export function formatHostStreamStatus(status: HostStreamStatus | null): string {
  if (status === null) return "Host fanout: unavailable.";
  const viewers = `${status.viewers} ${status.viewers === 1 ? "viewer" : "viewers"}`;
  const encoders = `${status.upstreamEncoders} upstream ${status.upstreamEncoders === 1 ? "encoder" : "encoders"}`;
  const age = status.lastPacketAgeMs === null ? "last packet unavailable" : `last packet ${status.lastPacketAgeMs} ms ago`;
  return `Host fanout: ${viewers}; ${encoders}; generation ${status.generation}; ${status.restarts} restarts; ${status.slowViewerDrops} slow-viewer drops; ${age}.`;
}
