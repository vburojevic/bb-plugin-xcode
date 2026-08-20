import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { SimHostAddress } from "./sim-host-client.js";
import type { ConnectionLimit } from "./connection-limit.js";

export interface PrivateRouteContext {
  req: {
    query(key: string): string | undefined;
    raw: { signal?: AbortSignal };
  };
  text(body: string, status?: number): Response;
}

export interface PrivateStreamRouteDeps {
  currentDeviceUdid(): string | null;
  address(): SimHostAddress | null;
  noteViewerOpened(): void;
  noteViewerClosed(): void;
  open(
    address: SimHostAddress,
    options: { method: "GET"; path: string; timeoutMs: number; signal: AbortSignal },
  ): Promise<IncomingMessage>;
  streamPath(udid: string, codec: "avcc" | "mjpeg"): string;
}

const UDID_PATTERN = /^[0-9A-Fa-f-]{36}$/;

export function makePresenceRouteHandler(
  deps: PrivateStreamRouteDeps,
  limit: ConnectionLimit,
): (context: PrivateRouteContext) => Promise<Response> {
  return async (context) => {
    const udid = context.req.query("udid");
    if (udid === undefined || !UDID_PATTERN.test(udid)) {
      return context.text("Not found", 404);
    }
    if (deps.currentDeviceUdid() !== udid) {
      return context.text("That simulator is not running.", 409);
    }
    if (context.req.raw.signal?.aborted === true) {
      return context.text("Viewer disconnected.", 408);
    }

    const permit = limit.tryAcquire();
    if (permit === null) {
      return context.text("Too many simulator viewers are already connected.", 503);
    }
    let released = false;
    let counted = false;
    const release = (): void => {
      if (released) return;
      released = true;
      permit();
      if (!counted) return;
      counted = false;
      try {
        deps.noteViewerClosed();
      } catch {
        // Teardown accounting must never throw into a socket handler.
      }
    };

    try {
      deps.noteViewerOpened();
      counted = true;
    } catch (error) {
      release();
      throw error;
    }

    const body = new ReadableStream<Uint8Array>({ cancel: release });
    context.req.raw.signal?.addEventListener("abort", release, { once: true });
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}

export function makeStreamRouteHandler(
  deps: PrivateStreamRouteDeps,
  limit: ConnectionLimit,
): (context: PrivateRouteContext) => Promise<Response> {
  return async (context) => {
    const udid = context.req.query("udid");
    if (udid === undefined || !UDID_PATTERN.test(udid)) {
      return context.text("Not found", 404);
    }
    const address = deps.address();
    if (address === null) return context.text("The capture host is not running.", 503);
    if (deps.currentDeviceUdid() !== udid) {
      return context.text("That simulator is not running.", 409);
    }

    const permit = limit.tryAcquire();
    if (permit === null) {
      return context.text("Too many simulator streams are already connected.", 503);
    }

    const codec = context.req.query("codec") === "avcc" ? "avcc" : "mjpeg";
    const abort = new AbortController();
    const requestSignal = context.req.raw.signal;
    let upstream: IncomingMessage | null = null;
    let released = false;
    let counted = false;
    const release = (): void => {
      if (released) return;
      released = true;
      requestSignal?.removeEventListener("abort", onAbort);
      permit();
      if (!counted) return;
      counted = false;
      try {
        deps.noteViewerClosed();
      } catch {
        // Teardown accounting must never throw into a socket handler.
      }
    };
    const onAbort = (): void => {
      abort.abort();
      upstream?.destroy();
      release();
    };
    requestSignal?.addEventListener("abort", onAbort, { once: true });
    if (requestSignal?.aborted === true) onAbort();

    try {
      upstream = await deps.open(address, {
        method: "GET",
        path: deps.streamPath(udid, codec),
        timeoutMs: 5000,
        signal: abort.signal,
      });
    } catch (error) {
      release();
      return abort.signal.aborted
        ? context.text("Viewer disconnected.", 408)
        : context.text(`The capture host refused the stream: ${describe(error)}`, 502);
    }
    if (upstream.statusCode !== 200) {
      upstream.destroy();
      release();
      return context.text("The simulator has no stream right now.", 502);
    }
    if (abort.signal.aborted || upstream.destroyed) {
      upstream.destroy();
      release();
      return context.text("Viewer disconnected.", 408);
    }
    if (deps.currentDeviceUdid() !== udid) {
      upstream.destroy();
      release();
      return context.text("The simulator changed while the stream opened.", 409);
    }

    try {
      deps.noteViewerOpened();
      counted = true;
    } catch (error) {
      upstream.destroy();
      release();
      throw error;
    }
    upstream.once("close", release);
    upstream.once("error", () => {
      upstream?.destroy();
      release();
    });

    const body = releasingWebStream(upstream, release);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": upstream.headers["content-type"] ?? "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  };
}

/**
 * Preserve Node's stream backpressure while making Fetch cancellation an
 * explicit release path. `Readable.toWeb` destroys the source eventually, but
 * its `cancel()` promise can settle before the Node `close` event fires; a
 * reconnect in that gap should not receive a spurious 503.
 */
function releasingWebStream(
  upstream: IncomingMessage,
  release: () => void,
): ReadableStream<Uint8Array> {
  const source = Readable.toWeb(upstream) as unknown as ReadableStream<Uint8Array>;
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        // A peer that already closed may reject cancellation as premature.
      } finally {
        upstream.destroy();
        release();
      }
    },
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
