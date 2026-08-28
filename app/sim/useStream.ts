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
 * that remain are the honest ones — the parser (`video-frames` vs
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
import {
  shouldDropToKeyframe,
  shouldPauseForDecoder,
  shouldResumeDecoding,
  timestampFor,
} from "./stream-core";
import type { StreamSource } from "./stream-sources";
import {
  codecStringFrom,
  createFrameParser,
  FRAME_DELTA,
  FRAME_DESCRIPTION,
  FRAME_JPEG,
  FRAME_KEY,
} from "./video-frames";
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
    let decoder: VideoDecoder | null = null;
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
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(source, 0, 0, width, height);
      publish(
        tracker.paint({
          ...packet,
          paintedAtMs: performance.now(),
          paintedAtUnixMs: Date.now(),
          codedWidth: width,
          codedHeight: height,
          ...(surfaceId === undefined ? {} : { surfaceId }),
        }),
        true,
      );
    };

    /** A JPEG, through the ordered bitmap path. Shared by MJPEG parts and the
     * H.264 stream's bootstrap frame. */
    let pendingBitmaps = 0;
    const paintJpeg = (data: Uint8Array, packet: PacketEvent): void => {
      // Whole frames, dropped when the bitmap decoder can't keep up. Every
      // JPEG on either path is independently decodable, so losing one under
      // load costs a frame, not the stream — and an unbounded queue of pending
      // decodes is the same leak the H.264 backpressure exists to prevent.
      if (pendingBitmaps >= 4) return;
      pendingBitmaps += 1;
      const seq = ++paintSeq;
      const surfaceId = frameFingerprint(data);
      // Copied: `createImageBitmap` is async and the parser's buffer is
      // reused the moment this loop continues.
      const blob = new Blob([data.slice()], { type: "image/jpeg" });
      void createImageBitmap(blob)
        .then((bitmap) => {
          pendingBitmaps -= 1;
          if (disposed || seq !== paintSeq) {
            // Stale before it resolved: a newer frame already owns the canvas.
            bitmap.close();
            return;
          }
          paint(bitmap, bitmap.width, bitmap.height, packet, surfaceId);
          bitmap.close();
        })
        .catch(() => {
          pendingBitmaps -= 1;
          // One undecodable frame is not fatal; the ones behind it are the point.
        });
    };

    const fail = (): void => {
      if (disposed) return;
      publish(tracker.failure(), false);
      setFailed(true);
    };

    publish(tracker.configure(), false);

    /**
     * Wait until the decoder queue has drained.
     *
     * `dequeue` fires as the queue empties; the interval is the fallback for
     * implementations that never fire it. Either way this resolves, because a
     * backpressure wait that can hang is a stall detector's worst false alarm.
     */
    const waitForDecoderDrain = (): Promise<void> =>
      new Promise<void>((resolve) => {
        const current = decoder;
        if (current === null) {
          resolve();
          return;
        }
        const check = (): void => {
          if (disposed || decoder !== current || shouldResumeDecoding(current.decodeQueueSize)) {
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

    const runH264 = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
      const parser = createFrameParser();
      // When the queue is this deep, decode keyframes only until it drains.
      let dropping = false;
      const packetsByTimestamp = new Map<number, PacketEvent>();

      for (;;) {
        // Backpressure before more bytes: the body is pull-based, so not
        // reading is what slows the encoder down.
        while (
          !disposed &&
          decoder !== null &&
          decoder.state === "configured" &&
          shouldPauseForDecoder(decoder.decodeQueueSize)
        ) {
          await waitForDecoderDrain();
        }

        const { done, value } = await reader.read();
        if (done || disposed) return;
        if (value === undefined) continue;
        const arrivedAtMs = performance.now();

        for (const frame of parser.push(value)) {
          if (disposed) return;
          switch (frame.type) {
            case FRAME_JPEG:
              // The instant first paint, before the decoder is configured.
              frameIndex += 1;
              {
                const sourcePtsMs = timestampFor(frameIndex) / 1000;
                const packet = {
                  sequence: frameIndex,
                  sourcePtsMs,
                  arrivedAtMs,
                  bytes: frame.data.byteLength,
                  decoderQueue: pendingBitmaps + 1,
                };
                publish(tracker.packet(packet), false);
                paintJpeg(frame.data, packet);
              }
              break;
            case FRAME_DESCRIPTION: {
              const codec = codecStringFrom(frame.data);
              if (codec === null) {
                fail();
                return;
              }
              decoder = new VideoDecoder({
                output: (videoFrame) => {
                  try {
                    if (!disposed) {
                      // Decoder output is ordered by construction; only the
                      // sequence guard against bitmaps is needed, and bitmaps
                      // always lose once the decoder owns the canvas.
                      paintSeq += 1;
                      const packet = packetsByTimestamp.get(videoFrame.timestamp);
                      if (packet !== undefined) {
                        packetsByTimestamp.delete(videoFrame.timestamp);
                        paint(videoFrame, videoFrame.displayWidth, videoFrame.displayHeight, packet);
                      }
                    }
                  } finally {
                    // Unconditional: a leaked VideoFrame holds a GPU surface
                    // and the decoder stops once enough accumulate.
                    videoFrame.close();
                  }
                },
                error: fail,
              });
              decoder.configure({
                codec,
                description: frame.data.slice(),
                optimizeForLatency: true,
              });
              break;
            }
            case FRAME_KEY: {
              if (decoder === null || decoder.state !== "configured") break;
              const nextDropping = shouldDropToKeyframe(decoder.decodeQueueSize);
              if (!dropping && nextDropping) publish(tracker.resync(), false);
              dropping = nextDropping;
              frameIndex += 1;
              const timestamp = timestampFor(frameIndex);
              const packet = {
                sequence: frameIndex,
                sourcePtsMs: timestamp / 1000,
                arrivedAtMs,
                bytes: frame.data.byteLength,
                decoderQueue: decoder.decodeQueueSize + 1,
              };
              packetsByTimestamp.set(timestamp, packet);
              if (packetsByTimestamp.size > 64) {
                const oldest = packetsByTimestamp.keys().next().value as number | undefined;
                if (oldest !== undefined) packetsByTimestamp.delete(oldest);
              }
              publish(tracker.packet(packet), false);
              decoder.decode(
                new EncodedVideoChunk({
                  type: "key",
                  timestamp,
                  data: frame.data.slice(),
                }),
              );
              break;
            }
            case FRAME_DELTA: {
              if (decoder === null || decoder.state !== "configured") break;
              frameIndex += 1;
              const timestamp = timestampFor(frameIndex);
              const packet = {
                sequence: frameIndex,
                sourcePtsMs: timestamp / 1000,
                arrivedAtMs,
                bytes: frame.data.byteLength,
                decoderQueue: decoder.decodeQueueSize + 1,
              };
              publish(tracker.packet(packet), false);
              if (dropping && shouldDropToKeyframe(decoder.decodeQueueSize)) break;
              dropping = false;
              packetsByTimestamp.set(timestamp, packet);
              if (packetsByTimestamp.size > 64) {
                const oldest = packetsByTimestamp.keys().next().value as number | undefined;
                if (oldest !== undefined) packetsByTimestamp.delete(oldest);
              }
              decoder.decode(
                new EncodedVideoChunk({
                  type: "delta",
                  timestamp,
                  data: frame.data.slice(),
                }),
              );
              break;
            }
            default:
              break;
          }
        }
      }
    };

    const runMjpeg = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
      const parser = createMjpegParser();
      let firstArrival: number | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done || disposed) return;
        if (value === undefined) continue;
        const arrivedAtMs = performance.now();
        firstArrival ??= arrivedAtMs;
        for (const part of parser.push(value)) {
          if (disposed) return;
          frameIndex += 1;
          const packet = {
            sequence: frameIndex,
            sourcePtsMs: arrivedAtMs - firstArrival,
            arrivedAtMs,
            bytes: part.jpeg.byteLength,
            decoderQueue: pendingBitmaps + 1,
          };
          publish(tracker.packet(packet), false);
          paintJpeg(part.jpeg, packet);
        }
      }
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
        if (codec === "h264") await runH264(reader);
        else await runMjpeg(reader);
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
      if (decoder !== null && decoder.state !== "closed") {
        try {
          decoder.close();
        } catch {
          // Closing a decoder that already errored throws; nothing to do.
        }
      }
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
