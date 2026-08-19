/**
 * The pure half of the stream pipeline: every decision the renderer makes,
 * as functions a test can drive without a browser, a decoder or a simulator.
 *
 * Separated from `useStream` for exactly that reason — a hook is only as
 * testable as the DOM it needs, and the bugs that used to live here (a stalled
 * stream that was really a wedged decoder, a ladder rung that could never
 * work) were policy bugs, not DOM bugs.
 */

export interface ViewerLocation {
  protocol: string;
  hostname: string;
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * May this page reach the capture host's loopback port at all?
 *
 * The direct URLs are `http://127.0.0.1:<port>` — cleartext loopback. Two
 * viewers can never use them, and both used to be *discovered* by burning two
 * ladder rungs on guaranteed failures, on every stream, on every generation:
 *
 *  - an `https:` page blocks cleartext loopback as mixed content, and
 *  - a page on any other host is a remote viewer, whose `127.0.0.1` is the
 *    wrong machine entirely (the `bb connect` tunnel case).
 *
 * The page's own origin answers the question in advance, for free. A loopback
 * `http:` page is the only viewer the direct route was built for.
 */
export function viewerCanReachLoopback(location: ViewerLocation): boolean {
  if (location.protocol !== "http:") return false;
  return isLoopbackHost(location.hostname);
}

/** The current page's location, or "no direct route" outside a browser. */
export function currentViewerCanReachLoopback(): boolean {
  if (typeof window === "undefined") return false;
  return viewerCanReachLoopback(window.location);
}

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

// ---------------------------------------------------------------------------
// Decoder backpressure
// ---------------------------------------------------------------------------

/**
 * Pause reading from the network once this many chunks are queued for decode.
 *
 * The old pipeline read and decoded as fast as bytes arrived. When decoding
 * fell behind — a heavy scene, a busy machine, a software fallback — the
 * queue grew without bound until the decoder wedged, and a wedged decoder
 * looks exactly like a stalled stream. A `fetch` body is pull-based, so
 * backpressure is free: stop calling `read()` and TCP flow control slows the
 * encoder instead of filling this page's heap.
 */
export const DECODE_PAUSE_AT = 8;

/** Resume once the queue has drained to here. Hysteresis, not a hair trigger. */
export const DECODE_RESUME_AT = 3;

/**
 * Above this, decode keyframes only until the queue drains.
 *
 * A delta frame is only useful decoded in order; once the queue is this deep
 * the picture is already this many frames behind reality, and catching up by
 * decoding every late frame makes the lateness *worse*. Skipping to the next
 * keyframe is how live video trades smoothness for currency.
 */
export const DECODE_DROP_AT = 24;

export function shouldPauseForDecoder(queueSize: number): boolean {
  return queueSize > DECODE_PAUSE_AT;
}

export function shouldResumeDecoding(queueSize: number): boolean {
  return queueSize <= DECODE_RESUME_AT;
}

export function shouldDropToKeyframe(queueSize: number): boolean {
  return queueSize > DECODE_DROP_AT;
}

/**
 * A plausible monotonic timestamp for a frame, in microseconds.
 *
 * The capture host sends no timestamps and the decoder only needs them to be
 * increasing — but they used to increase by one *milli*second per frame, a
 * 1000 fps cadence that gives any jitter handling downstream nonsense to work
 * with. 33,333µs is 30 fps, close enough to the real cadence to be honest.
 */
export function timestampFor(frameIndex: number): number {
  return frameIndex * 33_333;
}
