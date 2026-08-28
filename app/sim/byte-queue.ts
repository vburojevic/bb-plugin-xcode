/**
 * A parser buffer that preserves the browser's pull boundary.
 *
 * Flattening every `ReadableStream.read()` into one growing allocation makes
 * network chunking dictate copy cost: a one-byte tail followed by a 250 KB
 * frame copies the whole frame before the parser even knows it is complete.
 * This deque keeps the chunks the stream already owns, reads fixed headers
 * across their seams, and allocates only when one completed payload genuinely
 * spans allocations. The ceiling is enforced before ownership transfers, so
 * a missing delimiter or corrupt length cannot turn backpressure into a heap.
 */

export class ByteQueueOverflowError extends Error {}

export class BoundedByteQueue {
  private readonly chunks: Uint8Array<ArrayBuffer>[] = [];
  private head = 0;
  private headOffset = 0;
  private bytes = 0;

  constructor(readonly ceiling: number) {
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) {
      throw new RangeError("byte queue ceiling must be a positive safe integer");
    }
  }

  get bufferedBytes(): number {
    return this.bytes;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    if (this.bytes + chunk.byteLength > this.ceiling) {
      throw new ByteQueueOverflowError(
        `byte queue would retain ${this.bytes + chunk.byteLength} bytes above ${this.ceiling}`,
      );
    }
    // Fetch chunks are ArrayBuffer-backed. Preserve their allocation; only a
    // SharedArrayBuffer caller needs a private browser-API-compatible copy.
    const owned =
      chunk.buffer instanceof ArrayBuffer
        ? (chunk as Uint8Array<ArrayBuffer>)
        : new Uint8Array(chunk);
    this.chunks.push(owned);
    this.bytes += chunk.byteLength;
  }

  byteAt(offset: number): number {
    this.assertRange(offset, 1);
    let remaining = offset;
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index]!;
      const start = index === this.head ? this.headOffset : 0;
      const available = chunk.byteLength - start;
      if (remaining < available) return chunk[start + remaining]!;
      remaining -= available;
    }
    throw new RangeError("byte queue offset is outside buffered bytes");
  }

  readUint16BE(offset: number): number {
    this.assertRange(offset, 2);
    return this.byteAt(offset) * 0x100 + this.byteAt(offset + 1);
  }

  readUint32BE(offset: number): number {
    this.assertRange(offset, 4);
    return (
      this.byteAt(offset) * 0x1_000000 +
      this.byteAt(offset + 1) * 0x1_0000 +
      this.byteAt(offset + 2) * 0x100 +
      this.byteAt(offset + 3)
    );
  }

  readBigUint64BE(offset: number): bigint {
    this.assertRange(offset, 8);
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      value = (value << 8n) | BigInt(this.byteAt(offset + index));
    }
    return value;
  }

  indexOf(needle: Uint8Array, from = 0): number {
    if (needle.byteLength === 0) return Math.min(Math.max(0, from), this.bytes);
    if (!Number.isSafeInteger(from) || from < 0) throw new RangeError("invalid search offset");
    if (from >= this.bytes) return -1;

    // KMP keeps byte-at-a-time multipart delivery linear. A naive `byteAt`
    // search starts at the deque head for every candidate and becomes
    // quadratic precisely when a proxy fragments headers most aggressively.
    const failure = new Uint32Array(needle.byteLength);
    for (let index = 1, matched = 0; index < needle.byteLength; index += 1) {
      while (matched > 0 && needle[index] !== needle[matched]) matched = failure[matched - 1]!;
      if (needle[index] === needle[matched]) matched += 1;
      failure[index] = matched;
    }

    let absolute = 0;
    let matched = 0;
    for (let index = this.head; index < this.chunks.length; index += 1) {
      const chunk = this.chunks[index]!;
      const start = index === this.head ? this.headOffset : 0;
      for (let at = start; at < chunk.byteLength; at += 1, absolute += 1) {
        if (absolute < from) continue;
        const byte = chunk[at]!;
        while (matched > 0 && byte !== needle[matched]) matched = failure[matched - 1]!;
        if (byte === needle[matched]) matched += 1;
        if (matched === needle.byteLength) return absolute - needle.byteLength + 1;
      }
    }
    return -1;
  }

  discard(count: number): void {
    this.assertRange(0, count);
    let remaining = count;
    while (remaining > 0) {
      const chunk = this.chunks[this.head]!;
      const available = chunk.byteLength - this.headOffset;
      const consumed = Math.min(available, remaining);
      this.headOffset += consumed;
      this.bytes -= consumed;
      remaining -= consumed;
      if (this.headOffset === chunk.byteLength) {
        this.head += 1;
        this.headOffset = 0;
      }
    }
    this.compact();
  }

  take(count: number): Uint8Array<ArrayBuffer> {
    this.assertRange(0, count);
    if (count === 0) return new Uint8Array(0);
    const first = this.chunks[this.head]!;
    const available = first.byteLength - this.headOffset;
    if (count <= available) {
      const payload = first.subarray(this.headOffset, this.headOffset + count);
      this.discard(count);
      return payload;
    }

    const payload = new Uint8Array(count);
    let written = 0;
    while (written < count) {
      const chunk = this.chunks[this.head]!;
      const start = this.headOffset;
      const copied = Math.min(chunk.byteLength - start, count - written);
      payload.set(chunk.subarray(start, start + copied), written);
      this.discard(copied);
      written += copied;
    }
    return payload;
  }

  private assertRange(offset: number, length: number): void {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.bytes
    ) {
      throw new RangeError("byte queue range is outside buffered bytes");
    }
  }

  private compact(): void {
    if (this.bytes === 0) {
      this.chunks.length = 0;
      this.head = 0;
      this.headOffset = 0;
      return;
    }
    if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks.splice(0, this.head);
      this.head = 0;
    }
  }
}
