/**
 * One stream, one canvas, one pipeline.
 *
 * The frame used to be rendered by two parallel stacks — an `<img>` for
 * MJPEG, a WebCodecs canvas for H.264 — and the seams between them were where
 * the bugs lived:
 *
 *  - The `<img>` told the panel *nothing*: no frame count, no timing, and a
 *    `load` event per part only in the browsers that felt like it. Stall
 *    detection was a guess, and a wrong guess put "The stream stopped" over a
 *    video that was playing, with no path that ever cleared it.
 *  - The H.264 stack read and decoded as fast as bytes arrived: no
 *    backpressure, a 1000 fps synthetic timestamp, and a JPEG bootstrap frame
 *    that could resolve late and paint *over* a newer decoded frame.
 *
 * Here both codecs go through one path: `fetch` → incremental parse → decode
 * → paint, into a single canvas, behind one frame counter. The differences
 * that remain are the honest ones — the parser (`video-envelope` vs
 * `mjpeg-frames`) and the decoder (`VideoDecoder` vs `createImageBitmap`).
 *
 * What this file has to get right:
 *
 *  - **Backpressure.** A `fetch` body is pull-based: when the decoder queue
 *    is full, stop calling `read()` and TCP flow control slows the encoder
 *    instead of the page's heap. Policy lives in `stream-core`.
 *  - **Paint order.** Bitmaps decode asynchronously; only the newest may
 *    paint. Every bitmap and every `VideoFrame` is closed on every path out —
 *    a leaked one holds a GPU surface, and the decoder stops delivering once
 *    enough of them pile up.
 */
import { useEffect, useRef, useState } from "react";
import { createMjpegParser } from "./mjpeg-frames";
import { MjpegAdmission, pullMjpegFrames } from "./mjpeg-admission";
import {
  DecoderGeneration,
  shouldDropToKeyframe,
  shouldPauseForDecoder,
  shouldResumeDecoding,
  timestampFor,
} from "./stream-core";
import {
  H264SyncGate,
  type H264DecoderConfiguration,
  type H264ResyncCause,
} from "./h264-sync";
import type { StreamSource } from "./stream-sources";
import {
  createVideoEnvelopeParser,
  FRAME_DELTA,
  FRAME_DESCRIPTION,
  FRAME_DISCONTINUITY,
  FRAME_JPEG,
  FRAME_KEY,
  videoPacketEvidence,
  type VideoEnvelopeRecord,
} from "./video-envelope";
import {
  frameFingerprint,
  StreamTelemetry,
  type PacketEvent,
  type StreamTelemetryConfig,
  type TelemetryUpdate,
} from "./stream-telemetry";
import type { LiveStreamSample } from "../../src/sim/contract.js";

export interface StreamStats {
  /** Frames decoded and painted. The stall watchdog counts these. */
  frames: number;
  /** The newest local sample; RPC publication is deliberately less frequent. */
  telemetry: LiveStreamSample | null;
  /** Set once the stream fails terminally; the caller advances the ladder. */
  failed: boolean;
}

/**
 * Pull `source.url` and paint it into `canvas` until unmounted or aborted.
 *
 * Returns a frame counter rather than taking an `onFrame` callback: a counter
 * cannot be stale, and every consumer here wants "has anything arrived lately"
 * rather than the frame itself.
 */
