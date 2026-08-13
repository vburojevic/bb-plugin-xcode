/**
 * The viewer origin: a second, plugin-owned HTTP server that is the only thing
 * ever exposed.
 *
 * serve-sim's port stays bound to `127.0.0.1` and is never shared. This serves
 * exactly five things and 404s everything else:
 *
 *     GET  /                        the self-contained viewer page
 *     GET  /s/<token>/stream.mjpeg  proxied from the capture host
 *     GET  /s/<token>/config
 *     WS   /s/<token>/ws            proxied to the device's HID socket
 *     GET  /s/<token>/health        this server's liveness, not serve-sim's
 *
 * The WebSocket is filtered by tag rather than forwarded. `0x08` (Core
 * Animation debug overlays) and `0x09` (memory warning) are dropped on the
 * remote path: they are debugging affordances rather than viewing ones, and
 * they change the device's behaviour. `0x04` passes only for `home`,
 * `swipe_home` and `app_switcher`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { TAG } from "./hid.js";
import * as host from "./sim-host-client.js";

/** Buttons the remote path may press. Everything else is a local affordance. */
export const REMOTE_BUTTONS = new Set(["home", "swipe_home", "app_switcher"]);

/** Tags the remote path may send at all. */
export const REMOTE_TAGS = new Set<number>([
  TAG.touch,
  TAG.button,
  TAG.multiTouch,
  TAG.key,
  TAG.orientation,
  TAG.scroll,
  TAG.softwareKeyboard,
]);

/**
 * Decide whether one HID frame may cross the remote boundary.
 *
 * Pure, so the whole allowlist is asserted in a unit test with no sockets.
 */
export function allowsFrame(data: Buffer): boolean {
  if (data.length < 1) return false;
  const tag = data[0]!;
  if (!REMOTE_TAGS.has(tag)) return false;
  if (tag !== TAG.button) return true;
  // A button frame carries a name, and only three of them are viewing
  // affordances. `lock` and `siri` change the device in ways a remote viewer
  // has no way to undo.
  try {
    const body = JSON.parse(data.subarray(1).toString("utf8")) as { button?: unknown };
    return typeof body.button === "string" && REMOTE_BUTTONS.has(body.button);
  } catch {
    return false;
  }
}

/** `/s/<token>/<what>` — the only shape with a token in it. */
export function parseViewerPath(pathname: string): { token: string; what: string } | null {
  const match = /^\/s\/([A-Za-z0-9_-]{16,128})\/([a-z.]+)$/.exec(pathname);
  if (match === null) return null;
  return { token: match[1]!, what: match[2]! };
}

export interface ViewerDeps {
  /** Validates a capability token against the live exposure. */
  isValid: (token: string) => boolean;
  /** The device the live exposure is for, or `null`. */
  udid: () => string | null;
  /** The capture host's loopback address, or `null` when it is not running. */
  address: () => host.SimHostAddress | null;
  onViewerOpened: () => void;
  onViewerClosed: () => void;
  onError: (message: string) => void;
  showDeviceChrome: () => boolean;
}

function refuse(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(status === 404 ? "Not found" : "Unauthorized");
}

