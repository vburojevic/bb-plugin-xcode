/**
 * The MJPEG stream, parsed incrementally.
 *
 * `/helper/<udid>/stream.mjpeg` is `multipart/x-mixed-replace`:
 *
 *     --frame\r\n
 *     Content-Type: image/jpeg\r\n
 *     Content-Length: <n>\r\n
 *     \r\n
 *     <n bytes of JPEG>\r\n
 *
 * The panel used to hand this straight to an `<img>` and let the browser deal
 * with it — which worked, but told the panel nothing: no frame count, no
 * timing, and a `load` event per part only in the browsers that felt like it.
 * Parsing it here is what lets the MJPEG path share the canvas, the frame
 * counter and the stall watchdog with the H.264 path, instead of being the
 * second-class render stack that lied about stalls.
 *
 * Everything here is pure, for the same reason the avcc parser is: chunk
 * boundaries fall wherever the network puts them, and a parser that mishandles
 * a part split across two reads fails in a way that looks like a dead device.
 */
import { BoundedByteQueue } from "./byte-queue";

export interface MjpegPart {
  /** One whole JPEG, headers stripped. */
  jpeg: Uint8Array<ArrayBuffer>;
}

export interface MjpegParser {
  /** Feed bytes; get back whatever whole JPEGs they completed. */
  push(chunk: Uint8Array): MjpegPart[];
  /** Bytes held back waiting for the rest of a part. For tests and logging. */
  pending(): number;
}

/**
 * Refuse a length no real frame can have.
 *
 * A desynchronised stream reads four arbitrary digits as a length and would
 * otherwise buffer forever waiting for a part that is not coming. A
 * full-resolution JPEG off this host is about 250KB, so 32MB is far above
 * anything legitimate and far below anything dangerous.
 */
export const MAX_PART_BYTES = 32 * 1024 * 1024;

export class MjpegParseError extends Error {}

const HEADER_END = [13, 10, 13, 10]; // \r\n\r\n
const HEADER_END_BYTES = new Uint8Array(HEADER_END);
const MAX_HEADER_BYTES = 64 * 1024;
const CONTENT_LENGTH = /content-length:\s*(\d+)/i;
const ASCII = new TextDecoder("ascii");

export function createMjpegParser(): MjpegParser {
  // The header allowance lets one network read contain the largest legal
  // body plus its prefix while still making a delimiter-free stream finite.
  const queue = new BoundedByteQueue(MAX_PART_BYTES + MAX_HEADER_BYTES);
  let pendingBodyBytes: number | null = null;

  return {
    push(chunk: Uint8Array) {
      queue.push(chunk);
      const out: MjpegPart[] = [];

      for (;;) {
        if (pendingBodyBytes === null) {
          const headerEnd = queue.indexOf(HEADER_END_BYTES);
          if (headerEnd === -1) {
            if (queue.bufferedBytes > MAX_HEADER_BYTES) {
              throw new MjpegParseError("multipart header exceeds 64 KiB");
            }
            break;
          }
          const header = ASCII.decode(queue.take(headerEnd));
          queue.discard(HEADER_END.length);
          const length = CONTENT_LENGTH.exec(header);
          if (length === null) {
            // A header block with no length is not a part — it is the preamble,
            // a boundary line, or garbage after one. Resync past it.
            continue;
          }
          const bytes = Number.parseInt(length[1]!, 10);
          if (!Number.isFinite(bytes) || bytes < 1 || bytes > MAX_PART_BYTES) {
            throw new MjpegParseError(`part length ${length[1]} is not plausible`);
          }
          pendingBodyBytes = bytes;
        }
        if (queue.bufferedBytes < pendingBodyBytes) break;
        out.push({ jpeg: queue.take(pendingBodyBytes) });
        pendingBodyBytes = null;
      }

      return out;
    },
    pending() {
      return queue.bufferedBytes;
    },
  };
}
