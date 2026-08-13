/**
 * The security boundary.
 *
 * serve-sim's `GET /api` serves its `execToken` to any unauthenticated caller,
 * and `POST /exec` with that token runs arbitrary shell on the host. Loopback
 * is not a boundary under bb — `bb connect expose <port>` tunnels loopback
 * ports, and bb ships a builtin skill telling agents to run exactly that
 * whenever they have started a local HTTP server.
 *
 * `sim-host.mjs` takes its middleware as a parameter precisely so this suite
 * can mount a stub and assert the whole policy matrix on a Linux CI box with no
 * serve-sim, no simulator and no Mac.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import {
  createFilteredServer,
  isAllowed,
  isDenied,
  isWebSocketAllowed,
  scrubExecToken,
  SECRET_HEADER,
  secretMatches,
} from "../../sim-host.mjs";

const SECRET = "s".repeat(43);
const UDID = "11111111-2222-3333-4444-555555555555";

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
async function start(secret = SECRET): Promise<Harness> {
  const reached: string[] = [];
  const middleware = ((req: { url?: string }, res: { writeHead: (...a: unknown[]) => void; end: (b?: unknown) => void }) => {
    reached.push(req.url ?? "");
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

  const server = createFilteredServer(middleware, secret);
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

  it("lets the seven routes through with the secret", async () => {
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

  it("refuses a helper path whose UDID is not a UDID", () => {
    expect(isAllowed("GET", `/helper/${UDID}/config`)).toBe(true);
    expect(isAllowed("GET", "/helper/../../etc/passwd/config")).toBe(false);
    expect(isAllowed("GET", "/helper/anything/config")).toBe(false);
    // The method is part of the match: a GET must not reach a mutating route.
    expect(isAllowed("GET", "/grid/api/start")).toBe(false);
    expect(isAllowed("POST", "/grid/api/start")).toBe(true);
  });

  it("accepts the secret in the query string too", async () => {
    const harness = await start();
    const response = await fetch(`${harness.base}/helper/${UDID}/config?k=${SECRET}`, {});
    expect(response.status).toBe(200);
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

  it("is scrubbed wherever it appears in a JSON body", () => {
    expect(scrubExecToken('{"a":1,"execToken":"abc","b":2}')).toBe(
      '{"a":1,"execToken":"[redacted]","b":2}',
    );
    expect(scrubExecToken('{"execToken" : "with \\"escapes\\""}')).toBe('{"execToken":"[redacted]"}');
    expect(scrubExecToken('{"nothing":"here"}')).toBe('{"nothing":"here"}');
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
