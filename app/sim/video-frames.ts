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
import { BoundedByteQueue } from "./byte-queue";

export const FRAME_DESCRIPTION = 0x01;
export const FRAME_KEY = 0x02;
export const FRAME_DELTA = 0x03;
export const FRAME_JPEG = 0x04;

export type FrameType =
  | typeof FRAME_DESCRIPTION
  | typeof FRAME_KEY
  | typeof FRAME_DELTA
  | typeof FRAME_JPEG;

export function isFrameType(type: number): type is FrameType {
  return type >= FRAME_DESCRIPTION && type <= FRAME_JPEG;
}

export interface StreamFrame {
  type: FrameType;
  data: Uint8Array<ArrayBuffer>;
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
  // Four prefix bytes may sit beside the largest legal record. The queue
  // takes ownership of stream chunks; a returned view is therefore stable
  // even when a later push advances the deque into the same allocation.
  const queue = new BoundedByteQueue(MAX_FRAME_BYTES + 4);

  return {
    push(chunk: Uint8Array) {
      queue.push(chunk);
      const out: StreamFrame[] = [];

      for (;;) {
        if (queue.bufferedBytes < 4) break;
        const length = queue.readUint32BE(0);
        if (length < 1 || length > MAX_FRAME_BYTES) {
          throw new FrameParseError(`frame length ${length} is not plausible`);
        }
        if (queue.bufferedBytes < 5) break;
        const type = queue.byteAt(4);
        if (!isFrameType(type)) {
          throw new FrameParseError(`frame kind ${type} is not supported`);
        }
        // `length` counts the type byte, so the payload is one shorter.
        if (queue.bufferedBytes < 4 + length) break;
        queue.discard(5);
        out.push({ type, data: queue.take(length - 1) });
      }

      return out;
    },
    pending() {
      return queue.bufferedBytes;
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
