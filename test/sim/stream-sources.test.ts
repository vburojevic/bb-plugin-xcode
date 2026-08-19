/**
 * The order the panel tries streams in.
 *
 * Ordering is a measurement, not a preference: H.264 ran 24.9 fps at 200 KB/s
 * where MJPEG managed 14.3 fps at 3.55 MB/s on the same device under the same
 * motion. So codec outranks route, and proxied H.264 beats direct MJPEG — most
 * visibly over a `bb connect` tunnel, where the 18× is bandwidth someone pays
 * for by the gigabyte.
 */
import { describe, expect, it } from "vitest";
import { describeSource, streamSources, withCodec } from "../../app/sim/stream-sources.js";

const DIRECT = "http://127.0.0.1:59505/helper/UDID/stream.mjpeg?k=tok&g=1";
const PROXIED = "/api/v1/plugins/xcode/http/stream?udid=UDID&g=1";

describe("the source ladder", () => {
  it("puts codec above route", () => {
    const sources = streamSources({ direct: DIRECT, proxied: PROXIED }, true);
    expect(sources.map((s) => `${s.codec}/${s.route}`)).toEqual([
      "h264/direct",
      "h264/proxied",
      "mjpeg/direct",
      "mjpeg/proxied",
    ]);
  });

  it("skips H.264 entirely without a decoder, rather than failing a rung to find out", () => {
    const sources = streamSources({ direct: DIRECT, proxied: PROXIED }, false);
    expect(sources.map((s) => `${s.codec}/${s.route}`)).toEqual(["mjpeg/direct", "mjpeg/proxied"]);
  });

  it("offers nothing when there is nothing to stream", () => {
    expect(streamSources({ direct: null, proxied: null }, true)).toEqual([]);
  });

  it("still has a full ladder when the capture host is unreachable", () => {
    // No direct URL is the remote case, and the proxy has to carry both codecs
    // there — it is the only route that exists.
    const sources = streamSources({ direct: null, proxied: PROXIED }, true);
    expect(sources.map((s) => `${s.codec}/${s.route}`)).toEqual(["h264/proxied", "mjpeg/proxied"]);
  });

  it("skips the direct rungs entirely when this page cannot reach loopback", () => {
    // A viewer over `bb connect` used to burn two guaranteed-failure fetches
    // per stream, per generation, finding this out. The page's origin answers
    // it in advance, so the doomed rungs are never offered.
    const sources = streamSources({ direct: DIRECT, proxied: PROXIED }, true, {
      directViable: false,
    });
    expect(sources.map((s) => `${s.codec}/${s.route}`)).toEqual(["h264/proxied", "mjpeg/proxied"]);
  });

  it("skips direct even without a decoder when the page cannot reach loopback", () => {
    const sources = streamSources({ direct: DIRECT, proxied: PROXIED }, false, {
      directViable: false,
    });
    expect(sources.map((s) => `${s.codec}/${s.route}`)).toEqual(["mjpeg/proxied"]);
  });

  it("names the codec the way each route expects it", () => {
    // Direct is the capture host's own path, where the codec is the extension.
    expect(withCodec(DIRECT, "h264", "direct")).toContain("/stream.avcc?");
    expect(withCodec(DIRECT, "h264", "direct")).not.toContain("stream.mjpeg");
    expect(withCodec(DIRECT, "mjpeg", "direct")).toBe(DIRECT);

    // Proxied takes it as a query parameter the plugin's own route reads.
    expect(withCodec(PROXIED, "h264", "proxied")).toBe(`${PROXIED}&codec=avcc`);
    expect(withCodec(PROXIED, "mjpeg", "proxied")).toBe(`${PROXIED}&codec=mjpeg`);
  });

  it("keeps the stream token on the direct H.264 URL", () => {
    // The token authorises both stream routes and nothing else; losing it in
    // the rewrite would 401 the fast path and silently demote everyone to JPEG.
    expect(withCodec(DIRECT, "h264", "direct")).toContain("k=tok");
  });

  it("says which path is in use, because a silent fallback is a mystery", () => {
    expect(describeSource({ codec: "h264", route: "direct", url: "" })).toBe("H.264, direct");
    expect(describeSource({ codec: "h264", route: "proxied", url: "" })).toBe("H.264");
    expect(describeSource({ codec: "mjpeg", route: "direct", url: "" })).toBe("MJPEG, direct");
    expect(describeSource(null)).toBeNull();
  });
});
