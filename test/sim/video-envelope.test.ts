/**
 * A golden contract between the raw child and the bundled browser parser.
 * Neither side imports the other, because doing so would pull the native
 * capture dependency into `dist/server.js`; agreeing on literal wire bytes is
 * the compatibility check that keeps that architectural boundary honest.
 */
import { describe, expect, it } from "vitest";
import {
  createVideoEnvelopeParser,
  MEDIA_ENVELOPE_V2_CONTENT_TYPE,
  videoPacketEvidence,
  VideoEnvelopeParseError,
} from "../../app/sim/video-envelope.js";
import { StreamTelemetry } from "../../app/sim/stream-telemetry.js";

interface RawStreamModule {
  MAX_FRAME_BYTES: number;
  encodeV2Record(record: {
    kind: number;
    flags?: number;
    sequence?: number;
    configGeneration?: number;
    ptsMicros?: bigint;
    codedWidth?: number;
    codedHeight?: number;
    orientation?: number;
    payload?: Uint8Array;
  }): Uint8Array;
}

const raw = (await import(
  new URL("../../sim-host-stream.mjs", import.meta.url).href
)) as RawStreamModule;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function v1Frame(type: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = type;
  out.set(payload, 5);
  return out;
}

describe("the v2 media envelope", () => {
  const records = [
    raw.encodeV2Record({ kind: 4, configGeneration: 1, ptsMicros: 99n, payload: new Uint8Array([0xff, 0xd8]) }),
    raw.encodeV2Record({ kind: 1, configGeneration: 1, codedWidth: 1_206, codedHeight: 2_622, payload: new Uint8Array([1, 100, 0, 51]) }),
    raw.encodeV2Record({ kind: 2, sequence: 1, configGeneration: 1, ptsMicros: 0x1122_3344_5566_7788n, codedWidth: 1_206, codedHeight: 2_622, orientation: 1, payload: new Uint8Array([0x65]) }),
    raw.encodeV2Record({ kind: 3, sequence: 2, configGeneration: 2, ptsMicros: 123_456n, codedWidth: 2_622, codedHeight: 1_206, orientation: 3, payload: new Uint8Array([0x41]) }),
    raw.encodeV2Record({ kind: 5, sequence: 2, configGeneration: 3 }),
  ];
  const wire = concat(...records);

  it("parses the raw encoder's golden records across every possible split", () => {
    for (let cut = 1; cut < wire.length; cut += 1) {
      const parser = createVideoEnvelopeParser(MEDIA_ENVELOPE_V2_CONTENT_TYPE);
      const parsed = [...parser.push(wire.subarray(0, cut)), ...parser.push(wire.subarray(cut))];
      expect(parsed.map((record) => record.kind), `cut at ${cut}`).toEqual([4, 1, 2, 3, 5]);
      expect(parser.pending(), `cut at ${cut}`).toBe(0);
    }
  });

  it("returns multiple records per chunk without losing u64 PTS, generation, or geometry", () => {
    const parsed = createVideoEnvelopeParser("Application/Vnd.Bb.Sim-Avcc; version=2").push(wire);

    expect(parsed).toHaveLength(5);
    expect(parsed[2]).toMatchObject({
      version: 2,
      kind: 2,
      flags: 0,
      sequence: 1,
      configGeneration: 1,
      ptsMicros: 0x1122_3344_5566_7788n,
      codedWidth: 1_206,
      codedHeight: 2_622,
      orientation: 1,
    });
    expect([...parsed[2]!.data]).toEqual([0x65]);
    expect(parsed[3]).toMatchObject({
      kind: 3,
      sequence: 2,
      configGeneration: 2,
      ptsMicros: 123_456n,
      codedWidth: 2_622,
      codedHeight: 1_206,
      orientation: 3,
    });
    expect(parsed[4]).toMatchObject({ kind: 5, sequence: 2, configGeneration: 3, ptsMicros: 0n });
  });

  it("makes v2 sequence, PTS, generation, and geometry the decoder/telemetry evidence", () => {
    const parsed = createVideoEnvelopeParser(MEDIA_ENVELOPE_V2_CONTENT_TYPE).push(
      concat(
        raw.encodeV2Record({
          kind: 2,
          sequence: 1,
          configGeneration: 1,
          ptsMicros: 100_000n,
          codedWidth: 1_206,
          codedHeight: 2_622,
        }),
        raw.encodeV2Record({
          kind: 3,
          sequence: 2,
          configGeneration: 2,
          ptsMicros: 133_333n,
          codedWidth: 2_622,
          codedHeight: 1_206,
        }),
      ),
    );
    const key = videoPacketEvidence(parsed[0]!, { sequence: 99, timestampMicros: 9_999_999 });
    const delta = videoPacketEvidence(parsed[1]!, { sequence: 100, timestampMicros: 10_000_000 });
    const telemetry = new StreamTelemetry({
      viewerId: "viewer-1",
      deviceUdid: "device-1",
      hostGeneration: 1,
      codec: "h264",
      route: "direct",
      qualityProfile: "full",
      logicalWidth: 402,
      logicalHeight: 874,
    });

    expect(key).toEqual({
      sequence: 1,
      timestampMicros: 100_000,
      sourcePtsMs: 100,
      configGeneration: 1,
      codedWidth: 1_206,
      codedHeight: 2_622,
    });
    const first = telemetry.packet({
      ...key,
      arrivedAtMs: key.sourcePtsMs + 5,
      bytes: 10,
      decoderQueue: 1,
    });
    expect(first).toMatchObject({ sample: { codedWidth: 1_206, codedHeight: 2_622 } });
    expect(first.continuity).toBeUndefined();
    expect(
      telemetry.packet({ ...delta, arrivedAtMs: delta.sourcePtsMs + 5, bytes: 10, decoderQueue: 1 }),
    ).toMatchObject({
      continuity: "discontinuity",
      sample: { discontinuities: 1, codedWidth: 2_622, codedHeight: 1_206 },
    });
    expect(telemetry.discontinuity()).toMatchObject({
      reason: "gap",
      continuity: "discontinuity",
      sample: { discontinuities: 2 },
    });
  });

  it("rejects invalid version, kind, short length, and the 32 MiB overflow before buffering", () => {
    const invalidVersion = records[0]!.slice();
    invalidVersion[4] = 1;
    expect(() => createVideoEnvelopeParser(MEDIA_ENVELOPE_V2_CONTENT_TYPE).push(invalidVersion)).toThrow(/version 1/);

    const invalidKind = records[0]!.slice();
    invalidKind[5] = 9;
    expect(() => createVideoEnvelopeParser(MEDIA_ENVELOPE_V2_CONTENT_TYPE).push(invalidKind)).toThrow(/kind 9/);

    const short = new Uint8Array(32);
    new DataView(short.buffer).setUint32(0, 27, false);
    short[4] = 2;
    short[5] = 1;
    expect(() => createVideoEnvelopeParser(MEDIA_ENVELOPE_V2_CONTENT_TYPE).push(short)).toThrow(/length 27/);

    const huge = new Uint8Array(32);
    new DataView(huge.buffer).setUint32(0, raw.MAX_FRAME_BYTES + 1, false);
    huge[4] = 2;
    huge[5] = 2;
    expect(() => createVideoEnvelopeParser(MEDIA_ENVELOPE_V2_CONTENT_TYPE).push(huge)).toThrow(/not plausible/);
  });
});

