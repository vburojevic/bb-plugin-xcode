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

export interface MjpegPart {
  /** One whole JPEG, headers stripped. */
  jpeg: Uint8Array;
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
const CONTENT_LENGTH = /content-length:\s*(\d+)/i;
const ASCII = new TextDecoder("ascii");

export function createMjpegParser(): MjpegParser {
  // One growing buffer rather than a list of chunks: parts are small and
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

  const indexOfHeaderEnd = (from: number): number => {
    outer: for (let i = from; i + 3 < buffer.length; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        if (buffer[i + j] !== HEADER_END[j]) continue outer;
      }
      return i;
    }
    return -1;
  };

  return {
    push(chunk: Uint8Array) {
      append(chunk);
      const out: MjpegPart[] = [];
      let offset = 0;

      for (;;) {
        const headerEnd = indexOfHeaderEnd(offset);
        if (headerEnd === -1) break;
        const header = ASCII.decode(buffer.subarray(offset, headerEnd));
        const length = CONTENT_LENGTH.exec(header);
        if (length === null) {
          // A header block with no length is not a part — it is the preamble,
          // a boundary line, or garbage after one. Resync past it.
          offset = headerEnd + 4;
          continue;
        }
        const bytes = Number.parseInt(length[1]!, 10);
        if (!Number.isFinite(bytes) || bytes < 1 || bytes > MAX_PART_BYTES) {
          throw new MjpegParseError(`part length ${length[1]} is not plausible`);
        }
        const bodyStart = headerEnd + 4;
        if (buffer.length - bodyStart < bytes) break;
        out.push({ jpeg: buffer.subarray(bodyStart, bodyStart + bytes) });
        offset = bodyStart + bytes;
      }

      // Copy rather than subarray: the tail is retained across pushes, and a
      // subarray would pin the whole previous buffer — including every part
      // just handed out — alive with it.
      buffer = offset === 0 ? buffer : buffer.slice(offset);
      return out;
    },
    pending() {
      return buffer.length;
    },
  };
}
