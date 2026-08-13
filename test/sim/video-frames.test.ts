/**
 * The frame parser, against the boundaries the network actually produces.
 *
 * Split a frame across two reads and a naive parser reports a codec failure,
 * which is the one bug class that would send someone looking at VideoToolbox
 * instead of at a `slice`. So the interesting tests here are all about where
 * the chunk edges fall.
 */
import { describe, expect, it } from "vitest";
import {
  codecStringFrom,
  createFrameParser,
  FrameParseError,
  FRAME_DELTA,
  FRAME_DESCRIPTION,
  FRAME_JPEG,
  FRAME_KEY,
  MAX_FRAME_BYTES,
} from "../../app/sim/video-frames.js";

/** `[4-byte BE length][type][payload]`, where length counts the type byte. */
function frame(type: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = type;
  out.set(payload, 5);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe("the frame parser", () => {
  it("reads the real opening sequence: jpeg, description, keyframe, deltas", () => {
    // The order the capture host actually sends, from a captured sample.
    const parser = createFrameParser();
    const frames = parser.push(
      concat(
        frame(FRAME_JPEG, [0xff, 0xd8, 0xff, 0xe0]),
        frame(FRAME_DESCRIPTION, [0x01, 0x64, 0x00, 0x33]),
        frame(FRAME_KEY, [0x00, 0x00, 0x66, 0x88]),
        frame(FRAME_DELTA, [0x21, 0xe0]),
      ),
    );
    expect(frames.map((f) => f.type)).toEqual([
      FRAME_JPEG,
      FRAME_DESCRIPTION,
      FRAME_KEY,
      FRAME_DELTA,
    ]);
    expect([...frames[0]!.data]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(parser.pending()).toBe(0);
  });

  it("survives a frame split at every single byte", () => {
    // Not a representative split — every one of them. A 250KB JPEG arriving in
    // 64KB reads is split four times, and the boundary lands wherever it lands.
    const whole = concat(frame(FRAME_KEY, [1, 2, 3, 4, 5, 6]), frame(FRAME_DELTA, [7, 8]));
    for (let cut = 1; cut < whole.length; cut++) {
      const parser = createFrameParser();
      const first = parser.push(whole.subarray(0, cut));
      const second = parser.push(whole.subarray(cut));
      const all = [...first, ...second];
      expect(all.map((f) => f.type), `cut at ${cut}`).toEqual([FRAME_KEY, FRAME_DELTA]);
      expect([...all[0]!.data], `cut at ${cut}`).toEqual([1, 2, 3, 4, 5, 6]);
      expect([...all[1]!.data], `cut at ${cut}`).toEqual([7, 8]);
      expect(parser.pending(), `cut at ${cut}`).toBe(0);
    }
  });

  it("holds a partial header without inventing a frame", () => {
    const parser = createFrameParser();
    // Four bytes is a complete length and still not a complete header.
    expect(parser.push(new Uint8Array([0, 0, 0, 3]))).toEqual([]);
    expect(parser.pending()).toBe(4);
    expect(parser.push(new Uint8Array([FRAME_DELTA, 9]))).toEqual([]);
    const done = parser.push(new Uint8Array([10]));
    expect(done).toHaveLength(1);
    expect([...done[0]!.data]).toEqual([9, 10]);
  });

  it("keeps handed-out frames intact across later pushes", () => {
    // The retained tail used to be a subarray of the shared buffer, which
    // pinned — and could be overwritten by — every frame already returned.
    const parser = createFrameParser();
    const [first] = parser.push(concat(frame(FRAME_KEY, [1, 2, 3]), new Uint8Array([0, 0])));
    const before = [...first!.data];
    parser.push(new Uint8Array([0, 4, FRAME_DELTA, 5, 6, 7]));
    expect([...first!.data]).toEqual(before);
  });

  it("refuses a length no real frame can have", () => {
    const parser = createFrameParser();
    const absurd = new Uint8Array(5);
    new DataView(absurd.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    expect(() => parser.push(absurd)).toThrow(FrameParseError);

    // Zero would mean a frame with no type byte, which cannot happen and would
    // otherwise loop forever at the same offset.
    const zero = new Uint8Array(5);
    expect(() => createFrameParser().push(zero)).toThrow(FrameParseError);
  });

  it("accepts an empty payload, which is a frame with only a type", () => {
    const parser = createFrameParser();
    const frames = parser.push(frame(FRAME_DELTA, []));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toHaveLength(0);
  });
});

describe("the codec string", () => {
  it("reads High 5.1 out of the avcC record the host sends", () => {
    expect(codecStringFrom(new Uint8Array([0x01, 0x64, 0x00, 0x33]))).toBe("avc1.640033");
    // Baseline 3.0, to prove the digits are not hard-coded.
    expect(codecStringFrom(new Uint8Array([0x01, 0x42, 0xc0, 0x1e]))).toBe("avc1.42c01e");
  });

  it("refuses anything that is not an avcC record", () => {
    // Getting this wrong does not degrade — `configure` rejects and nothing
    // renders — so it is better to fall back to MJPEG than to guess.
    expect(codecStringFrom(new Uint8Array([0x02, 0x64, 0x00, 0x33]))).toBeNull();
    expect(codecStringFrom(new Uint8Array([0x01, 0x64]))).toBeNull();
    expect(codecStringFrom(new Uint8Array())).toBeNull();
  });
});