export interface ViewerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startViewer(deps: ViewerDeps): Promise<ViewerHandle> {
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      deps.onError(`viewer request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.writableEnded) refuse(res, 502);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if ((req.method ?? "GET").toUpperCase() !== "GET") return refuse(res, 404);

    if (url.pathname === "/") {
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        // The page is self-contained and loads nothing: no CDN, no analytics,
        // no fonts. The CSP says so rather than trusting that it stays true.
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(viewerPage(deps.showDeviceChrome()));
      return;
    }

    const parsed = parseViewerPath(url.pathname);
    if (parsed === null || !deps.isValid(parsed.token)) return refuse(res, 404);

    if (parsed.what === "health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const udid = deps.udid();
    const address = deps.address();
    if (udid === null || address === null) return refuse(res, 404);

    if (parsed.what === "config") {
      const config = await host.deviceConfig(address, udid);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(config));
      return;
    }

    if (parsed.what !== "stream.mjpeg") return refuse(res, 404);

    const upstream = await host.open(address, { method: "GET", path: host.streamPath(udid) });
    if (upstream.statusCode !== 200) {
      upstream.destroy();
      return refuse(res, 502);
    }
    deps.onViewerOpened();
    let counted = true;
    const release = (): void => {
      if (!counted) return;
      counted = false;
      deps.onViewerClosed();
    };
    upstream.on("close", release);
    upstream.on("error", release);
    res.writeHead(200, {
      "Content-Type": upstream.headers["content-type"] ?? "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-store",
    });
    upstream.pipe(res);
    res.on("close", () => upstream.destroy());
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket: Duplex, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parsed = parseViewerPath(url.pathname);
    if (parsed === null || parsed.what !== "ws" || !deps.isValid(parsed.token)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const udid = deps.udid();
    const address = deps.address();
    if (udid === null || address === null) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(
        `ws://127.0.0.1:${address.port}/helper/${udid}/ws`,
        { headers: { "x-xcode-simulators-key": address.secret } },
      );
      const close = (): void => {
        try {
          client.close();
        } catch {
          // Already closed.
        }
        try {
          upstream.close();
        } catch {
          // Already closed.
        }
      };

      // Device → viewer passes through: the `0x82` dimension push is the only
      // thing the device sends, and a remote viewer needs it to size its frame.
      upstream.on("message", (data: Buffer) => {
        if (client.readyState === WebSocket.OPEN) client.send(data);
      });
      // Viewer → device is filtered by tag.
      client.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
        const buffer = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        if (!allowsFrame(buffer)) return;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(buffer);
      });
      client.on("close", close);
      client.on("error", close);
      upstream.on("close", close);
      upstream.on("error", close);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Bound to every interface, because this port is what the connect tunnel
    // reaches. Nothing without a capability token gets past the first branch.
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
        // A live MJPEG connection holds the server open, and teardown must not
        // wait on a phone that fell asleep.
        for (const client of wss.clients) client.terminate();
        server.closeAllConnections?.();
      }),
  };
}

/**
 * The viewer page.
 *
 * Self-contained: no framework, no fonts, no analytics. It is served over a
 * tunnel to a phone, and every byte is one the user is paying for on a mobile
 * connection.
 *
 * Coarse-pointer handling is the whole point of it existing rather than reusing
 * the panel: `touch-action: none` so the page does not pan, no double-tap zoom,
 * no selection, `viewport-fit=cover` with safe-area insets, and typing routed
 * through a hidden input — the simulator's software keyboard is not reachable
 * from a remote viewer, so without that you can look but not type.
 */
