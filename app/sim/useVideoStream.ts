/**
 * H.264 into a canvas, via WebCodecs.
 *
 * The MJPEG path is an `<img>` and needs no code at all — the browser does the
 * fetching, the decoding and the painting. This one exists because that path
 * costs 3.55 MB/s and tops out around 14 fps: every frame is a whole JPEG,
 * encoded in software by CGImageDestination at the device's full resolution.
 * The same simulator under the same swipe loop delivers 24.9 fps at 200 KB/s
 * over H.264, because VideoToolbox encodes it in hardware and only sends what
 * changed.
 *
 * What that buys costs three things this file has to get right: a length-
 * prefixed stream to parse (`video-frames.ts`), a decoder to feed in order, and
 * a `VideoFrame` to close on every single path out. A leaked `VideoFrame` holds
 * a GPU surface, and the decoder stops delivering once enough of them pile up —
 * the failure looks exactly like a stalled stream, which is why `close()` is
 * unconditional here rather than in a happy path.
 */
import { useEffect, useRef, useState } from "react";
import {
  codecStringFrom,
  createFrameParser,
  FRAME_DELTA,
  FRAME_DESCRIPTION,
  FRAME_JPEG,
  FRAME_KEY,
} from "./video-frames";

/**
 * Whether this browser can decode what the capture host encodes.
 *
 * Deliberately not `await VideoDecoder.isConfigSupported(...)`: the real
 * configuration is not known until the `avcC` record arrives, and a probe with
 * a guessed one answers a different question. Presence is enough to justify
 * *trying* H.264; the source ladder handles it not working out.
 */
export function canDecodeH264(): boolean {
  return typeof globalThis.VideoDecoder === "function";
}

export interface VideoStreamState {
  /** Frames decoded and painted. The stall watchdog counts these. */
  frames: number;
  /** Set once the stream fails; the caller advances to the next source. */
  failed: boolean;
}

/**
 * Pull `url` and paint it into `canvas` until unmounted or aborted.
 *
 * Returns a frame counter rather than taking an `onFrame` callback: a counter
 * cannot be stale, and every consumer here wants "has anything arrived lately"
 * rather than the frame itself.
 */
export function useVideoStream(
  url: string | null,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  active: boolean,
): VideoStreamState {
  const [frames, setFrames] = useState(0);
  const [failed, setFailed] = useState(false);
  // Counted outside React so a burst of frames is one render, not thirty.
  const counter = useRef(0);

  useEffect(() => {
    setFailed(false);
    setFrames(0);
    counter.current = 0;
  }, [url]);

  useEffect(() => {
    if (url === null || !active) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const abort = new AbortController();
    let decoder: VideoDecoder | null = null;
    let disposed = false;
    // Monotonic and synthetic. The capture host sends no timestamps and the
    // decoder only needs them to be increasing.
    let timestamp = 0;
    let painting = false;

    const context = canvas.getContext("2d", { alpha: false });

    const publish = (): void => {
      counter.current += 1;
      // Coalesce: the watchdog needs to know frames are arriving, not how many.
      if (!painting) {
        painting = true;
        requestAnimationFrame(() => {
          painting = false;
          setFrames(counter.current);
        });
      }
    };

    const paint = (source: CanvasImageSource, width: number, height: number): void => {
      if (context === null) return;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.drawImage(source, 0, 0, width, height);
      publish();
    };

    const fail = (): void => {
      if (disposed) return;
      setFailed(true);
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

      const parser = createFrameParser();
      const reader = response.body.getReader();

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || disposed) break;
          if (value === undefined) continue;

          for (const frame of parser.push(value)) {
            if (disposed) break;
            switch (frame.type) {
              case FRAME_JPEG: {
                // The instant first paint, before the decoder is configured.
                // Copied because `createImageBitmap` is async and the parser's
                // buffer is reused the moment this loop continues.
                const blob = new Blob([frame.data.slice()], { type: "image/jpeg" });
                void createImageBitmap(blob)
                  .then((bitmap) => {
                    if (!disposed) paint(bitmap, bitmap.width, bitmap.height);
                    bitmap.close();
                  })
                  .catch(() => {
                    // A bootstrap frame that will not decode is not fatal; the
                    // H.264 frames behind it are the point.
                  });
                break;
              }
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
                        paint(videoFrame, videoFrame.displayWidth, videoFrame.displayHeight);
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
              case FRAME_KEY:
              case FRAME_DELTA: {
                if (decoder === null || decoder.state !== "configured") break;
                decoder.decode(
                  new EncodedVideoChunk({
                    type: frame.type === FRAME_KEY ? "key" : "delta",
                    timestamp: (timestamp += 1000),
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
      abort.abort();
      if (decoder !== null && decoder.state !== "closed") {
        try {
          decoder.close();
        } catch {
          // Closing a decoder that already errored throws; nothing to do.
        }
      }
    };
  }, [url, active, canvasRef]);

  return { frames, failed };
}
