/**
 * The raw child owns the one translation boundary we cannot put in the bundle:
 * serve-sim emits v1 records with no timing or continuity evidence, while the
 * panel needs a versioned stream it can validate before touching WebCodecs.
 * These tests import only our raw helper, never serve-sim, so Linux CI exercises
 * the same bytes the Mac child will eventually put on the wire.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

interface V1Frame {
  type: number;
  data: Uint8Array;
}

interface RawStreamModule {
  MAX_FRAME_BYTES: number;
  V2_HEADER_BYTES: number;
  createV1FrameParser(): {
    push(chunk: Uint8Array): V1Frame[];
    pending(): number;
  };
  encodeV2Record(record: {
    kind: number;
    flags?: number;
    sequence?: number;
    configGeneration?: number;
    ptsMicros?: bigint;
    codedWidth?: number;
    codedHeight?: number;
    orientation?: number;
    payload?: Uint8Array;
  }): Uint8Array;
  createMediaEnvelopeEncoder(options?: { nowMicros?: () => bigint }): {
    encode(frame: {
      kind: number;
      payload?: Uint8Array;
      flags?: number;
      codedWidth?: number;
      codedHeight?: number;
      orientation?: number;
      orientationValidated?: boolean;
    }): Uint8Array;
    upstreamRestart(): Uint8Array;
  };
  SharedAvccFanout: new (options: {
    openUpstream(udid: string): Promise<PassThrough & { statusCode: number; headers: Record<string, string> }>;
    nowMicros?: () => bigint;
    nowMs?: () => number;
  }) => {
    attach(udid: string, response: ViewerResponse): void;
    status(udid: string): {
      viewers: number;
      upstreamEncoders: number;
      generation: number;
      restarts: number;
      slowViewerDrops: number;
      lastPacketAgeMs: number | null;
    };
  };
}

const raw = (await import(
  new URL("../../sim-host-stream.mjs", import.meta.url).href
)) as RawStreamModule;

function v1Frame(type: number, payload: number[]): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length + 1, false);
  out[4] = type;
  out.set(payload, 5);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function header(record: Uint8Array): DataView {
  return new DataView(record.buffer, record.byteOffset, record.byteLength);
}

const AVCC_1 = [1, 100, 0, 51, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68];
const AVCC_2 = [1, 66, 0, 30, 0xff, 0xe1, 0, 1, 0x67, 1, 0, 1, 0x68];

class ViewerResponse extends EventEmitter {
  readonly headers = new Map<string, string>();
  readonly writes: Buffer[] = [];
  statusCode = 0;
  writableEnded = false;
  destroyed = false;
  blockNext = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.headers.set(name.toLowerCase(), value);
    return this;
  }

  write(chunk: Uint8Array): boolean {
    const packet = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.writes.push(packet);
    if (!this.blockNext) return true;
    this.blockNext = false;
    return false;
  }

  end(): this {
    if (this.writableEnded) return this;
    this.writableEnded = true;
    this.emit("close");
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function kinds(viewer: ViewerResponse): number[] {
  return viewer.writes.map((packet) => packet[5]!);
}

function makeUpstreams() {
  const opened: Array<PassThrough & { statusCode: number; headers: Record<string, string> }> = [];
  let active = 0;
  let peak = 0;
  return {
    opened,
    active: () => active,
    peak: () => peak,
    async open() {
      const stream = Object.assign(new PassThrough(), {
        statusCode: 200,
        headers: { "content-type": "application/octet-stream" },
      });
      active += 1;
      peak = Math.max(peak, active);
      stream.once("close", () => { active -= 1; });
      opened.push(stream);
      return stream;
    },
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("the child-side v1 parser", () => {
  it("survives every byte boundary and returns multiple records from one chunk", () => {
    const whole = concat(v1Frame(1, [1, 100, 0, 51]), v1Frame(2, [0, 0, 0, 2, 0x65, 0x88]));
    for (let cut = 1; cut < whole.length; cut += 1) {
      const parser = raw.createV1FrameParser();
      const records = [...parser.push(whole.subarray(0, cut)), ...parser.push(whole.subarray(cut))];
      expect(records.map((record) => record.type), `cut at ${cut}`).toEqual([1, 2]);
      expect([...records[1]!.data], `cut at ${cut}`).toEqual([0, 0, 0, 2, 0x65, 0x88]);
      expect(parser.pending(), `cut at ${cut}`).toBe(0);
    }

    expect(raw.createV1FrameParser().push(whole)).toHaveLength(2);
  });

  it("rejects malformed kinds and lengths before buffering attacker-sized records", () => {
    expect(() => raw.createV1FrameParser().push(v1Frame(9, []))).toThrow(/kind 9/);

    const zero = new Uint8Array(5);
    expect(() => raw.createV1FrameParser().push(zero)).toThrow(/length 0/);

    const huge = new Uint8Array(5);
    new DataView(huge.buffer).setUint32(0, raw.MAX_FRAME_BYTES + 1, false);
    expect(() => raw.createV1FrameParser().push(huge)).toThrow(/not plausible/);
  });
});

describe("the child-side v2 encoder", () => {
  it("writes the byte-exact 28-byte header including an unsigned 64-bit PTS", () => {
    const encoded = raw.encodeV2Record({
      kind: 2,
      flags: 0x1234,
      sequence: 0x1020_3040,
      configGeneration: 0x5060_7080,
      ptsMicros: 0x1122_3344_5566_7788n,
      codedWidth: 1_206,
      codedHeight: 2_622,
      orientation: 3,
      payload: new Uint8Array([0xaa, 0xbb]),
    });
    const view = header(encoded);

    expect(view.getUint32(0, false)).toBe(30);
    expect([...encoded.subarray(4, 32)]).toEqual([
      2, 2, 0x12, 0x34,
      0x10, 0x20, 0x30, 0x40,
      0x50, 0x60, 0x70, 0x80,
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
      0x04, 0xb6, 0x0a, 0x3e,
      3, 0, 0, 0,
    ]);
    expect([...encoded.subarray(32)]).toEqual([0xaa, 0xbb]);
  });

  it("increments only coded sequence and advances generation on real config boundaries", () => {
    const times = [1_000n, 2_000n, 3_000n, 4_000n];
    const encoder = raw.createMediaEnvelopeEncoder({ nowMicros: () => times.shift()! });
    const description1 = encoder.encode({
      kind: 1,
      payload: new Uint8Array([1, 100, 0, 51]),
      codedWidth: 1_206,
      codedHeight: 2_622,
      orientation: 1,
      orientationValidated: false,
    });
    const key = encoder.encode({
      kind: 2,
      payload: new Uint8Array([0x65]),
      codedWidth: 1_206,
      codedHeight: 2_622,
      orientation: 1,
      orientationValidated: true,
    });
    const description2 = encoder.encode({
      kind: 1,
      payload: new Uint8Array([1, 66, 0, 30]),
      codedWidth: 1_206,
      codedHeight: 2_622,
    });
    const delta = encoder.encode({
      kind: 3,
      payload: new Uint8Array([0x41]),
      codedWidth: 2_622,
      codedHeight: 1_206,
    });
    const restart = encoder.upstreamRestart();

    expect(header(description1).getUint32(8, false)).toBe(0);
    expect(header(key).getUint32(8, false)).toBe(1);
    expect(header(description2).getUint32(8, false)).toBe(1);
    expect(header(delta).getUint32(8, false)).toBe(2);
    expect(header(restart).getUint32(8, false)).toBe(2);

    expect(header(description1).getUint32(12, false)).toBe(1);
    expect(header(key).getUint32(12, false)).toBe(1);
    expect(header(description2).getUint32(12, false)).toBe(2);
    expect(header(delta).getUint32(12, false)).toBe(3);
    expect(header(restart).getUint32(12, false)).toBe(4);

    expect(header(description1).getBigUint64(16, false)).toBe(0n);
    expect(header(key).getBigUint64(16, false)).toBe(1_000n);
    expect(header(delta).getBigUint64(16, false)).toBe(2_000n);
    expect(header(restart).getBigUint64(16, false)).toBe(0n);
    expect(description1[28]).toBe(0);
    expect(key[28]).toBe(1);
    expect(restart[5]).toBe(5);
  });

  it("rejects invalid records and anything above the shared 32 MiB ceiling", () => {
    expect(() => raw.encodeV2Record({ kind: 0 })).toThrow(/kind 0/);
    expect(() => raw.encodeV2Record({ kind: 6 })).toThrow(/kind 6/);
    expect(() => raw.encodeV2Record({ kind: 2, ptsMicros: -1n })).toThrow(/ptsMicros/);

    const tooLarge = new Uint8Array(raw.MAX_FRAME_BYTES - raw.V2_HEADER_BYTES + 1);
    expect(() => raw.encodeV2Record({ kind: 2, payload: tooLarge })).toThrow(/not plausible/);
  });
});

describe("the child-side shared AVCC fanout", () => {
  it("opens one upstream for four viewers and reuses each evidenced packet byte-for-byte", async () => {
    const upstreams = makeUpstreams();
    const times = [100n, 200n, 300n];
    const fanout = new raw.SharedAvccFanout({
      openUpstream: () => upstreams.open(),
      nowMicros: () => times.shift()!,
      nowMs: () => 1_000,
    });
    const viewers = Array.from({ length: 4 }, () => new ViewerResponse());
    for (const viewer of viewers) fanout.attach("device-a", viewer);
    await flush();

    expect(upstreams.opened).toHaveLength(1);
    expect(upstreams.peak()).toBe(1);
    expect(fanout.status("device-a")).toMatchObject({ viewers: 4, upstreamEncoders: 1 });

    upstreams.opened[0]!.write(concat(
      v1Frame(1, AVCC_1),
      v1Frame(2, [0, 0, 0, 2, 0x65, 0x88]),
      v1Frame(3, [0, 0, 0, 2, 0x41, 0x99]),
    ));
    await flush();

    expect(viewers.map(kinds)).toEqual(Array.from({ length: 4 }, () => [1, 2, 3]));
    for (const index of [0, 1, 2]) {
      expect(viewers[0]!.writes[index]).toBe(viewers[1]!.writes[index]);
      expect(viewers[1]!.writes[index]).toBe(viewers[2]!.writes[index]);
      expect(viewers[2]!.writes[index]).toBe(viewers[3]!.writes[index]);
    }
    expect(viewers.map((viewer) => [
      header(viewer.writes[1]!).getUint32(8, false),
      header(viewer.writes[1]!).getBigUint64(16, false),
      header(viewer.writes[2]!).getUint32(8, false),
      header(viewer.writes[2]!).getBigUint64(16, false),
    ])).toEqual(Array.from({ length: 4 }, () => [1, 100n, 2, 200n]));
    expect(viewers[0]!.headers.get("content-type")).toBe("application/vnd.bb.sim-avcc;version=2");

    for (const viewer of viewers) viewer.destroy();
    await flush();
    expect(upstreams.active()).toBe(0);
    expect(fanout.status("device-a")).toMatchObject({ viewers: 0, upstreamEncoders: 0 });
  });

  it("does not let stalled viewers block healthy ones and coalesces their drains into one restart", async () => {
    const upstreams = makeUpstreams();
    let now = 10_000;
    const fanout = new raw.SharedAvccFanout({
      openUpstream: () => upstreams.open(),
      nowMicros: () => BigInt(now++),
      nowMs: () => now,
    });
    const healthy = new ViewerResponse();
    const slowA = new ViewerResponse();
    const slowB = new ViewerResponse();
    fanout.attach("device-a", healthy);
    fanout.attach("device-a", slowA);
    fanout.attach("device-a", slowB);
    await flush();
    upstreams.opened[0]!.write(concat(
      v1Frame(1, AVCC_1),
      v1Frame(2, [0, 0, 0, 2, 0x65, 0x88]),
    ));
    await flush();

    slowA.blockNext = true;
    slowB.blockNext = true;
    upstreams.opened[0]!.write(v1Frame(3, [0, 0, 0, 2, 0x41, 0x01]));
    upstreams.opened[0]!.write(v1Frame(3, [0, 0, 0, 2, 0x41, 0x02]));
    await flush();
    expect(kinds(healthy)).toEqual([1, 2, 3, 3]);
    expect(kinds(slowA)).toEqual([1, 2, 3]);
    expect(kinds(slowB)).toEqual([1, 2, 3]);

    slowA.emit("drain");
    await flush();
    expect(upstreams.opened).toHaveLength(2);
    slowB.emit("drain");
    await flush();
    expect(upstreams.opened).toHaveLength(2);
    expect(upstreams.peak()).toBe(1);
    expect(fanout.status("device-a")).toMatchObject({
      upstreamEncoders: 1,
      restarts: 1,
      slowViewerDrops: 5,
    });
    expect(kinds(healthy).at(-1)).toBe(5);

    upstreams.opened[1]!.write(concat(
      v1Frame(1, AVCC_1),
      // The key tag lies: this is a non-IDR slice and must not release deltas.
      v1Frame(2, [0, 0, 0, 2, 0x41, 0x44]),
      v1Frame(3, [0, 0, 0, 2, 0x41, 0x55]),
    ));
    await flush();
    expect(upstreams.opened).toHaveLength(3);
    expect(upstreams.peak()).toBe(1);

    upstreams.opened[2]!.write(concat(
      v1Frame(1, AVCC_1),
      v1Frame(2, [0, 0, 0, 2, 0x65, 0x66]),
      v1Frame(3, [0, 0, 0, 2, 0x41, 0x77]),
    ));
    await flush();
    for (const viewer of [healthy, slowA, slowB]) {
      const lastDiscontinuity = kinds(viewer).lastIndexOf(5);
      expect(kinds(viewer).slice(lastDiscontinuity)).toEqual([5, 1, 2, 3]);
    }
    expect(fanout.status("device-a")).toMatchObject({ generation: 3, restarts: 2 });
  });

  it("restarts before admitting a new viewer or a changed decoder description", async () => {
    const upstreams = makeUpstreams();
    const fanout = new raw.SharedAvccFanout({ openUpstream: () => upstreams.open() });
    const first = new ViewerResponse();
    fanout.attach("device-a", first);
    await flush();
    upstreams.opened[0]!.write(concat(
      v1Frame(1, AVCC_1),
      v1Frame(2, [0, 0, 0, 2, 0x65, 0x01]),
    ));
    await flush();

    const joiner = new ViewerResponse();
    fanout.attach("device-a", joiner);
    await flush();
    expect(upstreams.opened).toHaveLength(2);
    expect(upstreams.opened[0]!.destroyed).toBe(true);
    expect(kinds(first).at(-1)).toBe(5);
    expect(kinds(joiner)).toEqual([5]);

    upstreams.opened[1]!.write(concat(
      v1Frame(1, AVCC_1),
      v1Frame(2, [0, 0, 0, 2, 0x65, 0x02]),
      v1Frame(1, AVCC_2),
    ));
    await flush();
    expect(upstreams.opened).toHaveLength(3);
    expect(upstreams.opened[1]!.destroyed).toBe(true);
    expect(upstreams.peak()).toBe(1);
    expect(kinds(joiner)).toEqual([5, 1, 2, 5]);
    expect(joiner.writes.map((packet) => header(packet).getUint32(12, false))).toEqual([2, 2, 2, 3]);
    expect(fanout.status("device-a")).toMatchObject({ generation: 3, restarts: 2 });
  });
});
