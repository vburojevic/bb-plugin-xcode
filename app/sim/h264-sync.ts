/**
 * H.264 recovery is a codec state machine, not a queue-size boolean.
 *
 * Once any access unit is missing, every following P-frame depends on bytes
 * the decoder never saw. The only legal exit is a decoder configuration plus
 * an IDR proven from the AVCC payload; the envelope's key tag is useful routing
 * metadata, but it is not a recovery guarantee.
 */
import { avccAccessUnitHasIdr, avccNalLengthSize } from "./avcc";
import { codecStringFrom } from "./video-frames";

export type H264SyncState = "needs-description" | "waiting-for-IDR" | "decoding";
export type H264AccessUnitKind = "key" | "delta";
export type H264ResyncCause =
  | "drop"
  | "sequence-gap"
  | "discontinuity"
  | "decoder-error"
  | "configuration-change";

export interface H264DecoderConfiguration {
  codec: string;
  description: Uint8Array;
  generation: number;
  nalLengthSize: number;
}

export interface H264DescriptionDecision {
  configuration: H264DecoderConfiguration;
  resync: "configuration-change" | null;
}

export interface H264AccessUnitDecision {
  decode: H264AccessUnitKind | null;
  recovered: boolean;
  resync: "drop" | null;
}

export interface H264DecoderRecovery {
  configuration: H264DecoderConfiguration | null;
  resync: "decoder-error" | null;
}

function copyConfiguration(
  configuration: H264DecoderConfiguration | null,
): H264DecoderConfiguration | null {
  if (configuration === null) return null;
  return { ...configuration, description: configuration.description.slice() };
}

export class H264SyncGate {
  private syncState: H264SyncState = "needs-description";
  private configuration: H264DecoderConfiguration | null = null;
  private configurationGeneration = 0;

  get state(): H264SyncState {
    return this.syncState;
  }

  /**
   * An emitted description means the encoder generation changed, even when
   * its bytes happen to match the last one. Keeping the last *valid* copy lets
   * a decoder error rebuild immediately while the gate still refuses deltas
   * until the next natural IDR.
   */
  acceptDescription(description: Uint8Array): H264DescriptionDecision | null {
    const nalLengthSize = avccNalLengthSize(description);
    const codec = codecStringFrom(description);
    if (nalLengthSize === null || codec === null) return null;

    const resync = this.configuration === null ? null : "configuration-change";
    this.configurationGeneration += 1;
    this.configuration = {
      codec,
      description: description.slice(),
      generation: this.configurationGeneration,
      nalLengthSize,
    };
    this.syncState = "waiting-for-IDR";
    return {
      configuration: copyConfiguration(this.configuration)!,
      resync,
    };
  }

  acceptAccessUnit(kind: H264AccessUnitKind, data: Uint8Array): H264AccessUnitDecision {
    const configuration = this.configuration;
    if (configuration === null) return { decode: null, recovered: false, resync: null };

    if (kind === "delta") {
      return this.syncState === "decoding"
        ? { decode: "delta", recovered: false, resync: null }
        : { decode: null, recovered: false, resync: null };
    }

    if (!avccAccessUnitHasIdr(data, configuration.nalLengthSize)) {
      return {
        decode: null,
        recovered: false,
        resync: this.droppedAccessUnit(),
      };
    }

    const recovered = this.syncState !== "decoding";
    this.syncState = "decoding";
    return { decode: "key", recovered, resync: null };
  }

  droppedAccessUnit(): "drop" | null {
    return this.loseSync("drop");
  }

  sequenceGap(): "sequence-gap" | null {
    return this.loseSync("sequence-gap");
  }

  discontinuity(): "discontinuity" | null {
    return this.loseSync("discontinuity");
  }

  decoderError(): H264DecoderRecovery {
    this.syncState = this.configuration === null ? "needs-description" : "waiting-for-IDR";
    return {
      configuration: copyConfiguration(this.configuration),
      resync: this.configuration === null ? null : "decoder-error",
    };
  }

  private loseSync<Cause extends "drop" | "sequence-gap" | "discontinuity">(
    cause: Cause,
  ): Cause | null {
    if (this.syncState !== "decoding") return null;
    this.syncState = this.configuration === null ? "needs-description" : "waiting-for-IDR";
    return cause;
  }
}
