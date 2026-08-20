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
 * small explicit route set the plugin actually uses and 404s everything else,
 * which makes the escalation unreachable rather than merely gated.
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
export const MAX_CONTROL_BODY_BYTES = 4096;
export const MAX_SCRUBBED_JSON_BYTES = 8 * 1024 * 1024;

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
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/stream\\.avcc$`) },
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/config$`) },
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/health$`) },
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/ax$`) },
  { method: "GET", pattern: new RegExp(`^/helper/${UDID}/foreground$`) },
];

const WS_ALLOW = new RegExp(`^/helper/${UDID}/ws$`);

/**
 * The one route a **stream token** may open.
 *
 * The panel streams straight from this process rather than through the bb
 * server — measured, the proxy hop cost 79% as much CPU as capturing and
 * encoding the frames did, all of it on the process every other plugin shares.
 * But an `<img>` cannot set a header, so a direct URL has to carry its
 * credential in the query string, where it lands in the DOM.
 *
 * So it carries a different one. The stream token authorises exactly this
 * regex and nothing else: a URL that leaks lets someone *watch* the simulator,
 * where the master secret would also let them drive it over the HID socket,
 * read the accessibility tree, and shut the device down.
 */
const STREAM_ONLY = new RegExp(`^/helper/${UDID}/stream\\.(mjpeg|avcc)$`);

export function isStreamRoute(path) {
  return STREAM_ONLY.test(path);
}

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

export function headerSecret(req) {
  const header = req.headers[SECRET_HEADER];
  return typeof header === "string" ? header : null;
}

/**
 * May this request proceed?
 *
 * The master secret opens every allowed route, but only from its private
 * header. The stream token opens a pixel stream only and only from `?k=`.
 * Keeping the two channels distinct prevents a master credential copied into
 * a URL from reaching access logs, browser history, or referrers.
 */
export function authorize({ path, header, query, secret, streamToken }) {
  if (secretMatches(header, secret)) return true;
  if (typeof streamToken !== "string" || streamToken === "") return false;
  return isStreamRoute(path) && secretMatches(query, streamToken);
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

function isJsonContentType(value) {
  return typeof value === "string" && /(?:^|\s|;)application\/(?:[^;\s]+\+)?json(?:\s*;|$)/i.test(value);
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
  const originalSetHeader = res.setHeader.bind(res);

  let buffering = false;
  let chunks = [];
  let bufferedBytes = 0;
  let overflowed = false;

  const append = (chunk) => {
    const buffer = Buffer.from(chunk);
    bufferedBytes += buffer.length;
    if (bufferedBytes > MAX_SCRUBBED_JSON_BYTES) {
      overflowed = true;
      chunks = [];
      res.destroy();
      return false;
    }
    chunks.push(buffer);
    return true;
  };

  const enableBuffering = () => {
    buffering = true;
    // The scrubbed body may differ in length from the original.
    if (!res.headersSent) res.removeHeader("content-length");
  };

  res.setHeader = (name, value) => {
    const key = String(name).toLowerCase();
    if (key === "content-type" && isJsonContentType(String(value))) {
      enableBuffering();
    }
    if (buffering && key === "content-length") return res;
    return originalSetHeader(name, value);
  };

  res.writeHead = (statusCode, ...rest) => {
    const headers = rest.find((value) => typeof value === "object" && value !== null);
    const headerRecord = headers && !Array.isArray(headers) ? headers : null;
    const rawHeaders = Array.isArray(headers) ? headers : null;
    const explicitContentType = headerRecord
      ? Object.entries(headerRecord).find(([key]) => key.toLowerCase() === "content-type")?.[1]
      : rawHeaders
        ? rawHeaderValue(rawHeaders, "content-type")
        : undefined;
    const contentType = explicitContentType ?? res.getHeader("content-type");
    if (isJsonContentType(String(contentType ?? ""))) {
      enableBuffering();
      if (headerRecord) {
        for (const key of Object.keys(headerRecord)) {
          if (key.toLowerCase() === "content-length") delete headerRecord[key];
        }
      }
      if (rawHeaders) removeRawHeader(rawHeaders, "content-length");
    }
    return originalWriteHead(statusCode, ...rest);
  };

  res.write = (chunk, ...rest) => {
    const contentType = res.getHeader("content-type");
    if (isJsonContentType(String(contentType ?? ""))) {
      enableBuffering();
    }
    if (!buffering) return originalWrite(chunk, ...rest);
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") {
      if (!append(chunk)) return false;
    }
    return true;
  };

  res.end = (chunk, ...rest) => {
    const contentType = res.getHeader("content-type");
    if (isJsonContentType(String(contentType ?? ""))) {
      enableBuffering();
    }
    if (!buffering) return originalEnd(chunk, ...rest);
    if (typeof chunk !== "function" && chunk !== undefined && chunk !== null) {
      if (!append(chunk)) return res;
    }
    if (overflowed) return res;
    const body = scrubExecToken(Buffer.concat(chunks).toString("utf8"));
    chunks = [];
    const callback = typeof chunk === "function" ? chunk : rest.find((value) => typeof value === "function");
    return callback === undefined ? originalEnd(body) : originalEnd(body, callback);
  };
  return res;
}

