/**
 * The security boundary.
 *
 * serve-sim's `GET /api` serves its `execToken` to any unauthenticated caller,
 * and `POST /exec` with that token runs arbitrary shell on the host. Loopback
 * limits network reachability but is not authentication against another
 * process running as the same OS user, which can forward a local port.
 *
 * `sim-host.mjs` takes its middleware as a parameter precisely so this suite
 * can mount a stub and assert the whole policy matrix on a Linux CI box with no
 * serve-sim, no simulator and no Mac.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import {
  authorize,
  createFilteredServer,
  isAllowed,
  isDenied,
  isStreamRoute,
  isWebSocketAllowed,
  MAX_SCRUBBED_JSON_BYTES,
  scrubExecToken,
  SECRET_HEADER,
  secretMatches,
} from "../../sim-host.mjs";
import { deriveStreamCapability } from "../../src/sim/stream-token.js";

const SECRET = "s".repeat(43);
const UDID = "11111111-2222-3333-4444-555555555555";
const INTERNAL_AVCC_HEADER = "x-xcode-simulators-internal-avcc";
const AVCC_DESCRIPTION = Buffer.from([1, 100, 0, 51, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68]);

function v1Frame(kind: number, payload: Buffer): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame.writeUInt32BE(1 + payload.byteLength, 0);
  frame[4] = kind;
  payload.copy(frame, 5);
  return frame;
}

interface Harness {
  base: string;
  reached: string[];
  close: () => Promise<void>;
}

const open: Harness[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((harness) => harness.close()));
});

/**
 * A stub middleware that records what got through and answers with a body
 * containing an `execToken`, so the scrub is exercised on a real response.
 */
