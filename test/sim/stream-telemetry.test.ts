import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StreamTelemetry,
  TELEMETRY_PAINT_CADENCE,
  streamViewerId,
  type PaintEvent,
  type StreamTelemetryConfig,
} from "../../app/sim/stream-telemetry.js";

const CONFIG: StreamTelemetryConfig = {
  viewerId: "viewer-1",
  deviceUdid: "device-1",
  hostGeneration: 7,
  codec: "h264",
  route: "direct",
  qualityProfile: "full",
  logicalWidth: 402,
  logicalHeight: 874,
};

function paint(sequence: number): PaintEvent {
  const sourcePtsMs = sequence * 40;
  return {
    sequence,
    sourcePtsMs,
    arrivedAtMs: sourcePtsMs + 5,
    paintedAtMs: sourcePtsMs + 9,
    paintedAtUnixMs: 1_000_000 + sourcePtsMs + 9,
    bytes: 1_024,
    decoderQueue: 2,
    codedWidth: 1_206,
    codedHeight: 2_622,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("renderer stream evidence", () => {
  it("gives two mounted pipelines in one tab distinct identities", () => {
    let stored: string | null = null;
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => { stored = value; },
      },
    });
    vi.stubGlobal("crypto", { randomUUID: () => ids.shift()! });

    const navViewer = streamViewerId();
    const threadViewer = streamViewerId();

    expect(navViewer).toBe("11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222");
    expect(threadViewer).toBe("11111111-1111-4111-8111-111111111111:33333333-3333-4333-8333-333333333333");
    expect(navViewer).not.toBe(threadViewer);
  });

  it("publishes configuration immediately and then one replacement every thirty paints", () => {
    const telemetry = new StreamTelemetry(CONFIG);

    const configured = telemetry.configure(900_000);
    expect(configured.reason).toBe("config");
    expect(configured.sample).toMatchObject({
      viewerId: "viewer-1",
      deviceUdid: "device-1",
      hostGeneration: 7,
      sampledAt: 900_000,
      state: "configuring",
      paintedFrames: 0,
    });

    for (let sequence = 1; sequence < TELEMETRY_PAINT_CADENCE; sequence += 1) {
      expect(telemetry.paint(paint(sequence)).reason).toBeNull();
    }
    const cadence = telemetry.paint(paint(TELEMETRY_PAINT_CADENCE));
    expect(cadence.reason).toBe("cadence");
    expect(cadence.sample).toMatchObject({
      hostGeneration: 7,
      state: "live",
      paintedFrames: 30,
      codedWidth: 1_206,
      codedHeight: 2_622,
    });
  });

  it("publishes gaps, resyncs, failures, and closure on the event that observes them", () => {
    vi.useFakeTimers();
    const telemetry = new StreamTelemetry(CONFIG);

    expect(
      telemetry.packet({
        sequence: 1,
        sourcePtsMs: 40,
        arrivedAtMs: 45,
        bytes: 200,
        decoderQueue: 1,
      }).reason,
    ).toBeNull();
    const gap = telemetry.packet({
      sequence: 3,
      sourcePtsMs: 120,
      arrivedAtMs: 126,
      bytes: 200,
      decoderQueue: 3,
    });
    expect(gap.reason).toBe("gap");
    expect(gap.continuity).toBe("sequence-gap");
    expect(gap.sample.sequenceGaps).toBe(1);

    const discontinuity = telemetry.packet({
      sequence: 2,
      sourcePtsMs: 80,
      arrivedAtMs: 130,
      bytes: 200,
      decoderQueue: 2,
    });
    expect(discontinuity.reason).toBe("gap");
    expect(discontinuity.continuity).toBe("discontinuity");
    expect(discontinuity.sample.discontinuities).toBe(2);

    expect(telemetry.resync("drop", 1_001)).toMatchObject({
      reason: "resync",
      resyncCause: "drop",
      sample: { resyncs: 1 },
    });
    expect(telemetry.resync("decoder-error", 1_002)).toMatchObject({
      reason: "resync",
      resyncCause: "decoder-error",
      sample: { resyncs: 2 },
    });
    expect(telemetry.failure(1_003)).toMatchObject({
      reason: "failure",
      sample: { state: "failed", sampledAt: 1_003 },
    });
    expect(telemetry.close(1_004)).toMatchObject({
      reason: "close",
      sample: { state: "closed", sampledAt: 1_004 },
    });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("measures only latency above the viewer's best observed clock offset", () => {
    const telemetry = new StreamTelemetry(CONFIG);

    telemetry.packet({
      sequence: 1,
      sourcePtsMs: 40,
      arrivedAtMs: 10_040,
      bytes: 200,
      decoderQueue: 1,
    });
    const sample = telemetry.paint({
      ...paint(1),
      arrivedAtMs: 10_040,
      paintedAtMs: 10_047,
    }).sample;

    expect(sample.excessLatencyMs).toBe(7);
  });
});
