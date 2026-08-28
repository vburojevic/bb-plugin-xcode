import { describe, expect, it } from "vitest";

import { BoundedByteQueue, ByteQueueOverflowError } from "../../app/sim/byte-queue.js";

describe("the bounded byte queue", () => {
  it("reads scalar headers across chunk boundaries without flattening the queue", () => {
    const queue = new BoundedByteQueue(16);
    queue.push(new Uint8Array([0x01]));
    queue.push(new Uint8Array([0x02, 0x03]));
    queue.push(new Uint8Array([0x04, 0x05, 0x06, 0x07, 0x08]));

    expect(queue.readUint16BE(1)).toBe(0x0203);
    expect(queue.readUint32BE(2)).toBe(0x03040506);
    expect(queue.readBigUint64BE(0)).toBe(0x0102030405060708n);
    expect(queue.bufferedBytes).toBe(8);
  });

  it("transfers a contiguous payload view and only materializes a cross-chunk payload", () => {
    const contiguous = new Uint8Array([1, 2, 3, 4]);
    const queue = new BoundedByteQueue(16);
    queue.push(contiguous);
    const view = queue.take(3);

    expect(view.buffer).toBe(contiguous.buffer);
    expect([...view]).toEqual([1, 2, 3]);

    const left = new Uint8Array([5, 6]);
    const right = new Uint8Array([7, 8]);
    queue.push(left);
    queue.push(right);
    queue.discard(1);
    const joined = queue.take(4);

    expect([...joined]).toEqual([5, 6, 7, 8]);
    expect(joined.buffer).not.toBe(left.buffer);
    expect(joined.buffer).not.toBe(right.buffer);
    expect(joined.byteOffset).toBe(0);
    expect(joined.buffer.byteLength).toBe(4);
  });

  it("rejects before retaining more than its configured ceiling", () => {
    const queue = new BoundedByteQueue(5);
    queue.push(new Uint8Array([1, 2]));
    queue.push(new Uint8Array([3, 4, 5]));

    expect(() => queue.push(new Uint8Array([6]))).toThrow(ByteQueueOverflowError);
    expect(queue.bufferedBytes).toBe(5);
    expect([...queue.take(5)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("finds a delimiter split across every chunk edge", () => {
    const bytes = new Uint8Array([1, 13, 10, 13, 10, 2]);
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const queue = new BoundedByteQueue(16);
      queue.push(bytes.subarray(0, cut));
      queue.push(bytes.subarray(cut));
      expect(queue.indexOf(new Uint8Array([13, 10, 13, 10])), `cut at ${cut}`).toBe(1);
    }
  });
});