async function start(
  secret = SECRET,
  streamToken: string | null = null,
  respond?: (res: {
    writeHead: (...a: unknown[]) => void;
    setHeader: (name: string, value: string | number) => void;
    write: (b: unknown) => boolean;
    end: (b?: unknown) => void;
  }, req: { url?: string; headers: Record<string, string | string[] | undefined> }) => void,
  options: { internalKey?: string } = {},
): Promise<Harness> {
  const reached: string[] = [];
  const middleware = ((
    req: { url?: string },
    res: {
      writeHead: (...a: unknown[]) => void;
      setHeader: (name: string, value: string | number) => void;
      write: (b: unknown) => boolean;
      end: (b?: unknown) => void;
    },
  ) => {
    reached.push(req.url ?? "");
    if (respond) {
      respond(res, req as { url?: string; headers: Record<string, string | string[] | undefined> });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, execToken: "super-secret-token" }));
  }) as unknown as Parameters<typeof createFilteredServer>[0];
  (middleware as unknown as { handleUpgrade: unknown }).handleUpgrade = (
    _req: unknown,
    socket: { end: (data: string) => void },
  ) => {
    reached.push("UPGRADE");
    socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n");
  };

  const create = createFilteredServer as unknown as (
    injected: unknown,
    master: string,
    onError: (error: unknown) => void,
    key: string | null,
    rawOptions: { internalKey?: string },
  ) => import("node:http").Server;
  const server = create(middleware, secret, () => {}, streamToken, options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const harness: Harness = {
    base: `http://127.0.0.1:${port}`,
    reached,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  open.push(harness);
  return harness;
}

describe("the deny list", () => {
  it("404s the shell-execution routes with and without the secret", async () => {
    const harness = await start();
    for (const path of ["/exec", "/exec/", "/exec-ws", "/devtools", "/devtools/release", "/devtools-frontend/x"]) {
      const anonymous = await fetch(`${harness.base}${path}`, { method: "POST" });
      const authenticated = await fetch(`${harness.base}${path}`, {
        method: "POST",
        headers: { [SECRET_HEADER]: SECRET },
      });
      expect(anonymous.status, `${path} unauthenticated`).toBe(404);
      expect(authenticated.status, `${path} authenticated`).toBe(404);
    }
    // Nothing reached the middleware at all.
    expect(harness.reached).toEqual([]);
  });

  it("recognises them as denied regardless of the allowlist", () => {
    expect(isDenied("/exec")).toBe(true);
    expect(isDenied("/exec-ws")).toBe(true);
    expect(isDenied("/devtools")).toBe(true);
    expect(isDenied("/helper/x/config")).toBe(false);
  });
});

describe("the allow list", () => {
  it("404s every serve-sim route the plugin does not use", async () => {
    const harness = await start();
    for (const path of ["/", "/api", "/api/events", "/grid/api", "/appstate", "/ax", "/api/event-log"]) {
      const response = await fetch(`${harness.base}${path}`, {
        headers: { [SECRET_HEADER]: SECRET },
      });
      expect(response.status, path).toBe(404);
    }
    expect(harness.reached).toEqual([]);
  });

  it("401s an allowed route presented without the secret", async () => {
    const harness = await start();
    const response = await fetch(`${harness.base}/helper/${UDID}/config`);
    expect(response.status).toBe(401);
    expect(harness.reached).toEqual([]);
  });

  it("401s an allowed route presented with the wrong secret", async () => {
    const harness = await start();
    const response = await fetch(`${harness.base}/helper/${UDID}/config`, {
      headers: { [SECRET_HEADER]: "x".repeat(43) },
    });
    expect(response.status).toBe(401);
  });

  it("lets the seven middleware routes through with the secret", async () => {
    const harness = await start();
    const paths = [
      `/helper/${UDID}/stream.mjpeg`,
      `/helper/${UDID}/config`,
      `/helper/${UDID}/health`,
      `/helper/${UDID}/ax`,
      `/helper/${UDID}/foreground`,
    ];
    for (const path of paths) {
      const response = await fetch(`${harness.base}${path}`, {
        headers: { [SECRET_HEADER]: SECRET },
      });
      expect(response.status, path).toBe(200);
    }
    for (const path of ["/grid/api/start", "/grid/api/shutdown"]) {
      const response = await fetch(`${harness.base}${path}`, {
        method: "POST",
        headers: { [SECRET_HEADER]: SECRET, "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status, path).toBe(200);
    }
    expect(harness.reached).toHaveLength(7);
  });

  it("keeps stream status master-header-only and outside serve-sim", async () => {
    const streamKey = "v".repeat(43);
    const harness = await start(SECRET, streamKey);
    const capability = deriveStreamCapability(streamKey, UDID);

    const anonymous = await fetch(`${harness.base}/helper/${UDID}/stream-status`);
    const streamOnly = await fetch(`${harness.base}/helper/${UDID}/stream-status?k=${capability}`);
    const master = await fetch(`${harness.base}/helper/${UDID}/stream-status`, {
      headers: { [SECRET_HEADER]: SECRET },
    });

    expect(anonymous.status).toBe(401);
    expect(streamOnly.status).toBe(401);
    expect(master.status).toBe(200);
    expect(await master.json()).toEqual({
      viewers: 0,
      upstreamEncoders: 0,
      generation: 0,
      restarts: 0,
      slowViewerDrops: 0,
      lastPacketAgeMs: null,
    });
    expect(harness.reached).toEqual([]);
  });

  it("refuses a helper path whose UDID is not a UDID", () => {
    expect(isAllowed("GET", `/helper/${UDID}/config`)).toBe(true);
    expect(isAllowed("GET", "/helper/../../etc/passwd/config")).toBe(false);
    expect(isAllowed("GET", "/helper/anything/config")).toBe(false);
    // The method is part of the match: a GET must not reach a mutating route.
    expect(isAllowed("GET", "/grid/api/start")).toBe(false);
    expect(isAllowed("POST", "/grid/api/start")).toBe(true);
  });

  it("never accepts the master secret in a query string", async () => {
    const harness = await start();
    const response = await fetch(`${harness.base}/helper/${UDID}/config?k=${SECRET}`, {});
    expect(response.status).toBe(401);
  });

  it("accepts a device-derived capability on both pixel codecs and nowhere else", async () => {
    const streamKey = "v".repeat(43);
    const capability = deriveStreamCapability(streamKey, UDID);
    const other = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    const harness = await start(SECRET, streamKey, (res, req) => {
      if (req.url?.startsWith(`/helper/${UDID}/stream.avcc`)) {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        const description = v1Frame(1, AVCC_DESCRIPTION);
        const idr = v1Frame(2, Buffer.from([0, 0, 0, 2, 0x65, 0x88]));
        res.write(Buffer.concat([description, idr]));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("pixel");
    });
    const mjpeg = await fetch(`${harness.base}/helper/${UDID}/stream.mjpeg?k=${capability}`);
    const avccController = new AbortController();
    const avcc = await fetch(`${harness.base}/helper/${UDID}/stream.avcc?k=${capability}`, {
      signal: avccController.signal,
    });

    expect(mjpeg.status).toBe(200);
    expect(avcc.status).toBe(200);
    expect(avcc.headers.get("content-type")).toBe("application/vnd.bb.sim-avcc;version=2");
    expect((await fetch(`${harness.base}/helper/${other}/stream.mjpeg?k=${capability}`)).status).toBe(401);
    for (const path of [
      `/helper/${UDID}/config`,
      `/helper/${UDID}/health`,
      `/helper/${UDID}/ax`,
      `/helper/${UDID}/foreground`,
      `/helper/${UDID}/stream-status`,
    ]) {
      expect((await fetch(`${harness.base}${path}?k=${capability}`)).status, path).toBe(401);
    }
    for (const path of ["/grid/api/start", "/grid/api/shutdown"]) {
      expect((await fetch(`${harness.base}${path}?k=${capability}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ udid: UDID }),
      })).status, path).toBe(401);
    }
    avccController.abort();
  });

  it("lets the private internal header reach only the exact AVCC middleware branch", async () => {
    const internalKey = "internal-key-known-only-to-this-test";
    const harness = await start(SECRET, null, (res) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("internal");
    }, { internalKey });
    const headers = { [INTERNAL_AVCC_HEADER]: internalKey };

    expect((await fetch(`${harness.base}/helper/${UDID}/stream.avcc`, { headers })).status).toBe(200);
    expect((await fetch(`${harness.base}/helper/${UDID}/stream.mjpeg`, { headers })).status).toBe(401);
    expect((await fetch(`${harness.base}/helper/${UDID}/config`, { headers })).status).toBe(401);
    expect((await fetch(`${harness.base}/exec`, { headers })).status).toBe(404);
    expect((await fetch(`${harness.base}/exec-ws`, { headers })).status).toBe(404);
    expect((await fetch(`${harness.base}/devtools`, { headers })).status).toBe(404);
    expect(harness.reached).toEqual([`/helper/${UDID}/stream.avcc`]);
  });

  it("caps direct and proxied pixel responses across both codecs at four", async () => {
    const streamKey = "v".repeat(43);
    const capability = deriveStreamCapability(streamKey, UDID);
    const harness = await start(SECRET, streamKey, (res, req) => {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      if (req.url?.startsWith(`/helper/${UDID}/stream.avcc`)) {
        res.write(v1Frame(1, AVCC_DESCRIPTION));
      } else {
        res.write("pixel");
      }
    });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const requests = [
      fetch(`${harness.base}/helper/${UDID}/stream.avcc?k=${capability}`, { signal: controllers[0]!.signal }),
      fetch(`${harness.base}/helper/${UDID}/stream.mjpeg?k=${capability}`, { signal: controllers[1]!.signal }),
      fetch(`${harness.base}/helper/${UDID}/stream.mjpeg`, {
        headers: { [SECRET_HEADER]: SECRET },
        signal: controllers[2]!.signal,
      }),
      fetch(`${harness.base}/helper/${UDID}/stream.mjpeg`, {
        headers: { [SECRET_HEADER]: SECRET },
        signal: controllers[3]!.signal,
      }),
    ];
    expect((await Promise.all(requests)).map((response) => response.status)).toEqual([200, 200, 200, 200]);
    expect((await fetch(`${harness.base}/helper/${UDID}/stream.mjpeg?k=${capability}`)).status).toBe(503);

    controllers[1]!.abort();
    await new Promise((resolve) => setImmediate(resolve));
    const replacement = new AbortController();
    expect((await fetch(`${harness.base}/helper/${UDID}/stream.mjpeg?k=${capability}`, {
      signal: replacement.signal,
    })).status).toBe(200);
    replacement.abort();
    for (const controller of controllers) controller.abort();
  });

  it("bounds and types control request bodies before middleware", async () => {
    const harness = await start();
    const wrongType = await fetch(`${harness.base}/grid/api/start`, {
      method: "POST",
      headers: { [SECRET_HEADER]: SECRET, "content-type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);
    const tooLarge = await fetch(`${harness.base}/grid/api/start`, {
      method: "POST",
      headers: { [SECRET_HEADER]: SECRET, "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(5000) }),
    });
    expect(tooLarge.status).toBe(413);
    expect(harness.reached).toEqual([]);
  });
});

describe("execToken", () => {
  it("never reaches a caller, even from a route we do forward", async () => {
    const harness = await start();
    const response = await fetch(`${harness.base}/helper/${UDID}/config`, {
      headers: { [SECRET_HEADER]: SECRET },
    });
    const body = await response.text();
    expect(body).not.toContain("super-secret-token");
    expect(body).toContain("[redacted]");
  });

  it("scrubs JSON whose headers were set before writeHead", async () => {
    const original = JSON.stringify({ ok: true, execToken: "super-secret-token" });
    const harness = await start(SECRET, null, (res) => {
      res.setHeader("Content-Type", "Application/JSON; charset=utf-8");
      res.setHeader("Content-Length", Buffer.byteLength(original));
      res.writeHead(200);
      res.end(original);
    });
    const response = await fetch(`${harness.base}/helper/${UDID}/config`, {
      headers: { [SECRET_HEADER]: SECRET },
    });
    const body = await response.text();
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("super-secret-token");
    expect(response.headers.get("content-length")).not.toBe(String(Buffer.byteLength(original)));
  });

  it("scrubs JSON when Node sends headers implicitly from end", async () => {
    const original = JSON.stringify({ ok: true, execToken: "super-secret-token" });
    const harness = await start(SECRET, null, (res) => {
      res.setHeader("Content-Length", Buffer.byteLength(original));
      res.setHeader("Content-Type", "application/json");
      res.end(original);
    });
    const response = await fetch(`${harness.base}/helper/${UDID}/config`, {
      headers: { [SECRET_HEADER]: SECRET },
    });
    const body = await response.text();
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("super-secret-token");
    expect(response.headers.get("content-length")).not.toBe(String(Buffer.byteLength(original)));
  });

  it("scrubs JSON and repairs lengths from raw-array response headers", async () => {
    const original = JSON.stringify({ ok: true, execToken: "super-secret-token" });
    const harness = await start(SECRET, null, (res) => {
      res.writeHead(200, [
        "Content-Type",
        "application/problem+json; charset=utf-8",
        "Content-Length",
        String(Buffer.byteLength(original)),
      ]);
      res.end(original);
    });
    const response = await fetch(`${harness.base}/helper/${UDID}/config`, {
      headers: { [SECRET_HEADER]: SECRET },
    });
    const body = await response.text();
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("super-secret-token");
    expect(response.headers.get("content-length")).not.toBe(String(Buffer.byteLength(original)));
  });

  it("destroys an oversized buffered JSON response", async () => {
    const harness = await start(SECRET, null, (res) => {
      res.setHeader("Content-Type", "application/json");
      res.write(Buffer.alloc(MAX_SCRUBBED_JSON_BYTES + 1));
      res.end();
    });
    await expect(
      fetch(`${harness.base}/helper/${UDID}/config`, {
        headers: { [SECRET_HEADER]: SECRET },
      }),
    ).rejects.toThrow();
  });

  it("is scrubbed wherever it appears in a JSON body", () => {
    expect(scrubExecToken('{"a":1,"execToken":"abc","b":2}')).toBe(
      '{"a":1,"execToken":"[redacted]","b":2}',
    );
    expect(scrubExecToken('{"execToken" : "with \\"escapes\\""}')).toBe('{"execToken":"[redacted]"}');
    expect(scrubExecToken('{"nothing":"here"}')).toBe('{"nothing":"here"}');
  });
});

describe("middleware containment", () => {
  it("turns a synchronous middleware throw into a request failure", async () => {
    const harness = await start(SECRET, null, () => {
      throw new Error("synchronous middleware failure");
    });
    const response = await fetch(`${harness.base}/helper/${UDID}/config`, {
      headers: { [SECRET_HEADER]: SECRET },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Capture host error");
  });
});

describe("the websocket upgrade", () => {
  it("only allows the device control socket, and only with the secret", async () => {
    expect(isWebSocketAllowed(`/helper/${UDID}/ws`)).toBe(true);
    expect(isWebSocketAllowed("/exec-ws")).toBe(false);
    expect(isWebSocketAllowed(`/helper/${UDID}/stream.mjpeg`)).toBe(false);

    const harness = await start();
    const rejected = await upgradeStatus(`${harness.base.replace("http", "ws")}/helper/${UDID}/ws`);
    expect(rejected).toBe(401);
    expect(harness.reached).toEqual([]);

    const accepted = await upgradeStatus(
      `${harness.base.replace("http", "ws")}/helper/${UDID}/ws`,
      SECRET,
    );
    // The stub answers 101 with no accept key, so `ws` reports a protocol
    // error — but the request reached the middleware, which is the assertion.
    expect(accepted).not.toBe(401);
    expect(harness.reached).toEqual(["UPGRADE"]);
  });

  it("404s an exec socket upgrade even with the secret", async () => {
    const harness = await start();
    const status = await upgradeStatus(`${harness.base.replace("http", "ws")}/exec-ws`, SECRET);
    expect(status).toBe(404);
    expect(harness.reached).toEqual([]);
  });

  it("never accepts the master, root stream key, or derived capability from a websocket query", async () => {
    const streamToken = "v".repeat(43);
    const capability = deriveStreamCapability(streamToken, UDID);
    const harness = await start(SECRET, streamToken);
    expect(
      await upgradeStatus(`${harness.base.replace("http", "ws")}/helper/${UDID}/ws?k=${SECRET}`),
    ).toBe(401);
    expect(
      await upgradeStatus(`${harness.base.replace("http", "ws")}/helper/${UDID}/ws?k=${streamToken}`),
    ).toBe(401);
    expect(
      await upgradeStatus(`${harness.base.replace("http", "ws")}/helper/${UDID}/ws?k=${capability}`),
    ).toBe(401);
    expect(harness.reached).toEqual([]);
  });
});

function upgradeStatus(url: string, secret?: string): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, {
      headers: secret === undefined ? {} : { [SECRET_HEADER]: secret },
    });
    const done = (value: number | null): void => {
      try {
        socket.terminate();
      } catch {
        // Already gone.
      }
      resolve(value);
    };
    socket.on("unexpected-response", (_request, response) => done(response.statusCode ?? null));
    socket.on("open", () => done(101));
    socket.on("error", () => done(null));
    setTimeout(() => done(null), 3000).unref?.();
  });
}

describe("secret comparison", () => {
  it("is length-safe and value-exact", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches("", SECRET)).toBe(false);
    expect(secretMatches("short", SECRET)).toBe(false);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretMatches(null as unknown as string, SECRET)).toBe(false);
  });
});


describe("the stream capability", () => {
  const MASTER = "m".repeat(43);
  const STREAM = "s".repeat(43);
  const STREAM_PATH = `/helper/${UDID}/stream.mjpeg`;
  const CAPABILITY = deriveStreamCapability(STREAM, UDID);

  it("opens the MJPEG route and refuses every other one", () => {
    // The whole reason it exists: this token travels in a query string, where
    // it lands in the DOM, so a URL that leaks must buy "watch" and not "drive".
    expect(
      authorize({ path: STREAM_PATH, header: null, query: CAPABILITY, secret: MASTER, streamToken: STREAM }),
    ).toBe(true);

    for (const path of [
      `/helper/${UDID}/ws`,
      `/helper/${UDID}/ax`,
      `/helper/${UDID}/config`,
      `/helper/${UDID}/foreground`,
      "/grid/api/shutdown",
    ]) {
      expect(
        authorize({ path, header: null, query: CAPABILITY, secret: MASTER, streamToken: STREAM }),
        path,
      ).toBe(false);
    }
  });

  it("leaves the master secret opening everything", () => {
    for (const path of [STREAM_PATH, `/helper/${UDID}/ws`, "/grid/api/shutdown"]) {
      expect(
        authorize({ path, header: MASTER, query: null, secret: MASTER, streamToken: STREAM }),
        path,
      ).toBe(true);
    }
  });

  it("refuses everything when no stream token was issued", () => {
    // An older supervisor spawns the host without one. Direct streaming is
    // simply unavailable then; it must not become unauthenticated.
    expect(
      authorize({ path: STREAM_PATH, header: null, query: STREAM, secret: MASTER, streamToken: null }),
    ).toBe(false);
    expect(authorize({ path: STREAM_PATH, header: null, query: "", secret: MASTER, streamToken: "" })).toBe(
      false,
    );
  });

  it("recognises only the exact stream paths", () => {
    expect(isStreamRoute(STREAM_PATH)).toBe(true);
    // H.264 is the fast path and the same kind of secret: pixels, not control.
    expect(isStreamRoute(`/helper/${UDID}/stream.avcc`)).toBe(true);
    expect(isStreamRoute(`/helper/${UDID}/stream.hevc`)).toBe(false);
    expect(isStreamRoute(`/helper/${UDID}/stream.mjpeg/../ws`)).toBe(false);
    expect(isStreamRoute(`/helper/${UDID}/streamXmjpeg`)).toBe(false);
    expect(isStreamRoute("/exec")).toBe(false);
  });
});
