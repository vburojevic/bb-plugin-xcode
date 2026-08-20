/**
 * Which stream to try, and in what order.
 *
 * Two independent questions — H.264 or JPEG, direct or proxied — and both now
 * answered **before** a connection is opened, where they used to be answered
 * by burning a rung on a guaranteed failure:
 *
 *  - **Codec.** H.264 needs WebCodecs in this browser, which is a synchronous
 *    fact (`canDecodeH264`). Whether the host's hardware can *encode* it is
 *    the one thing still learned by trying — a failed rung advances the
 *    ladder, and the meta line says which rung won.
 *  - **Route.** Direct needs the viewer to be a loopback `http:` page —
 *    `viewerCanReachLoopback`, a fact about this page's own origin. An
 *    `https:` page blocks cleartext loopback as mixed content, and a page on
 *    another host (every remote bb panel) has the wrong `127.0.0.1`
 *    entirely. Both used to be discovered per stream, per generation, two
 *    doomed fetches at a time.
 *
 * Ordering is by measured cost, most preferred first — on the machine it was
 * measured on, under the same swipe loop, H.264 ran 24.9 fps at 200 KB/s where
 * MJPEG managed 14.3 fps at 3.55 MB/s, so codec dominates route: proxied
 * H.264 beats direct MJPEG, and by a lot over a remote connection.
 */

export type StreamCodec = "h264" | "mjpeg";
export type StreamRoute = "direct" | "proxied";

export interface StreamSource {
  codec: StreamCodec;
  route: StreamRoute;
  url: string;
}

export interface StreamUrls {
  /** Loopback, token-scoped. `null` when the capture host is not up. */
  direct: string | null;
  /** Same-origin, through the plugin. `null` when there is nothing to stream. */
  proxied: string | null;
}

export interface StreamSourceOptions {
  /**
   * Whether this page may use the direct URLs at all — see
   * `viewerCanReachLoopback`. Default true, because a test with no opinion
   * about origins should see the full ladder.
   */
  directViable?: boolean;
}

/**
 * The proxied route takes the codec as a query parameter; the direct one is the
 * capture host's own path, where the codec *is* the extension.
 */
export function withCodec(url: string, codec: StreamCodec, route: StreamRoute): string {
  if (route === "direct") {
    return codec === "h264" ? url.replace("/stream.mjpeg?", "/stream.avcc?") : url;
  }
  return `${url}&codec=${codec === "h264" ? "avcc" : "mjpeg"}`;
}

/**
 * The candidates, best first.
 *
 * `canDecodeH264` is the caller's answer to "does this browser have a usable
 * `VideoDecoder`". When it is false the H.264 rungs are not attempted at all —
 * a fallback that always fails is a fallback that always costs a round trip.
 * The same goes for `directViable`: a route that cannot work is not a rung.
 */
export function streamSources(
  urls: StreamUrls,
  canDecodeH264: boolean,
  options: StreamSourceOptions = {},
): StreamSource[] {
  const directViable = options.directViable ?? true;
  const out: StreamSource[] = [];
  const add = (codec: StreamCodec, route: StreamRoute, base: string | null): void => {
    if (base === null) return;
    if (route === "direct" && !directViable) return;
    out.push({ codec, route, url: withCodec(base, codec, route) });
  };

  if (canDecodeH264) {
    add("h264", "direct", urls.direct);
    add("h264", "proxied", urls.proxied);
  }
  add("mjpeg", "direct", urls.direct);
  add("mjpeg", "proxied", urls.proxied);
  return out;
}

/** A short label for the meta line, so the path in use is never a mystery. */
export function describeSource(source: StreamSource | null): string | null {
  if (source === null) return null;
  const codec = source.codec === "h264" ? "H.264" : "MJPEG";
  return source.route === "direct" ? `${codec}, direct` : codec;
}
