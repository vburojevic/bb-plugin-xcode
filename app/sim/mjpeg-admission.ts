/**
 * Pull admission for the software fallback.
 *
 * WebCodecs exposes its queue, but `createImageBitmap` does not. Without a
 * browser-owned signal the only useful pressure boundary is the work we
 * started ourselves: at two unresolved decodes, stop calling `reader.read()`.
 * That pause propagates through fetch, the private proxy and the capture host
 * instead of merely moving an unbounded queue from JavaScript into HTTP.
 *
 * Multipart chunks are already paid for. When one contains several complete
 * independent JPEGs, decoding stale members cannot improve continuity, so the
 * newest alone consumes the next slot and the earlier parts become explicit
 * telemetry rather than hidden latency.
 */

export interface MjpegPullReader {
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
}

export interface PullMjpegFramesOptions<Frame> {
  reader: MjpegPullReader;
  admission: MjpegAdmission;
  parse: (chunk: Uint8Array) => readonly Frame[];
  decode: (frame: Frame, decoderQueue: number) => Promise<void>;
  dropped: (count: number) => void;
}

export class MjpegAdmission {
  private static readonly SLOTS = 2;
  private occupied = 0;
  private peak = 0;
  private aborted = false;
  private readonly waiters: Array<(ready: boolean) => void> = [];

  constructor(signal: AbortSignal) {
    if (signal.aborted) {
      this.abort();
    } else {
      signal.addEventListener("abort", () => this.abort(), { once: true });
    }
  }

  get decoderQueuePeak(): number {
    return this.peak;
  }

  waitForRead(): Promise<boolean> {
    if (this.aborted) return Promise.resolve(false);
    if (this.occupied < MjpegAdmission.SLOTS) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => this.waiters.push(resolve));
  }

  scheduleNewest<Frame>(
    frames: readonly Frame[],
    decode: (frame: Frame, decoderQueue: number) => Promise<void>,
    dropped: (count: number) => void,
  ): boolean {
    if (this.aborted || frames.length === 0) return false;
    const stale = frames.length - 1;
    if (stale > 0) dropped(stale);
    if (this.occupied >= MjpegAdmission.SLOTS) {
      throw new Error("MJPEG decode scheduled without pull admission");
    }

    this.occupied += 1;
    this.peak = Math.max(this.peak, this.occupied);
    const decoderQueue = this.occupied;
    const newest = frames[frames.length - 1]!;
    void Promise.resolve()
      .then(() => decode(newest, decoderQueue))
      // A damaged independent JPEG costs one paint. Letting its rejection
      // escape would kill the pull loop and turn a recoverable frame into a
      // codec-ladder restart.
      .catch(() => {})
      .finally(() => this.release());
    return true;
  }

  private release(): void {
    this.occupied = Math.max(0, this.occupied - 1);
    if (this.aborted || this.occupied >= MjpegAdmission.SLOTS) return;
    this.waiters.shift()?.(true);
  }

  private abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const resolve of this.waiters.splice(0)) resolve(false);
  }
}

export async function pullMjpegFrames<Frame>(
  options: PullMjpegFramesOptions<Frame>,
): Promise<void> {
  for (;;) {
    if (!(await options.admission.waitForRead())) return;
    const { done, value } = await options.reader.read();
    if (done) return;
    if (value === undefined) continue;
    options.admission.scheduleNewest(
      options.parse(value),
      options.decode,
      options.dropped,
    );
  }
}
