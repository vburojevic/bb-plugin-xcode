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
import { BoundedByteQueue } from "./byte-queue";

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
  data: Uint8Array<ArrayBuffer>;
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
  const queue = new BoundedByteQueue(MAX_FRAME_BYTES + 4);
  return {
    push(chunk) {
      queue.push(chunk);
      const records: VideoEnvelopeRecord[] = [];

      for (;;) {
        if (queue.bufferedBytes < 4) break;
        const length = queue.readUint32BE(0);
        if (length < MEDIA_ENVELOPE_V2_HEADER_BYTES || length > MAX_FRAME_BYTES) {
          throw new VideoEnvelopeParseError(`frame length ${length} is not plausible`);
        }
        if (queue.bufferedBytes < 6) break;
        const version = queue.byteAt(4);
        const kind = queue.byteAt(5);
        if (version !== MEDIA_ENVELOPE_V2_VERSION) {
          throw new VideoEnvelopeParseError(`frame version ${version} is not supported`);
        }
        if (!isV2Kind(kind)) {
          throw new VideoEnvelopeParseError(`frame kind ${kind} is not supported`);
        }
        if (queue.bufferedBytes < 4 + length) break;

        if (queue.byteAt(29) !== 0 || queue.byteAt(30) !== 0 || queue.byteAt(31) !== 0) {
          throw new VideoEnvelopeParseError("frame reserved bytes are not zero");
        }
        const flags = queue.readUint16BE(6);
        const sequence = queue.readUint32BE(8);
        const configGeneration = queue.readUint32BE(12);
        const ptsMicros = queue.readBigUint64BE(16);
        const codedWidth = queue.readUint16BE(24);
        const codedHeight = queue.readUint16BE(26);
        const orientation = queue.byteAt(28);
        queue.discard(4 + MEDIA_ENVELOPE_V2_HEADER_BYTES);
        records.push({
          version: 2,
          kind,
          flags,
          sequence,
          configGeneration,
          ptsMicros,
          codedWidth,
          codedHeight,
          orientation,
          data: queue.take(length - MEDIA_ENVELOPE_V2_HEADER_BYTES),
        });
      }

      return records;
    },
    pending() {
      return queue.bufferedBytes;
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
