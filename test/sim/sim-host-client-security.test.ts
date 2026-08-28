import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  grabFrame,
  MAX_JPEG_FRAME_BYTES,
  open,
  streamStatus,
} from "../../src/sim/sim-host-client.js";
import type { Ctx } from "../../src/sim/context.js";
import { makeCaptureTool, makeStreamStatusTool } from "../../src/sim/tools.js";

const UDID = "11111111-2222-3333-4444-555555555555";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function addressFor(body: string | Buffer): Promise<{ port: number; secret: string; streamToken: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    res.end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    secret: "s".repeat(43),
    streamToken: "v".repeat(43),
  };
}

describe("the first-frame reader", () => {
  it("reads exactly one bounded multipart body", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const header = Buffer.from(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    const address = await addressFor(Buffer.concat([header, jpeg, Buffer.from("ignored")]));
    expect(await grabFrame(address, UDID)).toEqual(jpeg);
  });

  it("rejects missing, zero, and oversized part lengths before allocating", async () => {
    for (const header of [
      "--frame\r\nContent-Type: image/jpeg\r\n\r\n",
      "--frame\r\nContent-Length: 0\r\n\r\n",
      `--frame\r\nContent-Length: ${MAX_JPEG_FRAME_BYTES + 1}\r\n\r\n`,
    ]) {
      const address = await addressFor(header);
      await expect(grabFrame(address, UDID)).rejects.toThrow(/Content-Length|safety limit/);
    }
  });
});

describe("request cancellation", () => {
  it("rejects an already-aborted caller", async () => {
    const address = await addressFor("unused");
    const controller = new AbortController();
    controller.abort();
    await expect(
      open(address, {
        method: "GET",
        path: `/helper/${UDID}/stream.mjpeg`,
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });
});

describe("stream status", () => {
  it("uses the master header and accepts only the bounded host counter shape", async () => {
    let seenPath = "";
    let seenSecret: string | string[] | undefined;
    const server = createServer((req, res) => {
      seenPath = req.url ?? "";
      seenSecret = req.headers["x-xcode-simulators-key"];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        viewers: 2,
        upstreamEncoders: 1,
        generation: 4,
        restarts: 3,
        slowViewerDrops: 7,
        lastPacketAgeMs: 12,
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = {
      port: (server.address() as AddressInfo).port,
      secret: "master-secret-value-that-is-long-enough",
      streamToken: "stream-key-value-that-is-long-enough",
    };

    expect(await streamStatus(address, UDID)).toEqual({
      viewers: 2,
      upstreamEncoders: 1,
      generation: 4,
      restarts: 3,
      slowViewerDrops: 7,
      lastPacketAgeMs: 12,
    });
    expect(seenPath).toBe(`/helper/${UDID}/stream-status`);
    expect(seenSecret).toBe(address.secret);
  });

  it("queries fanout counters only when capture or status evidence is requested", async () => {
    const release = vi.fn();
    const ctx = {
      settings: () => ({ allowAgentCapture: true }),
      live: {
        state: () => ({ device: { udid: UDID }, generation: 4 }),
        address: () => ({ port: 59_505, secret: "master", streamToken: "stream" }),
      },
      leases: { acquire: () => ({ ok: true, release }) },
    } as unknown as Ctx;
    const status = vi.fn(async () => ({
      viewers: 2,
      upstreamEncoders: 1 as const,
      generation: 4,
      restarts: 3,
      slowViewerDrops: 7,
      lastPacketAgeMs: 12,
    }));
    const statusTool = makeStreamStatusTool(ctx, undefined, { status });
    const captureTool = makeCaptureTool(ctx, undefined, {
      capture: vi.fn(async () => ({
        frameId: "frame-1",
        summary: "Captured the simulator.",
      })) as never,
      encode: vi.fn(async () => null) as never,
      status,
    });

    expect(status).not.toHaveBeenCalled();
    const statusResult = await statusTool.execute();
    expect(status).toHaveBeenCalledTimes(1);
    expect(statusResult.content[0]?.type === "text" ? statusResult.content[0].text : "").toContain(
      '"upstreamEncoders": 1',
    );

    const captureResult = await captureTool.execute({}, { threadId: "thread-1" });
    expect(status).toHaveBeenCalledTimes(2);
    expect(captureResult.content[0]?.type === "text" ? captureResult.content[0].text : "").toContain(
      "Host fanout: 2 viewers; 1 upstream encoder",
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
