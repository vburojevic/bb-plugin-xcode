import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { ConnectionLimit } from "../../src/sim/connection-limit.js";
import {
  makePresenceRouteHandler,
  makeStreamRouteHandler,
  type PrivateRouteContext,
  type PrivateStreamRouteDeps,
} from "../../src/sim/private-stream-routes.js";

const UDID = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
const ADDRESS = { port: 58123, secret: "secret", streamToken: "stream" };

function context(signal: AbortSignal = new AbortController().signal): PrivateRouteContext {
  const url = new URL(`http://127.0.0.1/stream?udid=${UDID}`);
  return {
    req: {
      query: (key) => url.searchParams.get(key) ?? undefined,
      raw: { signal },
    },
    text: (body, status = 200) => new Response(body, { status }),
  };
}

function upstream(statusCode = 200): IncomingMessage {
  return Object.assign(new PassThrough(), {
    statusCode,
    headers: { "content-type": "video/test" },
  }) as unknown as IncomingMessage;
}

function deps(over: Partial<PrivateStreamRouteDeps> = {}): PrivateStreamRouteDeps {
  return {
    currentDeviceUdid: () => UDID,
    address: () => ADDRESS,
    noteViewerOpened: () => {},
    noteViewerClosed: () => {},
    open: async () => upstream(),
    streamPath: () => "/helper/device/stream.mjpeg",
    ...over,
  };
}

describe("the private presence route", () => {
  it("returns 503 to the fifth viewer and reacquires after cancellation", async () => {
    let opened = 0;
    let closed = 0;
    const handler = makePresenceRouteHandler(
      deps({
        noteViewerOpened: () => { opened += 1; },
        noteViewerClosed: () => { closed += 1; },
      }),
      new ConnectionLimit(4),
    );
    const responses = await Promise.all(Array.from({ length: 4 }, () => handler(context())));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await handler(context())).status).toBe(503);
    expect(opened).toBe(4);

    await responses[0]!.body?.cancel();
    expect(closed).toBe(1);
    const replacement = await handler(context());
    expect(replacement.status).toBe(200);

    await Promise.all([...responses.slice(1), replacement].map((response) => response.body?.cancel()));
  });

  it("releases after request abort and a viewer-accounting failure", async () => {
    let failOpen = true;
    const handler = makePresenceRouteHandler(
      deps({
        noteViewerOpened: () => {
          if (failOpen) {
            failOpen = false;
            throw new Error("accounting failed");
          }
        },
      }),
      new ConnectionLimit(1),
    );

    await expect(handler(context())).rejects.toThrow("accounting failed");
    const controller = new AbortController();
    const response = await handler(context(controller.signal));
    expect(response.status).toBe(200);
    controller.abort();
    const replacement = await handler(context());
    expect(replacement.status).toBe(200);
    await replacement.body?.cancel();
  });
});

describe("the private stream route", () => {
  it("returns 503 to the fifth stream and reacquires after response cancellation", async () => {
    const opened: IncomingMessage[] = [];
    const handler = makeStreamRouteHandler(
      deps({
        open: async () => {
          const next = upstream();
          opened.push(next);
          return next;
        },
      }),
      new ConnectionLimit(4),
    );
    const responses = await Promise.all(Array.from({ length: 4 }, () => handler(context())));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect((await handler(context())).status).toBe(503);
    expect(opened).toHaveLength(4);

    await responses[0]!.body?.cancel();
    const replacement = await handler(context());
    expect(replacement.status).toBe(200);

    await Promise.all([...responses.slice(1), replacement].map((response) => response.body?.cancel()));
  });

  it("releases after failed and non-200 upstream opens", async () => {
    let attempt = 0;
    const handler = makeStreamRouteHandler(
      deps({
        open: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error("refused");
          return upstream(attempt === 2 ? 503 : 200);
        },
      }),
      new ConnectionLimit(1),
    );

    expect((await handler(context())).status).toBe(502);
    expect((await handler(context())).status).toBe(502);
    const response = await handler(context());
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("releases after abort while the upstream is opening", async () => {
    let resolveFirst!: (value: IncomingMessage) => void;
    const firstUpstream = new Promise<IncomingMessage>((resolve) => { resolveFirst = resolve; });
    let attempt = 0;
    const handler = makeStreamRouteHandler(
      deps({
        open: async () => {
          attempt += 1;
          if (attempt > 1) return upstream();
          return await firstUpstream;
        },
      }),
      new ConnectionLimit(1),
    );
    const controller = new AbortController();
    const pending = handler(context(controller.signal));
    controller.abort();
    resolveFirst(upstream());

    expect((await pending).status).toBe(408);
    const response = await handler(context());
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("releases when the active device changes during open", async () => {
    let current = UDID;
    let attempt = 0;
    const handler = makeStreamRouteHandler(
      deps({
        currentDeviceUdid: () => current,
        open: async () => {
          attempt += 1;
          if (attempt === 1) current = "BBBBBBBB-CCCC-DDDD-EEEE-FFFFFFFFFFFF";
          return upstream();
        },
      }),
      new ConnectionLimit(1),
    );

    expect((await handler(context())).status).toBe(409);
    current = UDID;
    const response = await handler(context());
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it("releases on upstream error and close", async () => {
    const opened: IncomingMessage[] = [];
    const handler = makeStreamRouteHandler(
      deps({
        open: async () => {
          const next = upstream();
          opened.push(next);
          return next;
        },
      }),
      new ConnectionLimit(1),
    );

    const errored = await handler(context());
    const readError = errored.body!.getReader().read().catch((error: unknown) => error);
    const errorClose = new Promise<void>((resolve) => opened[0]!.once("close", resolve));
    opened[0]!.destroy(new Error("stream failed"));
    expect(await readError).toBeInstanceOf(Error);
    await errorClose;
    const afterError = await handler(context());
    expect(afterError.status).toBe(200);
    await afterError.body?.cancel();

    const closed = await handler(context());
    const closeRead = closed.body!.getReader().read().catch((error: unknown) => error);
    const closeEvent = new Promise<void>((resolve) => opened.at(-1)!.once("close", resolve));
    opened.at(-1)!.destroy();
    expect(await closeRead).toBeInstanceOf(Error);
    await closeEvent;
    const afterClose = await handler(context());
    expect(afterClose.status).toBe(200);
    await afterClose.body?.cancel();
  });

  it("releases when viewer accounting refuses the opened stream", async () => {
    let fail = true;
    const handler = makeStreamRouteHandler(
      deps({
        noteViewerOpened: () => {
          if (fail) {
            fail = false;
            throw new Error("accounting failed");
          }
        },
      }),
      new ConnectionLimit(1),
    );

    await expect(handler(context())).rejects.toThrow("accounting failed");
    const response = await handler(context());
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
});
