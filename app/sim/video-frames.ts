/**
 * The capture host's frame framing, parsed incrementally.
 *
 * `/helper/<udid>/stream.avcc` is a length-prefixed stream, not multipart:
 *
 *     [4-byte big-endian length][1-byte type][payload]   length counts the type
 *
 * and four types arrive, in this order:
 *
 *  - `0x04` a whole JPEG, once, at the head. The host sends its last captured
 *    frame so a viewer has something on screen before the decoder has even been
 *    configured, which is the difference between "instant" and "quarter-second
 *    of grey".
 *  - `0x01` the `avcC` decoder configuration record — byte-for-byte the
 *    `description` WebCodecs wants, and the source of the codec string.
 *  - `0x02` a keyframe, `0x03` a delta frame.
 *
 * Measured against MJPEG on the same simulator under the same swipe loop:
 * 24.9 fps and 200 KB/s, where the JPEG path managed 14.3 fps and 3.55 MB/s.
 * MJPEG is serve-sim's documented software fallback "for hosts whose hardware
 * can't encode H.264"; this is the path that uses VideoToolbox.
 *
 * Everything here is pure, and separated from the decoder for exactly that
 * reason: chunk boundaries fall wherever the network puts them, and a parser
 * that mishandles a frame split across two reads fails in a way that looks like
 * a codec problem.
 */

export const FRAME_DESCRIPTION = 0x01;
export const FRAME_KEY = 0x02;
export const FRAME_DELTA = 0x03;
export const FRAME_JPEG = 0x04;

export interface StreamFrame {
  type: number;
  data: Uint8Array;
}

/**
 * Refuse a length no real frame can have.
 *
 * A desynchronised stream reads four arbitrary bytes as a length and would
 * otherwise buffer up to 4GB waiting for a frame that is not coming. A
 * full-resolution JPEG off this host is about 250KB, so 32MB is far above
 * anything legitimate and far below anything dangerous.
 */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class FrameParseError extends Error {}

export interface FrameParser {
  /** Feed bytes; get back whatever whole frames they completed. */
  push(chunk: Uint8Array): StreamFrame[];
  /** Bytes held back waiting for the rest of a frame. For tests and logging. */
  pending(): number;
}

export function createFrameParser(): FrameParser {
  // One growing buffer rather than a list of chunks: frames are small and
  // contiguous, and a subarray of a single buffer costs nothing to hand out.
  let buffer: Uint8Array = new Uint8Array(0);

  const append = (chunk: Uint8Array): void => {
    if (buffer.length === 0) {
      buffer = chunk;
      return;
    }
    const next = new Uint8Array(buffer.length + chunk.length);
    next.set(buffer, 0);
    next.set(chunk, buffer.length);
    buffer = next;
  };

  return {
    push(chunk: Uint8Array) {
      append(chunk);
      const out: StreamFrame[] = [];
      let offset = 0;

      for (;;) {
        if (buffer.length - offset < 5) break;
        const view = new DataView(buffer.buffer, buffer.byteOffset + offset, 5);
        const length = view.getUint32(0, false);
        if (length < 1 || length > MAX_FRAME_BYTES) {
          throw new FrameParseError(`frame length ${length} is not plausible`);
        }
        // `length` counts the type byte, so the payload is one shorter.
        if (buffer.length - offset < 4 + length) break;
        out.push({
          type: buffer[offset + 4]!,
          data: buffer.subarray(offset + 5, offset + 4 + length),
        });
        offset += 4 + length;
      }

      // Copy rather than subarray: the tail is retained across pushes, and a
      // subarray would pin the whole previous buffer — including every frame
      // just handed out — alive with it.
      buffer = offset === 0 ? buffer : buffer.slice(offset);
      return out;
    },
    pending() {
      return buffer.length;
    },
  };
}

/**
 * The WebCodecs codec string, read out of the `avcC` record.
 *
 * `avc1.` then profile, profile-compatibility and level as six hex digits —
 * `01 64 00 33` is High profile at level 5.1, so `avc1.640033`. Getting this
 * wrong does not degrade: `VideoDecoder.configure` rejects and nothing renders.
 */
export function codecStringFrom(description: Uint8Array): string | null {
  if (description.length < 4 || description[0] !== 1) return null;
  const hex = [description[1]!, description[2]!, description[3]!]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `avc1.${hex}`;
}