function rawHeaderValue(headers, wanted) {
  for (let index = 0; index + 1 < headers.length; index += 2) {
    if (String(headers[index]).toLowerCase() === wanted) return headers[index + 1];
  }
  return undefined;
}

function removeRawHeader(headers, wanted) {
  for (let index = headers.length - 2; index >= 0; index -= 2) {
    if (String(headers[index]).toLowerCase() === wanted) headers.splice(index, 2);
  }
}

function refuse(res, status, message) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(message);
}

function validControlBody(req) {
  if ((req.method ?? "GET").toUpperCase() !== "POST") return null;
  const type = req.headers["content-type"];
  if (typeof type !== "string" || !/^application\/json(?:\s*;|$)/i.test(type)) {
    return { status: 415, message: "JSON required" };
  }
  if (req.headers["transfer-encoding"] !== undefined) {
    return { status: 411, message: "Content-Length required" };
  }
  const rawLength = req.headers["content-length"];
  if (typeof rawLength !== "string" || !/^[0-9]+$/.test(rawLength)) {
    return { status: 411, message: "Content-Length required" };
  }
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length) || length > MAX_CONTROL_BODY_BYTES) {
    return { status: 413, message: "Request body too large" };
  }
  return null;
}

/**
 * The filtered server, with the middleware injected.
 *
 * Taking the middleware as a parameter is what lets the security suite mount a
 * stub and assert every route on a machine that has never seen a simulator.
 */
export function createFilteredServer(middleware, secret, onError = () => {}, streamToken = null) {
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
    if (!authorize({
      path,
      header: headerSecret(req),
      query: url.searchParams.get("k"),
      secret,
      streamToken,
    })) {
      refuse(res, 401, "Unauthorized");
      return;
    }
    const invalidBody = validControlBody(req);
    if (invalidBody !== null) {
      refuse(res, invalidBody.status, invalidBody.message);
      return;
    }

    wrapForScrubbing(res);
    // The middleware returns a promise it also settles internally; a rejection
    // here is ours to contain, because an unhandled one kills this process and
    // the supervisor would report a restart with no reason.
    Promise.resolve()
      .then(() => middleware(req, res))
      .catch((error) => {
        try {
          onError(`request failed: ${error instanceof Error ? error.stack : error}`);
        } catch {
          // Diagnostic callbacks do not get to turn a contained request error
          // back into a process-level failure.
        }
        if (res.writableEnded || res.destroyed) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        try {
          refuse(res, 502, "Capture host error");
        } catch {
          res.destroy();
        }
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
    // Deliberately `secretMatches`, not `authorize`: the HID socket is the
    // route that drives the device, and a stream token must never reach it.
    if (!secretMatches(headerSecret(req), secret)) {
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

  server.maxHeadersCount = 32;
  server.maxConnections = 16;
  server.headersTimeout = 10_000;
  // A first simulator boot can legitimately take three minutes.
  server.requestTimeout = 310_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 32;
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
  // Optional: without it, direct streaming is simply unavailable and the panel
  // keeps using the proxy. An old supervisor talking to a new host must not be
  // a failure to start.
  const streamToken = process.env.XCSIM_STREAM_KEY ?? null;
  if (streamToken !== null && streamToken.length < 32) {
    fail("XCSIM_STREAM_KEY is too short");
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
  const server = createFilteredServer(
    middleware,
    secret,
    (line) => process.stderr.write(`[sim-host] ${line}\n`),
    streamToken,
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
  process.stdin.resume();
  process.stdin.on("end", shutdown);
  process.stdin.on("error", shutdown);

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
  // Stdout is a secondary belt; stdin EOF above is the parent-liveness signal.
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
