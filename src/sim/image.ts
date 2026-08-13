/**
 * Reading image dimensions, and shrinking images with a macOS builtin.
 *
 * The dimension readers are pure byte arithmetic with no dependency, which
 * matters twice: they run on a Linux CI box against the checked-in fixtures,
 * and the PNG one is **load-bearing** rather than an optimisation. odiff
 * without `--fail-on-layout` silently compares images of different sizes and
 * reports a fabricated ratio over the larger one's pixel count, so the
 * dimension check has to happen before odiff is asked anything.
 *
 * Frames are stored in whatever format they arrived in: preview renders are
 * PNG, captures are JPEG straight off the MJPEG stream. Re-encoding a capture
 * to PNG would cost time and disk to make a lossy image lossless, which is not
 * a thing that can be done.
 */
import { run } from "./exec.js";

export interface Dimensions {
  width: number;
  height: number;
}

export type ImageFormat = "png" | "jpeg";

/**
 * PNG dimensions from the IHDR chunk.
 *
 * The signature is eight bytes, then a four-byte length, then `IHDR`, then
 * width and height as big-endian 32-bit integers — offsets 16 and 20.
 */
export function pngDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return null;
  }
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/**
 * JPEG dimensions from the first Start-Of-Frame marker.
 *
 * Walking the segment table rather than guessing an offset: a frame off the
 * simulator carries an EXIF block before its SOF, so anything that assumes a
 * fixed position reads the wrong two numbers and silently reports a
 * `layout-changed` for every capture.
 */
export function jpegDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Padding and the standalone markers carry no length field.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or entropy data

    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    // SOF0–SOF15, excluding the DHT/JPG/DAC markers interleaved in that range.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (offset + 9 >= bytes.length) return null;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

export function detectFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  return null;
}

/** Dimensions from whichever format this is, or `null` for neither. */
export function dimensions(bytes: Uint8Array): Dimensions | null {
  switch (detectFormat(bytes)) {
    case "png":
      return pngDimensions(bytes);
    case "jpeg":
      return jpegDimensions(bytes);
    default:
      return null;
  }
}

export function contentTypeOf(relPath: string): string {
  return relPath.endsWith(".png") ? "image/png" : "image/jpeg";
}

/** The long edge a thumbnail is scaled to. Twelve tiles is twenty-four requests. */
export const THUMB_LONG_EDGE = 512;

/**
 * The long edge an image handed to a model is scaled to.
 *
 * A 1206×2622 @3x PNG is 2–4 MB of base64 per call, the host turns an image
 * block into a data URL and caps nothing, and the cost lands on the context
 * window and on provider image limits that differ per provider. A model judging
 * whether something is centred does not need @3x lossless.
 */
export const AGENT_LONG_EDGE = 1024;
export const AGENT_JPEG_QUALITY = 80;

/**
 * Downscale with `sips`, a macOS builtin — no dependency, and already present
 * wherever `xcrun` is.
 *
 * Returns `false` rather than throwing when it fails: a missing thumbnail
 * degrades the grid to full-size images, which is slow but correct, whereas a
 * failed capture over a failed thumbnail is a lost frame.
 */
export async function downscale(
  input: string,
  output: string,
  longEdge: number,
  quality = AGENT_JPEG_QUALITY,
): Promise<boolean> {
  try {
    const result = await run(
      "sips",
      ["-Z", String(longEdge), "-s", "format", "jpeg", "-s", "formatOptions", String(quality), input, "--out", output],
      { timeoutMs: 30_000 },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * The total image payload one tool call may carry, across every part.
 *
 * When a result would exceed it the text says so — *"(3 more changed; open the
 * panel)"* — because the text summary has to stand alone: a provider may reject
 * image content entirely, and load-bearing information must never live only in
 * a picture.
 */
export const AGENT_IMAGE_BUDGET_BYTES = 1_500_000;

/**
 * Fit images into the budget, newest or most-important first.
 *
 * Base64 inflates by 4/3, and that is what the provider is billed for, so the
 * budget is applied to the encoded size rather than the file size.
 */
export function fitToBudget<T extends { bytes: number }>(
  items: readonly T[],
  budget = AGENT_IMAGE_BUDGET_BYTES,
): { included: T[]; omitted: number } {
  const included: T[] = [];
  let used = 0;
  for (const item of items) {
    const encoded = Math.ceil(item.bytes / 3) * 4;
    if (used + encoded > budget && included.length > 0) break;
    included.push(item);
    used += encoded;
  }
  return { included, omitted: items.length - included.length };
}
