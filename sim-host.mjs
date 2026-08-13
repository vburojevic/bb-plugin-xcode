/**
 * The capture host: a child process that mounts serve-sim's middleware behind
 * an allowlist and an auth filter.
 *
 * SHIPS RAW AND UNBUNDLED. `bb plugin build` inlines every third-party
 * dependency into `dist/server.js`, and serve-sim resolves its native addon
 * from `import.meta.url`-relative paths — inlining it would break that. Nothing
 * the bundled server statically imports may reach `serve-sim/middleware` except
 * as `import type`.
 *
 * ## Why a child process at all
 *
 * `simMiddleware` embeds cleanly in-process and mounting it in bb's own event
 * loop is about fifteen lines. Do not. `DeviceSession.start()`, `handleMjpeg()`
 * and `handleAvcc()` each launch a bare `(async () => { … })()` with no
 * `.catch`, and inside the bb server a rejection there is an
 * `uncaughtException` that takes bb down rather than the plugin. A child
 * process converts a fatal bug into a restart. It also gives the auth filter
 * somewhere to live.
 *
 * ## Why an allowlist rather than a denylist
 *
 * serve-sim's `GET /api` serves its `execToken` to any unauthenticated caller,
 * and `POST /exec` with that token runs arbitrary shell on the host — its
 * `Origin` check does not apply to a caller that sends no `Origin` at all.
 * Loopback is not a boundary under bb: `bb connect expose <port>` tunnels
 * loopback ports, and bb ships a builtin skill telling agents to run exactly
 * that whenever they have started a local HTTP server. So this file serves the
 * seven routes the plugin actually uses and 404s everything else, which makes
 * the escalation unreachable rather than merely gated.
 *
 * Everything above the `main()` at the bottom is pure and exported, so the
 * security suite can assert the whole policy matrix on a Linux CI box with no
 * serve-sim, no simulator and no Mac.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SECRET_HEADER = "x-xcode-simulators-key";

/**
 * Routes that are 404 **unconditionally**, secret or not.
 *
 * Redundant with the allowlist below, and kept anyway: it is the line the
 * security suite asserts against, and a future contributor adding a route to
 * the allowlist should have to walk past this to re-enable shell execution.
 */
const DENY = [/^\/exec\/?$/, /^\/exec-ws\/?$/, /^\/devtools(\/|$)/, /^\/devtools-frontend(\/|$)/];

const UDID = "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}";

