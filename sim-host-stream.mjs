/**
 * The capture child's stream boundary, isolated from both serve-sim and the
 * bundled plugin.
 *
 * SHIPS RAW AND UNBUNDLED. The child will use this module to translate the
 * installed dependency's undocumented v1 byte stream into bb's versioned v2
 * envelope. Keeping the translation pure means Linux CI can prove the wire
 * contract without loading serve-sim's macOS native addon, while keeping any
 * future server-side import from acquiring a path to that addon.
 */

export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const V2_HEADER_BYTES = 28;
export const V2_VERSION = 2;
export const MEDIA_KIND_DESCRIPTION = 1;
export const MEDIA_KIND_KEY = 2;
export const MEDIA_KIND_DELTA = 3;
export const MEDIA_KIND_JPEG = 4;
export const MEDIA_KIND_DISCONTINUITY = 5;
export const ORIENTATION_UNKNOWN = 0;

const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

export class SimHostStreamError extends Error {}

function isV1Kind(kind) {
  return kind >= MEDIA_KIND_DESCRIPTION && kind <= MEDIA_KIND_JPEG;
}

function isV2Kind(kind) {
  return kind >= MEDIA_KIND_DESCRIPTION && kind <= MEDIA_KIND_DISCONTINUITY;
}

function appendBytes(buffer, chunk) {
  if (buffer.length === 0) return chunk;
  const next = new Uint8Array(buffer.length + chunk.length);
  next.set(buffer, 0);
  next.set(chunk, buffer.length);
  return next;
}

/**
 * Parse serve-sim's v1 records before attaching evidence to them.
 *
 * This intentionally duplicates the tiny browser-side v1 parser. Sharing it
 * would make the raw child import bundled app code, turning an architectural
 * security boundary into a build-tool convention. Their golden test is the
 * shared source of truth instead.
 */
export function createV1FrameParser() {
  let buffer = new Uint8Array(0);
  return {
    push(chunk) {
      buffer = appendBytes(buffer, chunk);
      const records = [];
      let offset = 0;
      for (;;) {
        if (buffer.length - offset < 4) break;
        const length = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0, false);
        if (length < 1 || length > MAX_FRAME_BYTES) {
          throw new SimHostStreamError(`frame length ${length} is not plausible`);
        }
        if (buffer.length - offset < 5) break;
        const kind = buffer[offset + 4];
        if (!isV1Kind(kind)) throw new SimHostStreamError(`frame kind ${kind} is not supported`);
        if (buffer.length - offset < 4 + length) break;
        records.push({
          type: kind,
          data: buffer.subarray(offset + 5, offset + 4 + length),
        });
        offset += 4 + length;
      }
      // Retaining a subarray here would pin every completed access unit while
      // waiting for the next record's four-byte length.
      buffer = offset === 0 ? buffer : buffer.slice(offset);
      return records;
    },
    pending() {
      return buffer.length;
    },
  };
}

function uint(name, value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new SimHostStreamError(`${name} is outside its unsigned wire range`);
  }
  return value;
}

function pts(value) {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new SimHostStreamError("ptsMicros is outside its unsigned wire range");
  }
  return value;
}

