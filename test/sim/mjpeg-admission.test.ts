import { describe, expect, it, vi } from "vitest";

import {
  MjpegAdmission,
  pullMjpegFrames,
  type MjpegPullReader,
} from "../../app/sim/mjpeg-admission.js";
import { StreamTelemetry } from "../../app/sim/stream-telemetry.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FakePullReader implements MjpegPullReader {
  reads = 0;

  constructor(private readonly chunks: Uint8Array[]) {}

  async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
    this.reads += 1;
    const value = this.chunks.shift();
    return value === undefined ? { done: true, value: undefined } : { done: false, value };
  }
}

describe("MJPEG pull admission", () => {
  it("stops pulling with two decodes occupied and resumes when one settles", async () => {
    const abort = new AbortController();
    const admission = new MjpegAdmission(abort.signal);
    const reader = new FakePullReader([
      new Uint8Array([1]),
      new Uint8Array([2]),
      new Uint8Array([3]),
    ]);
    const decodes = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const depths: number[] = [];
    const telemetry = new StreamTelemetry({
      viewerId: "viewer-1",
      deviceUdid: "device-1",
      hostGeneration: 1,
      codec: "mjpeg",
      route: "proxied",
      qualityProfile: "fallback",
      logicalWidth: 402,
      logicalHeight: 874,
    });

    const pulling = pullMjpegFrames({
      reader,
      admission,
      parse: (chunk) => [...chunk],
      decode: (frame, depth) => {
        started.push(frame);
        depths.push(depth);
        telemetry.packet({
          sequence: frame,
          sourcePtsMs: frame,
          arrivedAtMs: frame,
          bytes: 1,
          decoderQueue: depth,
        });
        return decodes[frame - 1]!.promise;
      },
      dropped: () => {},
    });

    await vi.waitFor(() => expect(started).toEqual([1, 2]));
    await Promise.resolve();
    expect(reader.reads).toBe(2);
    expect(admission.decoderQueuePeak).toBe(2);

    decodes[0]!.resolve();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    expect(reader.reads).toBe(3);
    expect(depths).toEqual([1, 2, 2]);
    expect(telemetry.snapshot()).toMatchObject({ decoderQueuePeak: 2, sequenceGaps: 0 });

    decodes[1]!.resolve();
    await pulling;
    expect(reader.reads).toBe(4);
    decodes[2]!.resolve();
  });

  it("decodes only the newest complete JPEG from one already-read burst", async () => {
    const abort = new AbortController();
    const admission = new MjpegAdmission(abort.signal);
    const decoded: number[] = [];
    const drops: number[] = [];
    const telemetry = new StreamTelemetry({
      viewerId: "viewer-1",
      deviceUdid: "device-1",
      hostGeneration: 1,
      codec: "mjpeg",
      route: "proxied",
      qualityProfile: "fallback",
      logicalWidth: 402,
      logicalHeight: 874,
    });

    await pullMjpegFrames({
      reader: new FakePullReader([new Uint8Array([1, 2, 3])]),
      admission,
      parse: (chunk) => [...chunk],
      decode: async (frame, depth) => {
        decoded.push(frame);
        telemetry.packet({
          sequence: 1,
          sourcePtsMs: 1,
          arrivedAtMs: 1,
          bytes: 1,
          decoderQueue: depth,
        });
      },
      dropped: (count) => {
        drops.push(count);
        telemetry.statelessDrops(count);
      },
    });
    await vi.waitFor(() => expect(decoded).toEqual([3]));

    expect(drops).toEqual([2]);
    expect(admission.decoderQueuePeak).toBe(1);
    expect(telemetry.snapshot()).toMatchObject({ decoderQueuePeak: 1, sequenceGaps: 2 });
  });

  it("resolves every capacity waiter when the stream is aborted", async () => {
    const abort = new AbortController();
    const admission = new MjpegAdmission(abort.signal);
    const first = deferred();
    const second = deferred();
    admission.scheduleNewest([1], () => first.promise, () => {});
    admission.scheduleNewest([2], () => second.promise, () => {});

    const waiters = [admission.waitForRead(), admission.waitForRead(), admission.waitForRead()];
    abort.abort();

    await expect(Promise.all(waiters)).resolves.toEqual([false, false, false]);
    first.resolve();
    second.resolve();
  });

  it("records stateless burst drops without claiming an H.264 resync", () => {
    const telemetry = new StreamTelemetry({
      viewerId: "viewer-1",
      deviceUdid: "device-1",
      hostGeneration: 1,
      codec: "mjpeg",
      route: "proxied",
      qualityProfile: "fallback",
      logicalWidth: 402,
      logicalHeight: 874,
    });

    expect(telemetry.statelessDrops(2, 123)).toMatchObject({
      reason: "gap",
      sample: { sampledAt: 123, sequenceGaps: 2, resyncs: 0 },
    });
  });
});