export function useStream(
  source: StreamSource | null,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  active: boolean,
  telemetryConfig: Omit<StreamTelemetryConfig, "codec" | "route" | "reconnects"> & {
    onSample: (sample: LiveStreamSample) => void;
  },
): StreamStats {
  const [frames, setFrames] = useState(0);
  const [telemetry, setTelemetry] = useState<LiveStreamSample | null>(null);
  const [failed, setFailed] = useState(false);
  // Counted outside React so a burst of frames is one render, not thirty.
  const counter = useRef(0);
  const url = source?.url ?? null;
  const codec = source?.codec ?? null;
  const route = source?.route ?? null;
  const reconnects = useRef(0);
  const started = useRef(false);

  useEffect(() => {
    setFailed(false);
    setFrames(0);
    setTelemetry(null);
    counter.current = 0;
  }, [url]);

  useEffect(() => {
    if (url === null || codec === null || route === null || !active) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;

    // A (re)start is a new stream in every way: rate windows must not average
    // across a reconnect or a visibility toggle.
    counter.current = 0;
    setFrames(0);
    setTelemetry(null);

    if (started.current) reconnects.current += 1;
    started.current = true;
    const tracker = new StreamTelemetry({
      viewerId: telemetryConfig.viewerId,
      deviceUdid: telemetryConfig.deviceUdid,
      hostGeneration: telemetryConfig.hostGeneration,
      codec,
      route,
      qualityProfile: telemetryConfig.qualityProfile,
      logicalWidth: telemetryConfig.logicalWidth,
      logicalHeight: telemetryConfig.logicalHeight,
      reconnects: reconnects.current,
    });

    const abort = new AbortController();
    let decoderOwner: DecoderGeneration<VideoDecoder, VideoFrame, DOMException> | null = null;
    let disposed = false;
    let frameIndex = 0;
    let painting = false;
    /**
     * Only the newest frame may paint. Bitmaps decode asynchronously, and
     * without a sequence the JPEG bootstrap frame can resolve *after* the
     * first H.264 frame and paint stale pixels over live ones — the old
     * pipeline's opening glitch, every time.
     */
    let paintSeq = 0;
    let latestTelemetry: LiveStreamSample | null = null;
    const syncGate = new H264SyncGate();
    const packetsByTimestamp = new Map<number, PacketEvent>();

    const context = canvas.getContext("2d", { alpha: false });

    const publish = (update: TelemetryUpdate, painted: boolean): void => {
      if (painted) counter.current += 1;
      latestTelemetry = update.sample;
      if (update.reason !== null) telemetryConfig.onSample(update.sample);
      // Coalesce: the watchdog and HUD need current truth, not one React render
      // per packet. Exceptional samples still cross RPC immediately above.
      if (!painting) {
        painting = true;
        requestAnimationFrame(() => {
          painting = false;
          if (disposed) return;
          setFrames(counter.current);
          setTelemetry(latestTelemetry);
        });
      }
    };

    const paint = (
      source: CanvasImageSource,
      width: number,
      height: number,
      packet: PacketEvent,
      surfaceId?: string,
    ): void => {
      if (context === null) return;
      const codedWidth = packet.codedWidth ?? width;
      const codedHeight = packet.codedHeight ?? height;
      if (canvas.width !== codedWidth || canvas.height !== codedHeight) {
        canvas.width = codedWidth;
        canvas.height = codedHeight;
      }
      context.drawImage(source, 0, 0, codedWidth, codedHeight);
      publish(
        tracker.paint({
          ...packet,
          paintedAtMs: performance.now(),
          paintedAtUnixMs: Date.now(),
          codedWidth,
          codedHeight,
          ...(surfaceId === undefined ? {} : { surfaceId }),
        }),
        true,
      );
    };

    /** A JPEG, through the ordered bitmap path. Shared by MJPEG parts and the
     * H.264 stream's bootstrap frame. */
    const decodeJpeg = async (
      data: Uint8Array<ArrayBuffer>,
      packet: PacketEvent,
    ): Promise<void> => {
      const seq = ++paintSeq;
      const surfaceId = frameFingerprint(data);
      // The parser transfers an immutable payload view: Blob/WebCodecs may
      // still copy internally, but another plugin-owned `slice()` here only
      // duplicates the exact allocation the chunk deque already made when a
      // frame crossed network chunks.
      const bitmap = await createImageBitmap(new Blob([data], { type: "image/jpeg" }));
      try {
        if (disposed || seq !== paintSeq) return;
        paint(bitmap, bitmap.width, bitmap.height, packet, surfaceId);
      } finally {
        // A stale sequence and an unmounted canvas own exactly the same GPU
        // cleanup obligation as a painted bitmap.
        bitmap.close();
      }
    };

    // The H.264 bootstrap is not part of MJPEG pressure accounting. Keeping
    // its small independent guard means fallback saturation cannot weaken the
    // instant first paint or delay decoder configuration.
    let pendingBootstrapBitmaps = 0;
    const paintBootstrapJpeg = (
      data: Uint8Array<ArrayBuffer>,
      packet: PacketEvent,
    ): void => {
      if (pendingBootstrapBitmaps >= 4) return;
      pendingBootstrapBitmaps += 1;
      void decodeJpeg(data, packet)
        .catch(() => {})
        .finally(() => {
          pendingBootstrapBitmaps -= 1;
        });
    };

    const fail = (): void => {
      if (disposed) return;
      publish(tracker.failure(), false);
      setFailed(true);
    };

    publish(tracker.configure(), false);

    const publishResync = (cause: H264ResyncCause | null): void => {
      if (cause !== null) publish(tracker.resync(cause), false);
    };

    const rememberPacket = (timestamp: number, packet: PacketEvent): void => {
      packetsByTimestamp.set(timestamp, packet);
      if (packetsByTimestamp.size <= 64) return;
      const oldest = packetsByTimestamp.keys().next().value as number | undefined;
      if (oldest !== undefined) packetsByTimestamp.delete(oldest);
    };

    const publishH264Packet = (packet: PacketEvent): void => {
      const update = tracker.packet(packet);
      publish(update, false);
      if (update.continuity === "sequence-gap") publishResync(syncGate.sequenceGap());
      if (update.continuity === "discontinuity") publishResync(syncGate.discontinuity());
    };

    const publishDiscontinuity = (): void => {
      packetsByTimestamp.clear();
      publish(tracker.discontinuity(), false);
      publishResync(syncGate.discontinuity());
    };

    const installDecoder = (configuration: H264DecoderConfiguration): boolean => {
      const owner = decoderOwner;
      if (owner === null) return false;
      try {
        const next = owner.replace(
          (callbacks) => new VideoDecoder({ output: callbacks.output, error: callbacks.error }),
        );
        next.configure({
          codec: configuration.codec,
          description: configuration.description,
          optimizeForLatency: true,
        });
        return true;
      } catch {
        owner.close();
        return false;
      }
    };

    const recoverDecoder = (): void => {
      if (disposed) return;
      const recovery = syncGate.decoderError();
      publishResync(recovery.resync);
      packetsByTimestamp.clear();
      if (recovery.configuration === null || !installDecoder(recovery.configuration)) fail();
    };

    decoderOwner = new DecoderGeneration<VideoDecoder, VideoFrame, DOMException>({
      output: (videoFrame) => {
        if (disposed) return;
        // Decoder output is ordered within one generation. Bitmap work and
        // callbacks from replaced generations lose ownership independently.
        paintSeq += 1;
        const packet = packetsByTimestamp.get(videoFrame.timestamp);
        if (packet === undefined) return;
        packetsByTimestamp.delete(videoFrame.timestamp);
        paint(videoFrame, videoFrame.displayWidth, videoFrame.displayHeight, packet);
      },
      error: () => recoverDecoder(),
    });

    /**
     * Wait until the decoder queue has drained.
     *
     * `dequeue` fires as the queue empties; the interval is the fallback for
     * implementations that never fire it. Either way this resolves, because a
     * backpressure wait that can hang is a stall detector's worst false alarm.
     */
    const waitForDecoderDrain = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const current = decoderOwner?.current ?? null;
        if (current === null) {
          resolve();
          return;
        }
        const check = (): void => {
          if (
            disposed ||
            decoderOwner?.current !== current ||
            shouldResumeDecoding(current.decodeQueueSize)
          ) {
            current.removeEventListener("dequeue", check);
            clearInterval(fallback);
            resolve();
          }
        };
        const fallback = setInterval(check, 50);
        fallback.unref?.();
        current.addEventListener("dequeue", check);
        check();
      });

    const runH264 = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      contentType: string | null,
    ): Promise<void> => {
      const parser = createVideoEnvelopeParser(contentType);

      const evidenceFor = (
        frame: VideoEnvelopeRecord,
        arrivedAtMs: number,
        decoderQueue: number,
      ): PacketEvent & { timestampMicros: number } => {
        if (frame.version === 1) frameIndex += 1;
        const evidence = videoPacketEvidence(frame, {
          sequence: frameIndex,
          timestampMicros: timestampFor(frameIndex),
        });
        return {
          ...evidence,
          arrivedAtMs,
          bytes: frame.data.byteLength,
          decoderQueue,
        };
      };

      for (;;) {
        // Backpressure before more bytes: the body is pull-based, so not
        // reading is what slows the encoder down.
        const pullDecoder = decoderOwner?.current ?? null;
        if (
          !disposed &&
          pullDecoder !== null &&
          pullDecoder.state === "configured" &&
          shouldPauseForDecoder(pullDecoder.decodeQueueSize)
        ) {
          await waitForDecoderDrain();
          continue;
        }

        const { done, value } = await reader.read();
        if (done || disposed) return;
        if (value === undefined) continue;
        const arrivedAtMs = performance.now();

        for (const frame of parser.push(value)) {
          if (disposed) return;
          switch (frame.kind) {
            case FRAME_JPEG:
              // The instant first paint, before the decoder is configured.
              {
                const packet = evidenceFor(frame, arrivedAtMs, pendingBootstrapBitmaps + 1);
                publishH264Packet(packet);
                paintBootstrapJpeg(frame.data, packet);
              }
              break;
            case FRAME_DESCRIPTION: {
              const decision = syncGate.acceptDescription(frame.data);
              if (decision === null) {
                fail();
                return;
              }
              publishResync(decision.resync);
              packetsByTimestamp.clear();
              if (!installDecoder(decision.configuration)) {
                fail();
                return;
              }
              break;
            }
            case FRAME_KEY: {
              const current = decoderOwner?.current ?? null;
              const packet = evidenceFor(
                frame,
                arrivedAtMs,
                (current?.decodeQueueSize ?? 0) + 1,
              );
              publishH264Packet(packet);
              const decision = syncGate.acceptAccessUnit("key", frame.data);
              publishResync(decision.resync);
              if (decision.decode === null) break;
              if (current === null || current.state !== "configured") {
                publishResync(syncGate.droppedAccessUnit());
                break;
              }
              rememberPacket(packet.timestampMicros, packet);
              try {
                current.decode(
                  new EncodedVideoChunk({
                    type: "key",
                    timestamp: packet.timestampMicros,
                    data: frame.data,
                  }),
                );
              } catch {
                recoverDecoder();
              }
              break;
            }
            case FRAME_DELTA: {
              const current = decoderOwner?.current ?? null;
              const packet = evidenceFor(
                frame,
                arrivedAtMs,
                (current?.decodeQueueSize ?? 0) + 1,
              );
              publishH264Packet(packet);
              if (
                current !== null &&
                current.state === "configured" &&
                shouldDropToKeyframe(current.decodeQueueSize)
              ) {
                publishResync(syncGate.droppedAccessUnit());
                break;
              }
              const decision = syncGate.acceptAccessUnit("delta", frame.data);
              if (decision.decode === null) break;
              if (current === null || current.state !== "configured") {
                publishResync(syncGate.droppedAccessUnit());
                break;
              }
              rememberPacket(packet.timestampMicros, packet);
              try {
                current.decode(
                  new EncodedVideoChunk({
                    type: "delta",
                    timestamp: packet.timestampMicros,
                    data: frame.data,
                  }),
                );
              } catch {
                recoverDecoder();
              }
              break;
            }
            case FRAME_DISCONTINUITY:
              publishDiscontinuity();
              break;
            default:
              break;
          }
        }
      }
    };

    const runMjpeg = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
      const parser = createMjpegParser();
      const admission = new MjpegAdmission(abort.signal);
      let firstArrival: number | null = null;
      await pullMjpegFrames({
        reader,
        admission,
        parse: (chunk) => {
          const arrivedAtMs = performance.now();
          firstArrival ??= arrivedAtMs;
          return parser.push(chunk).map((part) => ({ part, arrivedAtMs }));
        },
        decode: async ({ part, arrivedAtMs }, decoderQueue) => {
          if (disposed) return;
          frameIndex += 1;
          const packet = {
            sequence: frameIndex,
            sourcePtsMs: arrivedAtMs - firstArrival!,
            arrivedAtMs,
            bytes: part.jpeg.byteLength,
            decoderQueue,
          };
          publish(tracker.packet(packet), false);
          await decodeJpeg(part.jpeg, packet);
        },
        dropped: (count) => publish(tracker.statelessDrops(count), false),
      });
    };

    const run = async (): Promise<void> => {
      let response: Response;
      try {
        response = await fetch(url, { signal: abort.signal, cache: "no-store" });
      } catch {
        fail();
        return;
      }
      if (!response.ok || response.body === null) {
        fail();
        return;
      }
      const reader = response.body.getReader();
      try {
        if (codec === "h264") {
          await runH264(reader, response.headers.get("content-type"));
        } else {
          await runMjpeg(reader);
        }
        // A clean end is still an end: the caller advances the ladder rather
        // than showing a frozen last frame as if it were live.
        if (!disposed) fail();
      } catch {
        // An abort during teardown is ordinary; anything else is a dead stream,
        // and both mean the same thing to the caller.
        if (!abort.signal.aborted) fail();
      } finally {
        try {
          reader.cancel().catch(() => {});
        } catch {
          // Already gone.
        }
      }
    };

    void run();

    return () => {
      disposed = true;
      telemetryConfig.onSample(tracker.close().sample);
      abort.abort();
      decoderOwner?.close();
    };
  }, [
    url,
    codec,
    route,
    active,
    canvasRef,
    telemetryConfig.viewerId,
    telemetryConfig.deviceUdid,
    telemetryConfig.hostGeneration,
    telemetryConfig.qualityProfile,
    telemetryConfig.logicalWidth,
    telemetryConfig.logicalHeight,
    telemetryConfig.onSample,
  ]);

  return { frames, telemetry, failed };
}