/** Everything the plugin uses, and nothing else. */
const ALLOW = [
  { method: "POST", pattern: /^\/grid\/api\/start$/ },
  { method: "POST", pattern: /^\/grid\/api\/shutdown$/ },
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/stream\\.mjpeg$`) },
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/config$`) },
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/health$`) },
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/ax$`) },
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/foreground$`) },
];

const WS_ALLOW = new RegExp(`^/helper/${UDID}/ws$`);

export function isDenied(path) {
  return DENY.some((pattern) => pattern.test(path));
}

export function isAllowed(method, path) {
  return ALLOW.some((entry) => entry.method === method && entry.pattern.test(path));
}

export function isWebSocketAllowed(path) {
  return WS_ALLOW.test(path);
}

/** Constant-time comparison that does not leak length through an early return. */
export function secretMatches(presented, expected) {
  if (typeof presented !== "string" || presented === "") return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function presentedSecret(req, url) {
  const header = req.headers[SECRET_HEADER];
  if (typeof header === "string") return header;
  // The query form exists for the one case that cannot set a header. Nothing
  // in this plugin composes such a URL today.
  return url.searchParams.get("k");
}

/**
 * Strip an `execToken` from a JSON response body.
 *
 * The allowlist already means no route that emits one is reachable. This is the
 * belt: serve-sim is a young package that has shipped 45 releases in three
 * months, and a token appearing in a response we do forward should be a
 * non-event rather than a discovery.
 */
export function scrubExecToken(text) {
  return text.replace(/"execToken"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"execToken":"[redacted]"');
}

/**
 * Buffer a JSON response so it can be scrubbed, and pass everything else
 * straight through.
 *
 * MJPEG must never be buffered — it is an endless multipart stream and holding
 * it would use all the memory on the machine — so the wrapper only engages once
 * `writeHead` has declared a JSON content type.
 */
export function wrapForScrubbing(res) {
  const originalWriteHead = res.writeHead.bind(res);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  let buffering = false;
  let chunks = [];

  res.writeHead = (statusCode, ...rest) => {
    const headers = rest.find((value) => typeof value === "object" && value !== null);
    const contentType = headers
      ? Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1]
      : undefined;
    if (typeof contentType === "string" && contentType.includes("application/json")) {
      buffering = true;
      // The scrubbed body may differ in length from the original.
      if (headers) {
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "content-length") delete headers[key];
        }
      }
    }
    return originalWriteHead(statusCode, ...rest);
  };

  res.write = (chunk, ...rest) => {
    if (!buffering) return originalWrite(chunk, ...rest);
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
      chunks.push(Buffer.from(chunk));
    }
    return true;
  };

  res.end = (chunk, ...rest) => {
    if (!buffering) return originalEnd(chunk, ...rest);
    if (typeof chunk !== "function" && chunk !== undefined && chunk !== null) {
      chunks.push(Buffer.from(chunk));
    }
    const body = scrubExecToken(Buffer.concat(chunks).toString("utf8"));
    chunks = [];
    return originalEnd(body);
  };
  return res;
}

function refuse(res, status, message) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message);
}

/**
 * The filtered server, with the middleware injected.
 *
 * Taking the middleware as a parameter is what lets the security suite mount a
 * stub and assert every route on a machine that has never seen a simulator.
 */
export function createFilteredServer(middleware, secret, onError = () => {}) {
  const server = createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      refuse(res, 400, "Bad request");
      return;
    }
    const path = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    // Order matters and is asserted: denied before allowed before authenticated,
    // so `/exec` is 404 whether or not the caller holds the secret.
    if (isDenied(path) || !isAllowed(method, path)) {
      refuse(res, 404, "Not found");
      return;
    }
    if (!secretMatches(presentedSecret(req, url), secret)) {
      refuse(res, 401, "Unauthorized");
      return;
    }

    wrapForScrubbing(res);
    // The middleware returns a promise it also settles internally; a rejection
    // here is ours to contain, because an unhandled one kills this process and
    // the supervisor would report a restart with no reason.
    Promise.resolve(middleware(req, res)).catch((error) => {
      onError(`request failed: ${error instanceof Error ? error.stack : error}`);
      if (!res.writableEnded) refuse(res, 502, "Capture host error");
    });
  });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      socket.destroy();
      return;
    }
    if (isDenied(url.pathname) || !isWebSocketAllowed(url.pathname)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!secretMatches(presentedSecret(req, url), secret)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      middleware.handleUpgrade(req, socket, head);
    } catch (error) {
      onError(`upgrade failed: ${error instanceof Error ? error.stack : error}`);
      socket.destroy();
    }
  });

  return server;
}

/** One line on stdout, then never speak on stdout again. */
function handshake(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(message) {
  handshake({ ok: false, error: message });
  process.exit(1);
}

async function main() {
  const secret = process.env.XCSIM_SECRET;
  if (typeof secret !== "string" || secret.length < 32) {
    fail("XCSIM_SECRET is missing or too short");
    return;
  }
  const requestedPort = Number.parseInt(process.env.XCSIM_PORT ?? "0", 10);
  const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 0;

  const require = createRequire(import.meta.url);

  // Resolve the middleware before importing it, so a missing install is a
  // sentence on the handshake line rather than an ESM stack trace on stderr.
  // Note the specifier: `require.resolve("serve-sim")` throws
  // ERR_PACKAGE_PATH_NOT_EXPORTED on a healthy install, because the exports map
  // declares only `./middleware` and `./state`.
  let middlewarePath;
  try {
    middlewarePath = require.resolve("serve-sim/middleware");
  } catch (error) {
    fail(`serve-sim/middleware did not resolve: ${error instanceof Error ? error.message : error}`);
    return;
  }

  // dlopen the native addon here rather than waiting for the first device, so
  // the panel can say "the capture addon did not load" before anyone presses
  // Boot and waits twenty seconds for nothing. The addon is not an exports-map
  // entry, so it is resolved by path from the middleware's own directory.
  let addonLoaded = false;
  let addonError = null;
  const addonPath = join(dirname(middlewarePath), "native", "serve-sim-native.node");
  if (!existsSync(addonPath)) {
    addonError = `not at ${addonPath}`;
  } else {
    try {
      const addon = require(addonPath);
      addonLoaded = typeof addon.SimCapture === "function" && typeof addon.SimHID === "function";
      if (!addonLoaded) addonError = "loaded but exposes neither SimCapture nor SimHID";
    } catch (error) {
      addonError = error instanceof Error ? error.message : String(error);
    }
  }

  let simMiddleware;
  try {
    ({ simMiddleware } = await import("serve-sim/middleware"));
  } catch (error) {
    fail(`serve-sim/middleware did not import: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const middleware = simMiddleware({ basePath: "", device: undefined, proxyHelpers: false });
  const server = createFilteredServer(middleware, secret, (line) =>
    process.stderr.write(`[sim-host] ${line}\n`),
  );

  server.on("error", (error) => {
    fail(`capture host could not listen: ${error instanceof Error ? error.message : error}`);
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const boundPort = typeof address === "object" && address !== null ? address.port : port;
    handshake({ ok: true, port: boundPort, addon: addonLoaded, addonError });
  });

  const shutdown = () => {
    try {
      server.close();
    } catch {
      // Already closing.
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Exiting on an unhandled rejection is the point of this process. Node's
  // default does it too, but with a bare stack; naming it first means the
  // supervisor can say why the panel is reconnecting.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(
      `[sim-host] unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`,
    );
    process.exit(70);
  });
  process.on("uncaughtException", (error) => {
    process.stderr.write(`[sim-host] uncaught exception: ${error.stack ?? error.message}\n`);
    process.exit(70);
  });
  // The parent went away without killing us. Nothing left to serve.
  process.stdout.on("error", () => process.exit(0));
}

/**
 * Run only when this file is the process entry.
 *
 * Importing it — which the security suite does — must not start a server or
 * write a handshake line to the test runner's stdout.
 */
function isEntryPoint() {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  try {
    return realpathSync(argv) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
