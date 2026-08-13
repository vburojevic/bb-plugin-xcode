/**
 * Which stream to try, and in what order.
 *
 * Four combinations of two independent questions — H.264 or JPEG, direct or
 * proxied — and no way to answer either one in advance:
 *
 *  - **Codec.** H.264 needs WebCodecs *and* a host whose hardware can encode
 *    it. serve-sim ships the MJPEG path precisely because some cannot (VMs
 *    without the H.264 profiles), and the only way to find out is to ask.
 *  - **Route.** Direct needs the viewer to be on the same machine as the
 *    capture host. The server cannot know where its own panel is rendered, and
 *    a panel reached over a `bb connect` tunnel additionally gets its loopback
 *    image blocked as mixed content.
 *
 * So the panel walks the list until something delivers a frame. Ordering is by
 * measured cost, most preferred first — on this machine, under the same swipe
 * loop, H.264 ran 24.9 fps at 200 KB/s where MJPEG managed 14.3 fps at
 * 3.55 MB/s, so codec dominates route: proxied H.264 beats direct MJPEG, and by
 * a lot over a tunnel where that 18× is bandwidth someone is paying for.
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
 */
export function streamSources(urls: StreamUrls, canDecodeH264: boolean): StreamSource[] {
  const out: StreamSource[] = [];
  const add = (codec: StreamCodec, route: StreamRoute, base: string | null): void => {
    if (base === null) return;
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
