import { afterEach, describe, expect, it, vi } from "vitest";

import type { LiveStreamSample } from "../../src/sim/contract.js";
import type { Ctx } from "../../src/sim/context.js";
import {
  LIVE_STREAM_STATS_FRESH_MS,
  LIVE_STREAM_STATS_TTL_MS,
  LiveStreamStatsStore,
} from "../../src/sim/live-stream-stats.js";
import { makeCaptureTool } from "../../src/sim/tools.js";

function sample(overrides: Partial<LiveStreamSample> = {}): LiveStreamSample {
  return {
    viewerId: "viewer-1",
    deviceUdid: "device-1",
    hostGeneration: 7,
    sampledAt: -9_999_999,
    state: "live",
    codec: "h264",
    route: "direct",
    qualityProfile: "full",
    codedWidth: 1_206,
    codedHeight: 2_622,
    logicalWidth: 402,
    logicalHeight: 874,
    sourceFps: 25,
    paintFps: 24,
    bytesPerSecond: 200_000,
    decoderQueuePeak: 2,
    sequenceGaps: 0,
    discontinuities: 0,
    resyncs: 0,
    reconnects: 0,
    repeatedSurfaces: 0,
    lastPaintAt: 123,
    excessLatencyMs: 8,
    packets: 30,
    paintedFrames: 30,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("server stream evidence", () => {
  it("uses server receive time for live, stale, and unavailable freshness", () => {
    let now = 1_000_000;
    const store = new LiveStreamStatsStore(() => now);

    expect(store.write(sample()).status).toBe("live");
    expect(store.read().viewers[0]).toMatchObject({
      sampledAt: -9_999_999,
      receivedAt: 1_000_000,
      ageMs: 0,
      freshness: "fresh",
    });

    now += LIVE_STREAM_STATS_FRESH_MS + 1;
    expect(store.read()).toMatchObject({
      status: "stale",
      freshViewerCount: 0,
      staleViewerCount: 1,
    });

    now = 1_000_000 + LIVE_STREAM_STATS_TTL_MS + 1;
    expect(store.read()).toMatchObject({
      status: "unavailable",
      viewerCount: 0,
      viewers: [],
    });
  });

  it("filters replaced samples to the requested host generation", () => {
    const store = new LiveStreamStatsStore(() => 50_000);
    store.write(sample({ viewerId: "old", hostGeneration: 6 }));
    store.write(sample({ viewerId: "current", hostGeneration: 7 }));

    const health = store.read({ deviceUdid: "device-1", hostGeneration: 7 });
    expect(health).toMatchObject({
      status: "live",
      deviceUdid: "device-1",
      hostGeneration: 7,
      viewerCount: 1,
    });
    expect(health.viewers.map((viewer) => viewer.viewerId)).toEqual(["current"]);
  });

  it("aggregates fresh and stale viewers without inventing unmeasured latency", () => {
    let now = 100_000;
    const store = new LiveStreamStatsStore(() => now);
    store.write(sample({ viewerId: "stale", paintFps: 20, excessLatencyMs: null }));
    now += LIVE_STREAM_STATS_FRESH_MS + 1;
    store.write(sample({ viewerId: "fresh", paintFps: 30, excessLatencyMs: null }));

    expect(store.read()).toMatchObject({
      status: "live",
      viewerCount: 2,
      freshViewerCount: 1,
      staleViewerCount: 1,
      paintFps: 25,
      excessLatencyMs: null,
    });
  });

  it("evicts the least recently received replacement when the forty-ninth viewer arrives", () => {
    let now = 100_000;
    const store = new LiveStreamStatsStore(() => now);
    for (let index = 0; index < 48; index += 1) {
      store.write(sample({ viewerId: `viewer-${index}` }));
      now += 1;
    }
    store.write(sample({ viewerId: "viewer-0", paintedFrames: 60 }));
    now += 1;
    store.write(sample({ viewerId: "viewer-48" }));

    const health = store.read();
    expect(health.viewerCount).toBe(48);
    expect(health.viewers.map((viewer) => viewer.viewerId)).not.toContain("viewer-1");
    expect(health.viewers.find((viewer) => viewer.viewerId === "viewer-0")?.paintedFrames).toBe(60);
    expect(health.viewers.map((viewer) => viewer.viewerId)).toContain("viewer-48");
  });

  it("prunes only on reads and writes and owns no background timer", () => {
    vi.useFakeTimers();
    const store = new LiveStreamStatsStore(() => Date.now());
    store.write(sample());

    vi.advanceTimersByTime(LIVE_STREAM_STATS_TTL_MS + 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.read().status).toBe("unavailable");
  });
});

describe("capture evidence correlation", () => {
  it("adds viewer health only to text and preserves the capture image bytes", async () => {
    const streamStats = new LiveStreamStatsStore(() => 100_000);
    streamStats.write(sample({ paintFps: 30, excessLatencyMs: 12 }));
    const release = vi.fn();
    const ctx = {
      settings: () => ({ allowAgentCapture: true }),
      live: {
        state: () => ({ device: { udid: "device-1" }, generation: 7 }),
      },
      leases: { acquire: () => ({ ok: true, release }) },
    } as unknown as Ctx;
    const captureResult = Object.freeze({
      lookId: "look-1",
      frameId: "frame-1",
      identity: "capture",
      relPath: "capture.jpg",
      width: 1_206,
      height: 2_622,
      bytes: 4,
      foregroundBundleId: "com.example.App",
      summary: "com.example.App is in the foreground on iPhone.",
    });
    const jpeg = { data: "/9j/2Q==", mimeType: "image/jpeg", bytes: 4 };
    const capture = vi.fn(async () => captureResult);
    const encode = vi.fn(async () => jpeg);
    const tool = makeCaptureTool(ctx, streamStats, {
      capture: capture as never,
      encode: encode as never,
    });

    const result = await tool.execute({}, { threadId: "thread-1" });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "com.example.App is in the foreground on iPhone. Stream health (live): H.264/direct/full; 30 paint fps; 12 ms excess viewer backlog; 0 gaps; 0 resyncs.",
      },
      { type: "image", data: "/9j/2Q==", mimeType: "image/jpeg" },
    ]);
    expect(captureResult).toMatchObject({ frameId: "frame-1", relPath: "capture.jpg", bytes: 4 });
    expect(encode).toHaveBeenCalledWith(ctx, "frame-1");
    expect(release).toHaveBeenCalledOnce();
  });
});
