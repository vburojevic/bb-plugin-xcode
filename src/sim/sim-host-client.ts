/**
 * Talking to the capture host over its loopback HTTP surface.
 *
 * Every call carries the per-boot secret. Every call that touches a
 * `/helper/…` route is preceded by a `Booted` confirmation from the caller,
 * because a UDID from our own cache is untrusted input — the user can shut the
 * device down between our poll and our request.
 *
 * `/health` is **not** a liveness probe: it is `sendJson(200, {status:"ok"})`
 * on a session that may be about to fail. Liveness is `/config` returning
 * non-zero dimensions.
 */
import { request } from "node:http";
import type { IncomingMessage } from "node:http";

export interface SimHostAddress {
  port: number;
  secret: string;
  /** Opens the MJPEG route only; see `SimHostHandle.streamToken`. */
  streamToken: string;
}

/** A single encoded simulator frame must remain bounded even if the child lies. */
export const MAX_JPEG_FRAME_BYTES = 32 * 1024 * 1024;

export class SimHostError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "SimHostError";
  }
}

interface RequestOptions {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * One request against the child, returning the raw response so a caller can
 * either read it as JSON or pipe it.
 *
 * The secret goes in a header rather than the query string, so it cannot end
 * up in an access log or a referrer. Only the separate, stream-only token has
 * a query-string form, for an image URL that cannot set headers.
 */
export function open(
  address: SimHostAddress,
  options: RequestOptions,
): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), "utf8");
    const req = request(
      {
        host: "127.0.0.1",
        port: address.port,
        method: options.method,
        path: options.path,
        headers: {
          "x-xcode-simulators-key": address.secret,
          ...(payload === null
            ? {}
            : { "content-type": "application/json", "content-length": String(payload.length) }),
        },
      },
      resolve,
    );
    if (options.timeoutMs !== undefined) {
      req.setTimeout(options.timeoutMs, () => {
        req.destroy(new SimHostError(`The capture host did not answer ${options.path} in time.`, null));
      });
    }
    const onAbort = (): void => {
      req.destroy(new Error("aborted"));
    };
    if (options.signal !== undefined) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      // AbortSignal does not replay an abort to listeners added afterward.
      // A browser can disconnect in the tick between constructing the route
      // controller and opening this request, so handle that state explicitly.
      if (options.signal.aborted) onAbort();
      req.once("close", () => options.signal?.removeEventListener("abort", onAbort));
    }
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function readBody(response: IncomingMessage, limit = 8 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > limit) {
      response.destroy();
      throw new SimHostError("The capture host returned more than we are willing to read.", response.statusCode ?? null);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function json<T>(address: SimHostAddress, options: RequestOptions): Promise<T> {
  const response = await open(address, options);
  const body = await readBody(response);
  const status = response.statusCode ?? 0;
  if (status < 200 || status >= 300) {
    throw new SimHostError(body.trim() || `The capture host answered ${status}.`, status);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new SimHostError(`The capture host did not return JSON from ${options.path}.`, status);
  }
}

/**
 * Start capturing a device, booting it if necessary.
 *
 * This blocks for the **entire boot** — `simctl boot` then `simctl bootstatus
 * -b` with a 180-second timeout inside serve-sim — so it is never awaited
 * inside an RPC handler. `liveStart` fires it into the background and returns
 * `{status: "booting"}` immediately.
 */
export async function startDevice(
  address: SimHostAddress,
  udid: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = await json<{ ok?: boolean; error?: string }>(address, {
    method: "POST",
    path: "/grid/api/start",
    body: { udid },
    timeoutMs: 300_000,
    signal,
  });
  if (result.ok !== true) {
    throw new SimHostError(result.error ?? "The simulator did not start.", null);
  }
}

/**
 * Shut a device down *through the child*.
 *
 * serve-sim's own route calls `closeDeviceSession(udid)` before it shells out,
 * which is the only way to evict the child's cached capture session. Going
 * straight to `simctl shutdown` leaves the child holding a session bound to a
 * dead device, and the next start reuses it and produces no frames.
 *
 * That makes this the right call even for a device that is *already* down: the
 * `simctl` half fails harmlessly and the session is still evicted.
 */
export async function shutdownDevice(address: SimHostAddress, udid: string): Promise<void> {
  try {
    await json<{ ok?: boolean }>(address, {
      method: "POST",
      path: "/grid/api/shutdown",
      body: { udid },
      timeoutMs: 60_000,
    });
  } catch (error) {
    // A 500 here means `simctl shutdown` complained — usually because the
    // device was already down. The session eviction happened first regardless,
    // which is the part we came for.
    if (!(error instanceof SimHostError)) throw error;
  }
}

export interface DeviceConfig {
  width: number;
  height: number;
  orientation: string;
}

export function deviceConfig(address: SimHostAddress, udid: string): Promise<DeviceConfig> {
  return json<DeviceConfig>(address, {
    method: "GET",
    path: `/helper/${udid}/config`,
    timeoutMs: 5000,
  });
}

export interface ForegroundApp {
  bundleId: string | null;
  pid: number | null;
}

/**
 * What is on screen right now.
 *
 * Answers 503 with `{error: "foreground_unavailable"}` while the simulator's
 * accessibility service is warming up, which is a normal state in the first
 * seconds after a boot rather than a failure worth surfacing.
 */
export async function foregroundApp(
  address: SimHostAddress,
  udid: string,
): Promise<ForegroundApp> {
  try {
    const raw = await json<{ bundleId?: unknown; pid?: unknown }>(address, {
      method: "GET",
      path: `/helper/${udid}/foreground`,
      timeoutMs: 5000,
    });
    return {
      bundleId: typeof raw.bundleId === "string" && raw.bundleId !== "" ? raw.bundleId : null,
      pid: typeof raw.pid === "number" ? raw.pid : null,
    };
  } catch {
    return { bundleId: null, pid: null };
  }
}

/**
 * The accessibility tree, raw.
 *
 * This endpoint returns the native bridge's tree unchanged — serve-sim's
 * normalizer runs only on its `/ax` **stream**, which is a subscription rather
 * than a question. `src/ax.ts` does the flattening, which also makes it
 * testable against a recorded tree with no simulator.
 */
export function accessibility(
  address: SimHostAddress,
  udid: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return json<unknown>(address, {
    method: "GET",
    path: `/helper/${udid}/ax`,
    // The bridge can take a few seconds on a busy screen, and answering "not
    // found" because we gave up early is the worst possible failure here.
    timeoutMs: 20_000,
    signal,
  });
}

/**
 * A single JPEG frame, pulled off the MJPEG stream and then disconnected.
 *
 * There is no still-image endpoint; the stream is the only source of pixels.
 * The multipart boundary is `--frame` with a `Content-Length` header per part,
 * so one part can be read exactly rather than scanned for JPEG markers.
 */
export async function grabFrame(
  address: SimHostAddress,
  udid: string,
  timeoutMs = 15_000,
): Promise<Buffer> {
  const response = await open(address, {
    method: "GET",
    path: `/helper/${udid}/stream.mjpeg`,
    timeoutMs,
  });
  const status = response.statusCode ?? 0;
  if (status !== 200) {
    response.destroy();
    throw new SimHostError(`The simulator's stream answered ${status}.`, status);
  }

  return new Promise<Buffer>((resolve, reject) => {
    let headerBuffer = Buffer.alloc(0);
    let expected: number | null = null;
    const bodyChunks: Buffer[] = [];
    let bodyBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (result: Buffer | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const consumeBody = (chunk: Buffer): void => {
      if (expected === null || settled) return;
      const remaining = expected - bodyBytes;
      if (remaining <= 0) return;
      const accepted = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      bodyChunks.push(accepted);
      bodyBytes += accepted.length;
      if (bodyBytes === expected) finish(Buffer.concat(bodyChunks, expected));
    };

    timer = setTimeout(
      () => finish(new SimHostError("No frame arrived from the simulator.", null)),
      timeoutMs,
    );
    timer.unref?.();

    response.on("data", (chunk: Buffer) => {
      if (expected === null) {
        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const headerEnd = headerBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          // A part header that never ends is a malformed stream, not a slow one.
          if (headerBuffer.length > 8192) {
            finish(new SimHostError("The simulator's stream sent no part header.", null));
          }
          return;
        }
        const header = headerBuffer.subarray(0, headerEnd).toString("ascii");
        const length = /content-length:\s*(\d+)/i.exec(header);
        if (length === null) {
          finish(new SimHostError("The simulator's stream sent no Content-Length.", null));
          return;
        }
        expected = Number.parseInt(length[1]!, 10);
        if (!Number.isSafeInteger(expected) || expected <= 0 || expected > MAX_JPEG_FRAME_BYTES) {
          finish(new SimHostError("The simulator's frame was larger than the safety limit.", null));
          return;
        }
        const firstBody = headerBuffer.subarray(headerEnd + 4);
        headerBuffer = Buffer.alloc(0);
        consumeBody(firstBody);
        return;
      }
      consumeBody(chunk);
    });
    response.on("error", (error) => {
      finish(error);
    });
    response.on("end", () => {
      finish(new SimHostError("The simulator's stream ended before a frame arrived.", null));
    });
  });
}

/**
 * The upstream path a proxy pulls from. Only the plugin's own routes compose one.
 *
 * `.avcc` is hardware-encoded H.264 and `.mjpeg` is serve-sim's software JPEG
 * fallback — 200 KB/s against 3.55 MB/s for the same motion on the same device.
 * The proxy carries both because the 18× matters most exactly where the proxy
 * is required: a remote bb panel.
 */
export function streamPath(udid: string, codec: "avcc" | "mjpeg" = "mjpeg"): string {
  return `/helper/${udid}/stream.${codec}`;
}
