/**
 * The viewer's version boundary for H.264 transport records.
 *
 * The installed raw host still emits serve-sim's v1 `application/octet-stream`
 * framing; the child-side upgrader will advertise v2 explicitly once it owns
 * that route. Selecting from Content-Type, rather than sniffing the first few
 * bytes, keeps rollback deterministic: the same leading length and kind bytes
 * are legal in both protocols, and guessing wrong feeds header bytes to a
 * decoder before the failure becomes visible.
 */
import {
  createFrameParser,
  FRAME_DELTA,
  FRAME_DESCRIPTION,
  FRAME_JPEG,
  FRAME_KEY,
  MAX_FRAME_BYTES,
  type FrameType,
} from "./video-frames";

export const MEDIA_ENVELOPE_V2_CONTENT_TYPE = "application/vnd.bb.sim-avcc;version=2";
export const MEDIA_ENVELOPE_V2_VERSION = 2;
export const MEDIA_ENVELOPE_V2_HEADER_BYTES = 28;
export const FRAME_DISCONTINUITY = 0x05;

export type VideoEnvelopeKind = FrameType | typeof FRAME_DISCONTINUITY;

export interface VideoEnvelopeRecord {
  version: 1 | 2;
  kind: VideoEnvelopeKind;
  flags: number;
  sequence: number | null;
  configGeneration: number | null;
  ptsMicros: bigint | null;
  codedWidth: number | null;
  codedHeight: number | null;
  orientation: number | null;
  data: Uint8Array;
}

export interface VideoEnvelopeParser {
  push(chunk: Uint8Array): VideoEnvelopeRecord[];
  pending(): number;
}

export class VideoEnvelopeParseError extends Error {}

export interface VideoPacketEvidence {
  sequence: number;
  /** The exact unit WebCodecs accepts. */
  timestampMicros: number;
  sourcePtsMs: number;
  configGeneration?: number;
  codedWidth?: number;
  codedHeight?: number;
}

export interface V1PacketFallback {
  sequence: number;
  timestampMicros: number;
}

/**
 * Choose wire evidence when it exists and synthetic cadence only for v1.
 *
 * Parsed PTS remains a bigint so diagnostics and golden tests never lose a
 * u64 bit. WebCodecs accepts only a number; host-monotonic microseconds stay
 * exactly representable for centuries of process uptime, which is the only
 * domain the encoder emits even though the wire itself can represent more.
 */
export function videoPacketEvidence(
  record: VideoEnvelopeRecord,
  fallback: V1PacketFallback,
): VideoPacketEvidence {
  if (record.version === 1) {
    return {
      sequence: fallback.sequence,
      timestampMicros: fallback.timestampMicros,
      sourcePtsMs: fallback.timestampMicros / 1_000,
    };
  }
  const timestampMicros = Number(record.ptsMicros);
  return {
    sequence: record.sequence!,
    timestampMicros,
    sourcePtsMs: timestampMicros / 1_000,
    configGeneration: record.configGeneration!,
    ...(record.codedWidth! > 0 ? { codedWidth: record.codedWidth! } : {}),
    ...(record.codedHeight! > 0 ? { codedHeight: record.codedHeight! } : {}),
  };
}

function isV2Kind(kind: number): kind is VideoEnvelopeKind {
  return kind >= FRAME_DESCRIPTION && kind <= FRAME_DISCONTINUITY;
}

function appendBytes(buffer: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (buffer.length === 0) return chunk;
  const next = new Uint8Array(buffer.length + chunk.length);
  next.set(buffer, 0);
  next.set(chunk, buffer.length);
  return next;
}

function createV1EnvelopeParser(): VideoEnvelopeParser {
  const parser = createFrameParser();
  return {
    push(chunk) {
      return parser.push(chunk).map((frame) => ({
        version: 1,
        kind: frame.type,
        flags: 0,
        sequence: null,
        configGeneration: null,
        ptsMicros: null,
        codedWidth: null,
        codedHeight: null,
        orientation: null,
        data: frame.data,
      }));
    },
    pending: () => parser.pending(),
  };
}

function createV2EnvelopeParser(): VideoEnvelopeParser {
  let buffer: Uint8Array = new Uint8Array(0);
  return {
    push(chunk) {
      buffer = appendBytes(buffer, chunk);
      const records: VideoEnvelopeRecord[] = [];
      let offset = 0;

      for (;;) {
        if (buffer.length - offset < 4) break;
        const prefix = new DataView(buffer.buffer, buffer.byteOffset + offset, 4);
        const length = prefix.getUint32(0, false);
        if (length < MEDIA_ENVELOPE_V2_HEADER_BYTES || length > MAX_FRAME_BYTES) {
          throw new VideoEnvelopeParseError(`frame length ${length} is not plausible`);
        }
        if (buffer.length - offset < 6) break;
        const version = buffer[offset + 4]!;
        const kind = buffer[offset + 5]!;
        if (version !== MEDIA_ENVELOPE_V2_VERSION) {
          throw new VideoEnvelopeParseError(`frame version ${version} is not supported`);
        }
        if (!isV2Kind(kind)) {
          throw new VideoEnvelopeParseError(`frame kind ${kind} is not supported`);
        }
        if (buffer.length - offset < 4 + length) break;

        const view = new DataView(
          buffer.buffer,
          buffer.byteOffset + offset,
          4 + MEDIA_ENVELOPE_V2_HEADER_BYTES,
        );
        if (view.getUint8(29) !== 0 || view.getUint8(30) !== 0 || view.getUint8(31) !== 0) {
          throw new VideoEnvelopeParseError("frame reserved bytes are not zero");
        }
        records.push({
          version: 2,
          kind,
          flags: view.getUint16(6, false),
          sequence: view.getUint32(8, false),
          configGeneration: view.getUint32(12, false),
          ptsMicros: view.getBigUint64(16, false),
          codedWidth: view.getUint16(24, false),
          codedHeight: view.getUint16(26, false),
          orientation: view.getUint8(28),
          data: buffer.subarray(
            offset + 4 + MEDIA_ENVELOPE_V2_HEADER_BYTES,
            offset + 4 + length,
          ),
        });
        offset += 4 + length;
      }

      // A copy keeps a partial next header without retaining the completed
      // payloads it followed. Returned payload views keep the old allocation.
      buffer = offset === 0 ? buffer : buffer.slice(offset);
      return records;
    },
    pending() {
      return buffer.length;
    },
  };
}

function parseContentType(value: string | null): { mediaType: string; version: string | null } {
  const [head = "", ...tail] = (value ?? "").split(";");
  let version: string | null = null;
  for (const parameter of tail) {
    const [rawName = "", rawValue = ""] = parameter.split("=", 2);
    if (rawName.trim().toLowerCase() === "version") version = rawValue.trim();
  }
  return { mediaType: head.trim().toLowerCase(), version };
}

export function createVideoEnvelopeParser(contentType: string | null): VideoEnvelopeParser {
  const parsed = parseContentType(contentType);
  if (parsed.mediaType === "application/octet-stream") return createV1EnvelopeParser();
  if (parsed.mediaType === "application/vnd.bb.sim-avcc" && parsed.version === "2") {
    return createV2EnvelopeParser();
  }
  throw new VideoEnvelopeParseError(`unsupported H.264 content type: ${contentType ?? "missing"}`);
}

export { FRAME_DELTA, FRAME_DESCRIPTION, FRAME_JPEG, FRAME_KEY };
