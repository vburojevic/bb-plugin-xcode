/**
 * Stream telemetry, kept on the same event path as the pixels it describes.
 *
 * A timer-based monitor can only say that time passed. It cannot say whether a
 * packet arrived, a decoder queue grew, or a frame actually reached the
 * canvas, and it keeps waking after the stream has gone away. This accumulator
 * therefore has no scheduled work: packet and paint events advance bounded
 * windows, and the caller sends only cadence samples or exceptional events.
 *
 * `excessLatencyMs` is deliberately not called latency. Source PTS and the
 * browser clock do not share an epoch, so their absolute difference is
 * meaningless. The best arrival-minus-PTS offset observed by this viewer is
 * the baseline; paint-minus-PTS above that floor is measurable queue/decode/
 * presentation delay, even when the two clocks started years apart. AVCC v1
 * carries no source timestamps, so its `sourceFps` is synthetic cadence until
 * the transport can supply them; neither field is end-to-end latency evidence.
 */
import type { LiveStreamSample } from "../../src/sim/contract.js";
import type { StreamCodec, StreamRoute } from "./stream-sources";

export const TELEMETRY_PAINT_CADENCE = 30;
const RATE_WINDOW = 60;
const VIEWER_KEY = "xcode-simulators.stream-viewer-id";

export type TelemetryReason = "config" | "gap" | "resync" | "failure" | "close" | "cadence";
export type StreamContinuity = "sequence-gap" | "discontinuity";
export type StreamResyncCause =
  | "drop"
  | "sequence-gap"
  | "discontinuity"
  | "decoder-error"
  | "configuration-change";

export interface TelemetryUpdate {
  sample: LiveStreamSample;
  /** `null` means update the local HUD but do not cross the RPC boundary. */
  reason: TelemetryReason | null;
  /** Present only on the packet that proves encoded continuity was lost. */
  continuity?: StreamContinuity;
  /** Keeps the recovery cause on the pixel event path even before the wire grows it. */
  resyncCause?: StreamResyncCause;
}

export interface StreamTelemetryConfig {
  viewerId: string;
  deviceUdid: string;
  hostGeneration: number;
  codec: StreamCodec;
  route: StreamRoute;
  qualityProfile: string;
  logicalWidth: number | null;
  logicalHeight: number | null;
  reconnects?: number;
}

export interface PacketEvent {
  sequence: number;
  /** Source presentation timestamp on any monotonic clock, in milliseconds. */
  sourcePtsMs: number;
  arrivedAtMs: number;
  bytes: number;
  decoderQueue: number;
}

export interface PaintEvent extends PacketEvent {
  paintedAtMs: number;
  /** Wall time is reported for agents; it never participates in latency math. */
  paintedAtUnixMs: number;
  codedWidth: number;
  codedHeight: number;
  /** A cheap encoded-frame fingerprint where the renderer has one. */
  surfaceId?: string;
}

interface RatePoint {
  at: number;
  total: number;
}

function pushBounded<T>(values: T[], value: T): void {
  values.push(value);
  if (values.length > RATE_WINDOW) values.shift();
}

function rate(points: readonly number[]): number | null {
  if (points.length < 2) return null;
  const span = points[points.length - 1]! - points[0]!;
  return span > 0 ? ((points.length - 1) * 1000) / span : null;
}

