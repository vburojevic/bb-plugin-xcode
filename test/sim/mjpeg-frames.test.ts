/**
 * The multipart parser, fed the ways a network actually delivers.
 *
 * Everything the panel's MJPEG path depends on: parts split across chunks,
 * several parts in one chunk, a preamble that is not a part, and a length
 * that cannot be real. A mistake here looks like a dead device, which is why
 * the parser is pure and this file needs no browser and no simulator.
 */
import { describe, expect, it } from "vitest";
import { createMjpegParser, MjpegParseError } from "../../app/sim/mjpeg-frames.js";

const JPEG_A = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);
const JPEG_B = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 9, 8, 7, 0xff, 0xd9]);

function part(jpeg: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
  );
  const out = new Uint8Array(header.length + jpeg.length + 2);
  out.set(header, 0);
  out.set(jpeg, header.length);
  out.set([13, 10], header.length + jpeg.length);
  return out;
}

function concat(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

describe("the MJPEG parser", () => {
  it("reads one part from one chunk", () => {
    const parser = createMjpegParser();
    const parts = parser.push(part(JPEG_A));
    expect(parts).toHaveLength(1);
    expect([...parts[0]!.jpeg]).toEqual([...JPEG_A]);
    // Only the trailing CRLF — the first two bytes of the next boundary — is
    // held back waiting for the rest of that header.
    expect(parser.pending()).toBe(2);
  });

  it("reads a part split across chunks, header and body both", () => {
    const parser = createMjpegParser();
    const whole = part(JPEG_A);
    // Byte-at-a-time is the worst case the network is allowed to produce.
    const parts = [];
    for (const byte of whole) {
      parts.push(...parser.push(new Uint8Array([byte])));
    }
    expect(parts).toHaveLength(1);
    expect([...parts[0]!.jpeg]).toEqual([...JPEG_A]);
  });

  it("reads several parts from one chunk", () => {
    const parser = createMjpegParser();
    const parts = parser.push(concat(part(JPEG_A), part(JPEG_B), part(JPEG_A)));
    expect(parts).toHaveLength(3);
    expect([...parts[1]!.jpeg]).toEqual([...JPEG_B]);
  });

  it("holds a partial body back without losing it", () => {
    const parser = createMjpegParser();
    const whole = part(JPEG_B);
    const head = whole.slice(0, whole.length - 3);
    expect(parser.push(head)).toHaveLength(0);
    expect(parser.pending()).toBeGreaterThan(0);
    const parts = parser.push(whole.slice(whole.length - 3));
    expect(parts).toHaveLength(1);
    expect([...parts[0]!.jpeg]).toEqual([...JPEG_B]);
  });

  it("skips a preamble that is not a part", () => {
    const parser = createMjpegParser();
    // Whatever a proxy or a restart left on the front of the stream: not a
    // Content-Length in sight, so it is resync territory, not a part.
    const junk = new TextEncoder().encode("garbage from a proxy\r\n\r\n");
    const parts = parser.push(concat(junk, part(JPEG_A)));
    expect(parts).toHaveLength(1);
    expect([...parts[0]!.jpeg]).toEqual([...JPEG_A]);
  });

  it("refuses a length no real frame can have", () => {
    const parser = createMjpegParser();
    const bogus = new TextEncoder().encode(
      "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 99999999\r\n\r\n",
    );
    expect(() => parser.push(bogus)).toThrow(MjpegParseError);
  });
});