/** Encode one already-evidenced v2 record. Used directly by the golden test. */
export function encodeV2Record(record) {
  const kind = uint("kind", record.kind, 0xff);
  if (!isV2Kind(kind)) throw new SimHostStreamError(`frame kind ${kind} is not supported`);
  const payload = record.payload ?? new Uint8Array(0);
  if (!(payload instanceof Uint8Array)) {
    throw new SimHostStreamError("payload must be a Uint8Array");
  }
  const length = V2_HEADER_BYTES + payload.byteLength;
  if (length > MAX_FRAME_BYTES) {
    throw new SimHostStreamError(`frame length ${length} is not plausible`);
  }

  const output = new Uint8Array(4 + length);
  const view = new DataView(output.buffer);
  view.setUint32(0, length, false);
  output[4] = V2_VERSION;
  output[5] = kind;
  view.setUint16(6, uint("flags", record.flags ?? 0, 0xffff), false);
  view.setUint32(8, uint("sequence", record.sequence ?? 0, UINT32_MAX), false);
  view.setUint32(
    12,
    uint("configGeneration", record.configGeneration ?? 0, UINT32_MAX),
    false,
  );
  view.setBigUint64(16, pts(record.ptsMicros ?? 0n), false);
  view.setUint16(24, uint("codedWidth", record.codedWidth ?? 0, 0xffff), false);
  view.setUint16(26, uint("codedHeight", record.codedHeight ?? 0, 0xffff), false);
  output[28] = uint("orientation", record.orientation ?? ORIENTATION_UNKNOWN, 0xff);
  // 29..31 stay zero. Non-zero reserved bytes would make a v2 record claim
  // semantics no v2 reader understands.
  output.set(payload, 32);
  return output;
}

function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function nextCounter(name, current) {
  if (current === UINT32_MAX) throw new SimHostStreamError(`${name} exhausted its wire range`);
  return current + 1;
}

/**
 * Attach the evidence v1 cannot carry.
 *
 * Generation one is the initial upstream. A first description or geometry
 * establishes that generation rather than manufacturing a change; later byte
 * or geometry differences advance it once per record. Restart explicitly
 * advances and clears the comparison baseline, because identical avcC bytes
 * after a new native encoder still belong to a different decoder lifetime.
 */
export function createMediaEnvelopeEncoder(options = {}) {
  const nowMicros = options.nowMicros ?? (() => process.hrtime.bigint() / 1000n);
  let sequence = 0;
  let configGeneration = 1;
  let description = null;
  let geometry = null;

  const encode = (frame) => {
    const kind = uint("kind", frame.kind, 0xff);
    if (!isV2Kind(kind)) throw new SimHostStreamError(`frame kind ${kind} is not supported`);
    const payload = frame.payload ?? new Uint8Array(0);
    const codedWidth = uint("codedWidth", frame.codedWidth ?? 0, 0xffff);
    const codedHeight = uint("codedHeight", frame.codedHeight ?? 0, 0xffff);
    let changed = false;

    if (kind === MEDIA_KIND_DESCRIPTION) {
      if (description !== null && !sameBytes(description, payload)) changed = true;
      description = payload.slice();
    }
    if (codedWidth > 0 && codedHeight > 0) {
      if (
        geometry !== null &&
        (geometry.codedWidth !== codedWidth || geometry.codedHeight !== codedHeight)
      ) {
        changed = true;
      }
      geometry = { codedWidth, codedHeight };
    }
    if (changed) configGeneration = nextCounter("configGeneration", configGeneration);

    if (kind === MEDIA_KIND_KEY || kind === MEDIA_KIND_DELTA) {
      sequence = nextCounter("sequence", sequence);
    }
    const media =
      kind === MEDIA_KIND_KEY || kind === MEDIA_KIND_DELTA || kind === MEDIA_KIND_JPEG;
    const orientation =
      frame.orientationValidated === true &&
      Number.isInteger(frame.orientation) &&
      frame.orientation >= 1 &&
      frame.orientation <= 4 &&
      geometry !== null &&
      geometry.codedWidth === codedWidth &&
      geometry.codedHeight === codedHeight
        ? frame.orientation
        : ORIENTATION_UNKNOWN;

    return encodeV2Record({
      kind,
      flags: frame.flags ?? 0,
      sequence,
      configGeneration,
      ptsMicros: media ? nowMicros() : 0n,
      codedWidth,
      codedHeight,
      orientation,
      payload,
    });
  };

  return {
    encode,
    upstreamRestart() {
      configGeneration = nextCounter("configGeneration", configGeneration);
      description = null;
      geometry = null;
      return encodeV2Record({
        kind: MEDIA_KIND_DISCONTINUITY,
        sequence,
        configGeneration,
      });
    },
  };
}
