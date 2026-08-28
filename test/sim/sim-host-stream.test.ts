/**
 * The raw child owns the one translation boundary we cannot put in the bundle:
 * serve-sim emits v1 records with no timing or continuity evidence, while the
 * panel needs a versioned stream it can validate before touching WebCodecs.
 * These tests import only our raw helper, never serve-sim, so Linux CI exercises
 * the same bytes the Mac child will eventually put on the wire.
 */
import { describe, expect, it } from "vitest";

interface V1Frame {
  type: number;
  data: Uint8Array;
}

interface RawStreamModule {
  MAX_FRAME_BYTES: number;
  V2_HEADER_BYTES: number;
  createV1FrameParser(): {
    push(chunk: Uint8Array): V1Frame[];
    pending(): number;
  };
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
  createMediaEnvelopeEncoder(options?: { nowMicros?: () => bigint }): {
    encode(frame: {
      kind: number;
      payload?: Uint8Array;
      flags?: number;
      codedWidth?: number;
      codedHeight?: number;
      orientation?: number;
      orientationValidated?: boolean;
    }): Uint8Array;
    upstreamRestart(): Uint8Array;
  };
}

const raw = (await import(
  new URL("../../sim-host-stream.mjs", import.meta.url).href
)) as RawStreamModule;

function v1Frame(type: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = type;
  out.set(payload, 5);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function header(record: Uint8Array): DataView {
  return new DataView(record.buffer, record.byteOffset, record.byteLength);
}

describe("the child-side v1 parser", () => {
  it("survives every byte boundary and returns multiple records from one chunk", () => {
    const whole = concat(v1Frame(1, [1, 100, 0, 51]), v1Frame(2, [0, 0, 0, 2, 0x65, 0x88]));
    for (let cut = 1; cut < whole.length; cut += 1) {
      const parser = raw.createV1FrameParser();
      const records = [...parser.push(whole.subarray(0, cut)), ...parser.push(whole.subarray(cut))];
      expect(records.map((record) => record.type), `cut at ${cut}`).toEqual([1, 2]);
      expect([...records[1]!.data], `cut at ${cut}`).toEqual([0, 0, 0, 2, 0x65, 0x88]);
      expect(parser.pending(), `cut at ${cut}`).toBe(0);
    }

    expect(raw.createV1FrameParser().push(whole)).toHaveLength(2);
  });

  it("rejects malformed kinds and lengths before buffering attacker-sized records", () => {
    expect(() => raw.createV1FrameParser().push(v1Frame(9, []))).toThrow(/kind 9/);

    const zero = new Uint8Array(5);
    expect(() => raw.createV1FrameParser().push(zero)).toThrow(/length 0/);

    const huge = new Uint8Array(5);
    new DataView(huge.buffer).setUint32(0, raw.MAX_FRAME_BYTES + 1, false);
    expect(() => raw.createV1FrameParser().push(huge)).toThrow(/not plausible/);
  });
});

describe("the child-side v2 encoder", () => {
  it("writes the byte-exact 28-byte header including an unsigned 64-bit PTS", () => {
    const encoded = raw.encodeV2Record({
      kind: 2,
      flags: 0x1234,
      sequence: 0x1020_3040,
      configGeneration: 0x5060_7080,
      ptsMicros: 0x1122_3344_5566_7788n,
      codedWidth: 1_206,
      codedHeight: 2_622,
      orientation: 3,
      payload: new Uint8Array([0xaa, 0xbb]),
    });
    const view = header(encoded);

    expect(view.getUint32(0, false)).toBe(30);
    expect([...encoded.subarray(4, 32)]).toEqual([
      2, 2, 0x12, 0x34,
      0x10, 0x20, 0x30, 0x40,
      0x50, 0x60, 0x70, 0x80,
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
      0x04, 0xb6, 0x0a, 0x3e,
      3, 0, 0, 0,
    ]);
    expect([...encoded.subarray(32)]).toEqual([0xaa, 0xbb]);
  });

  it("increments only coded sequence and advances generation on real config boundaries", () => {
    const times = [1_000n, 2_000n, 3_000n, 4_000n];
    const encoder = raw.createMediaEnvelopeEncoder({ nowMicros: () => times.shift()! });
    const description1 = encoder.encode({
      kind: 1,
      payload: new Uint8Array([1, 100, 0, 51]),
      codedWidth: 1_206,
      codedHeight: 2_622,
      orientation: 1,
      orientationValidated: false,
    });
    const key = encoder.encode({
      kind: 2,
      payload: new Uint8Array([0x65]),
      codedWidth: 1_206,
      codedHeight: 2_622,
      orientation: 1,
      orientationValidated: true,
    });
    const description2 = encoder.encode({
      kind: 1,
      payload: new Uint8Array([1, 66, 0, 30]),
      codedWidth: 1_206,
      codedHeight: 2_622,
    });
    const delta = encoder.encode({
      kind: 3,
      payload: new Uint8Array([0x41]),
      codedWidth: 2_622,
      codedHeight: 1_206,
    });
    const restart = encoder.upstreamRestart();

    expect(header(description1).getUint32(8, false)).toBe(0);
    expect(header(key).getUint32(8, false)).toBe(1);
    expect(header(description2).getUint32(8, false)).toBe(1);
    expect(header(delta).getUint32(8, false)).toBe(2);
    expect(header(restart).getUint32(8, false)).toBe(2);

    expect(header(description1).getUint32(12, false)).toBe(1);
    expect(header(key).getUint32(12, false)).toBe(1);
    expect(header(description2).getUint32(12, false)).toBe(2);
    expect(header(delta).getUint32(12, false)).toBe(3);
    expect(header(restart).getUint32(12, false)).toBe(4);

    expect(header(description1).getBigUint64(16, false)).toBe(0n);
    expect(header(key).getBigUint64(16, false)).toBe(1_000n);
    expect(header(delta).getBigUint64(16, false)).toBe(2_000n);
    expect(header(restart).getBigUint64(16, false)).toBe(0n);
    expect(description1[28]).toBe(0);
    expect(key[28]).toBe(1);
    expect(restart[5]).toBe(5);
  });

  it("rejects invalid records and anything above the shared 32 MiB ceiling", () => {
    expect(() => raw.encodeV2Record({ kind: 0 })).toThrow(/kind 0/);
    expect(() => raw.encodeV2Record({ kind: 6 })).toThrow(/kind 6/);
    expect(() => raw.encodeV2Record({ kind: 2, ptsMicros: -1n })).toThrow(/ptsMicros/);

    const tooLarge = new Uint8Array(raw.MAX_FRAME_BYTES - raw.V2_HEADER_BYTES + 1);
    expect(() => raw.encodeV2Record({ kind: 2, payload: tooLarge })).toThrow(/not plausible/);
  });
});