function rounded(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

/** One fixed-size accumulator for one fetch/decode/paint pipeline. */
export class StreamTelemetry {
  private readonly sourcePts: number[] = [];
  private readonly paintTimes: number[] = [];
  private readonly bytePoints: RatePoint[] = [];
  private totalBytes = 0;
  private paints = 0;
  private packets = 0;
  private decoderQueuePeak = 0;
  private sequenceGaps = 0;
  private discontinuities = 0;
  private resyncs = 0;
  private repeatedSurfaces = 0;
  private previousSequence: number | null = null;
  private previousPts: number | null = null;
  private previousSurface: string | null = null;
  private bestArrivalOffset: number | null = null;
  private codedWidth: number | null = null;
  private codedHeight: number | null = null;
  private lastPaintAt: number | null = null;
  private excessLatencyMs: number | null = null;
  private state: LiveStreamSample["state"] = "configuring";

  constructor(private readonly config: StreamTelemetryConfig) {}

  configure(sampledAt = Date.now()): TelemetryUpdate {
    return { sample: this.snapshot(sampledAt), reason: "config" };
  }

  packet(event: PacketEvent, sampledAt = Date.now()): TelemetryUpdate {
    this.packets += 1;
    this.totalBytes += Math.max(0, event.bytes);
    pushBounded(this.sourcePts, event.sourcePtsMs);
    pushBounded(this.bytePoints, { at: event.arrivedAtMs, total: this.totalBytes });
    this.decoderQueuePeak = Math.max(this.decoderQueuePeak, Math.max(0, event.decoderQueue));

    let continuity: StreamContinuity | null = null;
    if (this.previousSequence !== null) {
      if (event.sequence > this.previousSequence + 1) {
        this.sequenceGaps += event.sequence - this.previousSequence - 1;
        continuity = "sequence-gap";
      } else if (event.sequence <= this.previousSequence) {
        this.discontinuities += 1;
        continuity = "discontinuity";
      }
    }
    if (this.previousPts !== null && event.sourcePtsMs < this.previousPts) {
      this.discontinuities += 1;
      continuity = "discontinuity";
    }
    this.previousSequence = event.sequence;
    this.previousPts = event.sourcePtsMs;

    const offset = event.arrivedAtMs - event.sourcePtsMs;
    this.bestArrivalOffset =
      this.bestArrivalOffset === null ? offset : Math.min(this.bestArrivalOffset, offset);
    return {
      sample: this.snapshot(sampledAt),
      reason: continuity === null ? null : "gap",
      ...(continuity === null ? {} : { continuity }),
    };
  }

  paint(event: PaintEvent, sampledAt = event.paintedAtUnixMs): TelemetryUpdate {
    this.paints += 1;
    this.state = "live";
    this.codedWidth = event.codedWidth;
    this.codedHeight = event.codedHeight;
    this.lastPaintAt = event.paintedAtUnixMs;
    pushBounded(this.paintTimes, event.paintedAtMs);

    const offset = event.arrivedAtMs - event.sourcePtsMs;
    this.bestArrivalOffset =
      this.bestArrivalOffset === null ? offset : Math.min(this.bestArrivalOffset, offset);
    this.excessLatencyMs = Math.max(
      0,
      event.paintedAtMs - event.sourcePtsMs - this.bestArrivalOffset,
    );

    if (event.surfaceId !== undefined) {
      if (event.surfaceId === this.previousSurface) this.repeatedSurfaces += 1;
      this.previousSurface = event.surfaceId;
    }

    return {
      sample: this.snapshot(sampledAt),
      reason: this.paints % TELEMETRY_PAINT_CADENCE === 0 ? "cadence" : null,
    };
  }

  resync(cause: StreamResyncCause, sampledAt = Date.now()): TelemetryUpdate {
    this.resyncs += 1;
    return { sample: this.snapshot(sampledAt), reason: "resync", resyncCause: cause };
  }

  failure(sampledAt = Date.now()): TelemetryUpdate {
    this.state = "failed";
    return { sample: this.snapshot(sampledAt), reason: "failure" };
  }

  close(sampledAt = Date.now()): TelemetryUpdate {
    this.state = "closed";
    return { sample: this.snapshot(sampledAt), reason: "close" };
  }

  snapshot(sampledAt = Date.now()): LiveStreamSample {
    const firstByte = this.bytePoints[0];
    const lastByte = this.bytePoints[this.bytePoints.length - 1];
    const bytesPerSecond =
      firstByte !== undefined && lastByte !== undefined && lastByte.at > firstByte.at
        ? ((lastByte.total - firstByte.total) * 1000) / (lastByte.at - firstByte.at)
        : null;
    return {
      viewerId: this.config.viewerId,
      deviceUdid: this.config.deviceUdid,
      hostGeneration: this.config.hostGeneration,
      sampledAt,
      state: this.state,
      codec: this.config.codec,
      route: this.config.route,
      qualityProfile: this.config.qualityProfile,
      codedWidth: this.codedWidth,
      codedHeight: this.codedHeight,
      logicalWidth: this.config.logicalWidth,
      logicalHeight: this.config.logicalHeight,
      sourceFps: rounded(rate(this.sourcePts)),
      paintFps: rounded(rate(this.paintTimes)),
      bytesPerSecond: rounded(bytesPerSecond),
      decoderQueuePeak: this.decoderQueuePeak,
      sequenceGaps: this.sequenceGaps,
      discontinuities: this.discontinuities,
      resyncs: this.resyncs,
      reconnects: this.config.reconnects ?? 0,
      repeatedSurfaces: this.repeatedSurfaces,
      lastPaintAt: this.lastPaintAt,
      excessLatencyMs: rounded(this.excessLatencyMs),
      packets: this.packets,
      paintedFrames: this.paints,
    };
  }
}

/** One id per browser renderer/tab; split panels in that renderer share it. */
export function streamViewerId(): string {
  if (typeof window === "undefined") return "viewer-server";
  try {
    const existing = window.sessionStorage.getItem(VIEWER_KEY);
    if (existing !== null && existing !== "") return existing;
  } catch {
    // Embedded browsers may deny storage. The in-memory fallback still keeps
    // samples distinct for the life of this renderer.
  }
  const id = globalThis.crypto?.randomUUID?.() ?? `viewer-${Math.random().toString(36).slice(2)}`;
  try {
    window.sessionStorage.setItem(VIEWER_KEY, id);
  } catch {
    // Best effort only.
  }
  return id;
}

/** A bounded fingerprint: enough to count repeated MJPEG surfaces, never a hash job. */
export function frameFingerprint(bytes: Uint8Array): string {
  let hash = 2_166_136_261;
  const stride = Math.max(1, Math.floor(bytes.length / 64));
  for (let index = 0; index < bytes.length; index += stride) {
    hash ^= bytes[index]!;
    hash = Math.imul(hash, 16_777_619);
  }
  return `${bytes.length}:${(hash >>> 0).toString(16)}`;
}

export function streamHudText(sample: LiveStreamSample | null): string | null {
  if (sample === null) return null;
  const bits = [sample.qualityProfile];
  if (sample.paintFps !== null) bits.push(`${Math.round(sample.paintFps)} paint fps`);
  if (sample.excessLatencyMs !== null) {
    bits.push(`${Math.round(sample.excessLatencyMs)} ms excess`);
  }
  if (sample.sequenceGaps > 0) {
    bits.push(`${sample.sequenceGaps} ${sample.sequenceGaps === 1 ? "gap" : "gaps"}`);
  }
  if (sample.resyncs > 0) {
    bits.push(`${sample.resyncs} ${sample.resyncs === 1 ? "resync" : "resyncs"}`);
  }
  return bits.join(" · ");
}