describe("media type compatibility", () => {
  it("keeps the installed host's v1 application/octet-stream readable", () => {
    const parser = createVideoEnvelopeParser("application/octet-stream; charset=binary");
    const parsed = parser.push(concat(v1Frame(4, [0xff, 0xd8]), v1Frame(1, [1, 100, 0, 51]), v1Frame(2, [0x65])));

    expect(parsed.map((record) => record.kind)).toEqual([4, 1, 2]);
    expect(parsed[2]).toMatchObject({
      version: 1,
      sequence: null,
      configGeneration: null,
      ptsMicros: null,
      codedWidth: null,
      codedHeight: null,
      orientation: null,
    });
    expect([...parsed[2]!.data]).toEqual([0x65]);
    expect(videoPacketEvidence(parsed[2]!, { sequence: 7, timestampMicros: 233_331 })).toEqual({
      sequence: 7,
      timestampMicros: 233_331,
      sourcePtsMs: 233.331,
    });
  });

  it("refuses to guess a framing protocol from an unknown media type", () => {
    expect(() => createVideoEnvelopeParser("video/h264")).toThrow(VideoEnvelopeParseError);
    expect(() => createVideoEnvelopeParser("application/vnd.bb.sim-avcc;version=3")).toThrow(/content type/);
  });
});
