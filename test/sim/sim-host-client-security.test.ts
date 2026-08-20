import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { grabFrame, MAX_JPEG_FRAME_BYTES, open } from "../../src/sim/sim-host-client.js";

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