export function viewerPage(showChrome: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>Simulator</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #000; color: #fff;
    font: 14px/1.4 -apple-system, system-ui, sans-serif;
    -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  body { display: flex; flex-direction: column;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  #frame { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
    touch-action: none; position: relative; ${showChrome ? "padding: 12px;" : ""} }
  #frame img { max-width: 100%; max-height: 100%; object-fit: contain; display: block;
    ${showChrome ? "border-radius: 28px; box-shadow: 0 0 0 10px #1c1c1e;" : ""} }
  #status { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 24px; color: #aaa; }
  #bar { display: flex; gap: 8px; padding: 8px; justify-content: center; }
  button { flex: 1; max-width: 140px; padding: 12px; border: 0; border-radius: 10px;
    background: #2c2c2e; color: #fff; font: inherit; -webkit-appearance: none; }
  button:active { background: #3a3a3c; }
  #keys { position: absolute; opacity: 0; pointer-events: none; width: 1px; height: 1px; }
</style>
</head>
<body>
<div id="frame">
  <img id="img" alt="">
  <div id="status">Connecting…</div>
  <input id="keys" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false">
</div>
<div id="bar">
  <button id="home">Home</button>
  <button id="switch">Switcher</button>
  <button id="type">Keyboard</button>
</div>
<script>
(function () {
  var base = location.pathname.replace(/\\/$/, "");
  var token = new URLSearchParams(location.search).get("t") || "";
  var img = document.getElementById("img");
  var status = document.getElementById("status");
  var keys = document.getElementById("keys");
  var frame = document.getElementById("frame");
  var size = { width: 0, height: 0 };
  var ws = null;

  function say(text) { status.textContent = text; status.style.display = text ? "flex" : "none"; }
  function send(tag, body) {
    if (!ws || ws.readyState !== 1) return;
    var head = new Uint8Array([tag]);
    if (body === undefined) return ws.send(head);
    var json = new TextEncoder().encode(JSON.stringify(body));
    var out = new Uint8Array(head.length + json.length);
    out.set(head, 0); out.set(json, 1);
    ws.send(out);
  }

  img.onload = function () { say(""); };
  img.onerror = function () { say("The stream stopped."); };
  img.src = base + "/stream.mjpeg?t=" + Date.now();

  function connect() {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + base + "/ws");
    ws.binaryType = "arraybuffer";
    ws.onmessage = function (event) {
      var data = new Uint8Array(event.data);
      if (data[0] !== 130) return;
      try { size = JSON.parse(new TextDecoder().decode(data.subarray(1))); } catch (e) { /* ignore */ }
    };
    ws.onclose = function () { say("Disconnected."); };
  }
  connect();

  function point(event) {
    var rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
    };
  }

  var start = null, startedAt = 0;
  frame.addEventListener("pointerdown", function (event) {
    frame.setPointerCapture(event.pointerId);
    start = point(event); startedAt = Date.now();
  });
  frame.addEventListener("pointerup", function (event) {
    var end = point(event);
    if (!start || !end) { start = null; return; }
    var moved = Math.hypot(end.x - start.x, end.y - start.y);
    if (moved < 0.015) {
      send(3, { type: "begin", x: start.x, y: start.y });
      send(3, { type: "move", x: start.x, y: start.y });
      send(3, { type: "end", x: start.x, y: start.y });
    } else {
      var steps = 10, from = start, to = end;
      send(3, { type: "begin", x: from.x, y: from.y });
      for (var i = 1; i <= steps; i++) {
        var t = i / steps;
        send(3, { type: "move", x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
      }
      send(3, { type: "end", x: to.x, y: to.y });
    }
    start = null;
  });

  document.getElementById("home").onclick = function () { send(4, { button: "home" }); };
  document.getElementById("switch").onclick = function () { send(4, { button: "app_switcher" }); };
  // The simulator's software keyboard is not reachable from here, so typing
  // goes through a hidden input that forwards to HID usage codes.
  document.getElementById("type").onclick = function () { keys.focus(); };

  var MAP = {};
  "abcdefghijklmnopqrstuvwxyz".split("").forEach(function (c, i) { MAP[c] = 4 + i; });
  "1234567890".split("").forEach(function (c, i) { MAP[c] = 30 + i; });
  MAP[" "] = 44; MAP["\\n"] = 40; MAP["-"] = 45; MAP["="] = 46;
  MAP["."] = 55; MAP[","] = 54; MAP["/"] = 56; MAP[";"] = 51; MAP["'"] = 52;

  keys.addEventListener("keydown", function (event) {
    if (event.key === "Backspace") { event.preventDefault(); send(6, { type: "down", usage: 42 }); send(6, { type: "up", usage: 42 }); return; }
    if (event.key === "Enter") { event.preventDefault(); send(6, { type: "down", usage: 40 }); send(6, { type: "up", usage: 40 }); return; }
    if (event.key.length !== 1) return;
    event.preventDefault();
    var lower = event.key.toLowerCase();
    var usage = MAP[lower];
    if (!usage) return;
    var shift = event.key !== lower;
    if (shift) send(6, { type: "down", usage: 225 });
    send(6, { type: "down", usage: usage });
    send(6, { type: "up", usage: usage });
    if (shift) send(6, { type: "up", usage: 225 });
  });
})();
</script>
</body>
</html>`;
}
