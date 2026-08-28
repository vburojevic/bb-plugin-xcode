/**
 * The capture child's stream boundary, isolated from both serve-sim and the
 * bundled plugin.
 *
 * SHIPS RAW AND UNBUNDLED. The child will use this module to translate the
 * installed dependency's undocumented v1 byte stream into bb's versioned v2
 * envelope. Keeping the translation pure means Linux CI can prove the wire
 * contract without loading serve-sim's macOS native addon, while keeping any
 * future server-side import from acquiring a path to that addon.
 */

export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const V2_HEADER_BYTES = 28;
export const V2_VERSION = 2;
export const MEDIA_KIND_DESCRIPTION = 1;
export const MEDIA_KIND_KEY = 2;
export const MEDIA_KIND_DELTA = 3;
export const MEDIA_KIND_JPEG = 4;
export const MEDIA_KIND_DISCONTINUITY = 5;
export const ORIENTATION_UNKNOWN = 0;

const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

export class SimHostStreamError extends Error {}

function isV1Kind(kind) {
  return kind >= MEDIA_KIND_DESCRIPTION && kind <= MEDIA_KIND_JPEG;
}

function isV2Kind(kind) {
  return kind >= MEDIA_KIND_DESCRIPTION && kind <= MEDIA_KIND_DISCONTINUITY;
}

function appendBytes(buffer, chunk) {
  if (buffer.length === 0) return chunk;
  const next = new Uint8Array(buffer.length + chunk.length);
  next.set(buffer, 0);
  next.set(chunk, buffer.length);
  return next;
}

/**
 * Parse serve-sim's v1 records before attaching evidence to them.
 *
 * This intentionally duplicates the tiny browser-side v1 parser. Sharing it
 * would make the raw child import bundled app code, turning an architectural
 * security boundary into a build-tool convention. Their golden test is the
 * shared source of truth instead.
 */
export function createV1FrameParser() {
  let buffer = new Uint8Array(0);
  return {
    push(chunk) {
      buffer = appendBytes(buffer, chunk);
      const records = [];
      let offset = 0;
      for (;;) {
        if (buffer.length - offset < 4) break;
        const length = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0, false);
        if (length < 1 || length > MAX_FRAME_BYTES) {
          throw new SimHostStreamError(`frame length ${length} is not plausible`);
        }
        if (buffer.length - offset < 5) break;
        const kind = buffer[offset + 4];
        if (!isV1Kind(kind)) throw new SimHostStreamError(`frame kind ${kind} is not supported`);
        if (buffer.length - offset < 4 + length) break;
        records.push({
          type: kind,
          data: buffer.subarray(offset + 5, offset + 4 + length),
        });
        offset += 4 + length;
      }
      // Retaining a subarray here would pin every completed access unit while
      // waiting for the next record's four-byte length.
      buffer = offset === 0 ? buffer : buffer.slice(offset);
      return records;
    },
    pending() {
      return buffer.length;
    },
  };
}

function uint(name, value, max) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new SimHostStreamError(`${name} is outside its unsigned wire range`);
  }
  return value;
}

function pts(value) {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw new SimHostStreamError("ptsMicros is outside its unsigned wire range");
  }
  return value;
}

/** Encode one already-evidenced v2 record. Used directly by the golden test. */
export function encodeV2Record(record) {
  const kind = uint("kind", record.kind, 0xff);
  if (!isV2Kind(kind)) throw new SimHostStreamError(`frame kind ${kind} is not supported`);
  const payload = record.payload ?? new Uint8Array(0);
  if (!(payload instanceof Uint8Array)) {
    throw new SimHostStreamError("payload must be a Uint8Array");
  }
  const length = V2_HEADER_BYTES + payload.byteLength;
  if (length > MAX_FRAME_BYTES) {
    throw new SimHostStreamError(`frame length ${length} is not plausible`);
  }

  const output = new Uint8Array(4 + length);
  const view = new DataView(output.buffer);
  view.setUint32(0, length, false);
  output[4] = V2_VERSION;
  output[5] = kind;
  view.setUint16(6, uint("flags", record.flags ?? 0, 0xffff), false);
  view.setUint32(8, uint("sequence", record.sequence ?? 0, UINT32_MAX), false);
  view.setUint32(
    12,
    uint("configGeneration", record.configGeneration ?? 0, UINT32_MAX),
    false,
  );
  view.setBigUint64(16, pts(record.ptsMicros ?? 0n), false);
  view.setUint16(24, uint("codedWidth", record.codedWidth ?? 0, 0xffff), false);
  view.setUint16(26, uint("codedHeight", record.codedHeight ?? 0, 0xffff), false);
  output[28] = uint("orientation", record.orientation ?? ORIENTATION_UNKNOWN, 0xff);
  // 29..31 stay zero. Non-zero reserved bytes would make a v2 record claim
  // semantics no v2 reader understands.
  output.set(payload, 32);
  return output;
}

function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function nextCounter(name, current) {
  if (current === UINT32_MAX) throw new SimHostStreamError(`${name} exhausted its wire range`);
  return current + 1;
}

/**
 * Attach the evidence v1 cannot carry.
 *
 * Generation one is the initial upstream. A first description or geometry
 * establishes that generation rather than manufacturing a change; later byte
 * or geometry differences advance it once per record. Restart explicitly
 * advances and clears the comparison baseline, because identical avcC bytes
 * after a new native encoder still belong to a different decoder lifetime.
 */
export function createMediaEnvelopeEncoder(options = {}) {
  const nowMicros = options.nowMicros ?? (() => process.hrtime.bigint() / 1000n);
  let sequence = 0;
  let configGeneration = 1;
  let description = null;
  let geometry = null;

  const encode = (frame) => {
    const kind = uint("kind", frame.kind, 0xff);
    if (!isV2Kind(kind)) throw new SimHostStreamError(`frame kind ${kind} is not supported`);
    const payload = frame.payload ?? new Uint8Array(0);
    const codedWidth = uint("codedWidth", frame.codedWidth ?? 0, 0xffff);
    const codedHeight = uint("codedHeight", frame.codedHeight ?? 0, 0xffff);
    let changed = false;

    if (kind === MEDIA_KIND_DESCRIPTION) {
      if (description !== null && !sameBytes(description, payload)) changed = true;
      description = payload.slice();
    }
    if (codedWidth > 0 && codedHeight > 0) {
      if (
        geometry !== null &&
        (geometry.codedWidth !== codedWidth || geometry.codedHeight !== codedHeight)
      ) {
        changed = true;
      }
      geometry = { codedWidth, codedHeight };
    }
    if (changed) configGeneration = nextCounter("configGeneration", configGeneration);

    if (kind === MEDIA_KIND_KEY || kind === MEDIA_KIND_DELTA) {
      sequence = nextCounter("sequence", sequence);
    }
    const media =
      kind === MEDIA_KIND_KEY || kind === MEDIA_KIND_DELTA || kind === MEDIA_KIND_JPEG;
    const orientation =
      frame.orientationValidated === true &&
      Number.isInteger(frame.orientation) &&
      frame.orientation >= 1 &&
      frame.orientation <= 4 &&
      geometry !== null &&
      geometry.codedWidth === codedWidth &&
      geometry.codedHeight === codedHeight
        ? frame.orientation
        : ORIENTATION_UNKNOWN;

    return encodeV2Record({
      kind,
      flags: frame.flags ?? 0,
      sequence,
      configGeneration,
      ptsMicros: media ? nowMicros() : 0n,
      codedWidth,
      codedHeight,
      orientation,
      payload,
    });
  };

  return {
    encode,
    upstreamRestart() {
      configGeneration = nextCounter("configGeneration", configGeneration);
      description = null;
      geometry = null;
      return encodeV2Record({
        kind: MEDIA_KIND_DISCONTINUITY,
        sequence,
        configGeneration,
      });
    },
  };
}

export const MEDIA_ENVELOPE_V2_CONTENT_TYPE = "application/vnd.bb.sim-avcc;version=2";
const MAX_AVCC_NAL_UNITS = 256;

function avccNalLengthSize(description) {
  if (description.length < 7 || description[0] !== 1) return null;
  const lengthSize = (description[4] & 0x03) + 1;
  if (lengthSize === 3) return null;
  const spsCount = description[5] & 0x1f;
  if (spsCount === 0) return null;
  let offset = 6;
  const skip = (count, expectedType) => {
    for (let index = 0; index < count; index += 1) {
      if (offset + 2 > description.length) return false;
      const length = description[offset] * 256 + description[offset + 1];
      offset += 2;
      if (length === 0 || length > description.length - offset) return false;
      if ((description[offset] & 0x1f) !== expectedType) return false;
      offset += length;
    }
    return true;
  };
  if (!skip(spsCount, 7) || offset >= description.length) return null;
  const ppsCount = description[offset];
  offset += 1;
  if (ppsCount === 0 || !skip(ppsCount, 8)) return null;
  return lengthSize;
}

function avccAccessUnitHasIdr(data, nalLengthSize) {
  if (!Number.isInteger(nalLengthSize) || nalLengthSize < 1 || nalLengthSize > 4) return false;
  let offset = 0;
  let units = 0;
  let found = false;
  while (offset < data.length) {
    if (units >= MAX_AVCC_NAL_UNITS || offset + nalLengthSize > data.length) return false;
    units += 1;
    let length = 0;
    for (let index = 0; index < nalLengthSize; index += 1) {
      length = length * 256 + data[offset + index];
    }
    offset += nalLengthSize;
    if (length === 0 || length > data.length - offset) return false;
    if ((data[offset] & 0x1f) === 5) found = true;
    offset += length;
  }
  return found;
}

function immutableBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function generationOf(packet) {
  return packet.readUInt32BE(12);
}

function sameBuffer(left, right) {
  return left.length === right.length && Buffer.compare(left, right) === 0;
}

/**
 * One native encoder feeds every AVCC viewer of a simulator.
 *
 * The middleware's encoder callback awaits one response's drain, so sharing its
 * subscription directly would let the slowest browser throttle capture for
 * everybody. This fanout instead consumes one loopback upstream at full pace,
 * hands the same immutable record Buffer to every writable response, and turns
 * a slow response into an explicit decoder resync. Restarting is deliberately
 * the only keyframe request: published serve-sim exposes no force-IDR API.
 */
export class SharedAvccFanout {
  constructor(options) {
    this.options = options;
    this.sessions = new Map();
  }

  attach(udid, response) {
    const state = this.stateFor(udid);
    const viewer = {
      response,
      blocked: false,
      waitingForSync: true,
      closed: false,
      onClose: null,
      onDrain: null,
    };
    viewer.onClose = () => this.detach(state, viewer);
    response.once("close", viewer.onClose);
    response.once("error", viewer.onClose);
    response.writeHead(200, {
      "Content-Type": MEDIA_ENVELOPE_V2_CONTENT_TYPE,
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    state.viewers.add(viewer);

    // Viewers mounted in one turn are one opening cohort. A genuinely later
    // join restarts the encoder so it cannot begin on a delta frame.
    if (state.upstream !== null || state.opening || state.generation > 0) {
      this.request(state, "restart");
    } else {
      this.request(state, "start");
    }
  }

  status(udid) {
    const state = this.sessions.get(udid);
    if (state === undefined) {
      return {
        viewers: 0,
        upstreamEncoders: 0,
        generation: 0,
        restarts: 0,
        slowViewerDrops: 0,
        lastPacketAgeMs: null,
      };
    }
    return {
      viewers: state.viewers.size,
      upstreamEncoders: state.upstream !== null || state.opening ? 1 : 0,
      generation: state.generation,
      restarts: state.restarts,
      slowViewerDrops: state.slowViewerDrops,
      lastPacketAgeMs:
        state.lastPacketAt === null
          ? null
          : Math.max(0, (this.options.nowMs ?? Date.now)() - state.lastPacketAt),
    };
  }

  stateFor(udid) {
    const existing = this.sessions.get(udid);
    if (existing !== undefined) return existing;
    const state = {
      udid,
      viewers: new Set(),
      upstream: null,
      opening: false,
      openingController: null,
      transition: Promise.resolve(),
      scheduled: false,
      requested: null,
      restartPending: false,
      drainRestartPending: false,
      parser: createV1FrameParser(),
      envelope: createMediaEnvelopeEncoder({ nowMicros: this.options.nowMicros }),
      description: null,
      nalLengthSize: null,
      synced: false,
      generation: 0,
      restarts: 0,
      slowViewerDrops: 0,
      lastPacketAt: null,
    };
    this.sessions.set(udid, state);
    return state;
  }

  request(state, action) {
    if (action === "restart") {
      if (state.restartPending) return;
      state.restartPending = true;
      // Fence the old encoder synchronously. Its next `data` event can arrive
      // before the queued transition closes it, and no byte from that epoch is
      // safe once recovery evidence has failed.
      state.synced = false;
      state.description = null;
      state.nalLengthSize = null;
      this.cancelOpening(state);
    }
    if (action === "restart" || state.requested === null) state.requested = action;
    if (state.scheduled) return;
    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      const requested = state.requested;
      state.requested = null;
      if (requested === null) return;
      state.transition = state.transition
        .then(() => this.transition(state, requested === "restart"))
        .catch((error) => this.fail(state, error));
    });
  }

  async transition(state, restarting) {
    if (state.viewers.size === 0) {
      state.restartPending = false;
      await this.closeUpstream(state);
      return;
    }
    if (restarting) {
      state.restarts += 1;
      state.synced = false;
      state.description = null;
      state.nalLengthSize = null;
      state.parser = createV1FrameParser();
      const discontinuity = immutableBuffer(state.envelope.upstreamRestart());
      state.generation = generationOf(discontinuity);
      this.broadcast(state, discontinuity, MEDIA_KIND_DISCONTINUITY);
      await this.closeUpstream(state);
    } else if (state.upstream !== null || state.opening) {
      return;
    }
    if (state.viewers.size === 0) return;

    state.opening = true;
    const opening = new AbortController();
    state.openingController = opening;
    let upstream;
    try {
      upstream = await this.options.openUpstream(state.udid, opening.signal);
    } catch (error) {
      if (opening.signal.aborted) return;
      throw error;
    } finally {
      if (state.openingController === opening) {
        state.openingController = null;
        state.opening = false;
      }
    }
    if (opening.signal.aborted || state.viewers.size === 0) {
      upstream.destroy();
      return;
    }
    if (upstream.statusCode !== 200) {
      upstream.destroy();
      throw new SimHostStreamError(`AVCC upstream answered ${upstream.statusCode ?? 0}`);
    }
    state.upstream = upstream;
    // Requests against this fresh encoder are a new recovery epoch. Repeated
    // evidence from the old byte stream cannot queue a second transition.
    state.restartPending = false;
    upstream.on("data", (chunk) => this.consume(state, upstream, chunk));
    const ended = () => {
      if (state.upstream !== upstream) return;
      state.upstream = null;
      for (const viewer of [...state.viewers]) viewer.response.destroy();
    };
    upstream.once("end", ended);
    upstream.once("error", ended);
    upstream.once("close", ended);
  }

  consume(state, upstream, chunk) {
    if (state.upstream !== upstream || state.restartPending) return;
    let frames;
    try {
      frames = state.parser.push(chunk);
    } catch (error) {
      this.request(state, "restart");
      return;
    }
    for (const frame of frames) {
      state.lastPacketAt = (this.options.nowMs ?? Date.now)();
      if (frame.type === MEDIA_KIND_DESCRIPTION) {
        const lengthSize = avccNalLengthSize(frame.data);
        if (lengthSize === null) {
          this.request(state, "restart");
          return;
        }
        if (state.description !== null && !sameBuffer(state.description, frame.data)) {
          this.request(state, "restart");
          return;
        }
        state.description = Buffer.from(frame.data);
        state.nalLengthSize = lengthSize;
      } else if (frame.type === MEDIA_KIND_KEY) {
        if (
          state.nalLengthSize === null ||
          !avccAccessUnitHasIdr(frame.data, state.nalLengthSize)
        ) {
          this.request(state, "restart");
          return;
        }
        state.synced = true;
        state.drainRestartPending = false;
      } else if (frame.type === MEDIA_KIND_DELTA && !state.synced) {
        this.request(state, "restart");
        return;
      }

      const packet = immutableBuffer(state.envelope.encode({
        kind: frame.type,
        payload: frame.data,
      }));
      state.generation = generationOf(packet);
      this.broadcast(state, packet, frame.type);
    }
  }

  broadcast(state, packet, kind) {
    for (const viewer of state.viewers) {
      if (viewer.closed) continue;
      if (viewer.blocked) {
        state.slowViewerDrops += 1;
        continue;
      }
      if (viewer.waitingForSync && kind === MEDIA_KIND_DELTA) continue;
      let writable = false;
      try {
        writable = viewer.response.write(packet);
      } catch {
        this.detach(state, viewer);
        continue;
      }
      if (writable && kind === MEDIA_KIND_KEY) viewer.waitingForSync = false;
      if (writable) continue;
      state.slowViewerDrops += 1;
      viewer.blocked = true;
      viewer.waitingForSync = true;
      viewer.onDrain = () => {
        viewer.onDrain = null;
        if (viewer.closed) return;
        viewer.blocked = false;
        // Several slow viewers usually drain in different turns. They all
        // missed the same sync point, so one replacement encoder repairs the
        // cohort; another restart before its verified IDR is only churn.
        if (!state.drainRestartPending) {
          state.drainRestartPending = true;
          this.request(state, "restart");
        }
      };
      viewer.response.once("drain", viewer.onDrain);
    }
  }

  detach(state, viewer) {
    if (viewer.closed) return;
    viewer.closed = true;
    viewer.response.off("close", viewer.onClose);
    viewer.response.off("error", viewer.onClose);
    if (viewer.onDrain !== null) viewer.response.off("drain", viewer.onDrain);
    state.viewers.delete(viewer);
    if (state.viewers.size !== 0) return;
    state.restartPending = false;
    state.drainRestartPending = false;
    // Last-viewer teardown is deliberately synchronous at the socket boundary;
    // waiting for another transition would retain VideoToolbox work nobody can
    // observe.
    const upstream = state.upstream;
    state.upstream = null;
    upstream?.destroy();
    this.cancelOpening(state);
  }

  async closeUpstream(state) {
    this.cancelOpening(state);
    const upstream = state.upstream;
    state.upstream = null;
    if (upstream === null || upstream.destroyed) return;
    await new Promise((resolve) => {
      upstream.once("close", resolve);
      upstream.destroy();
    });
  }

  fail(state, error) {
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics cannot retain an upstream or a viewer.
    }
    void this.closeUpstream(state);
    for (const viewer of [...state.viewers]) viewer.response.destroy();
  }

  cancelOpening(state) {
    const opening = state.openingController;
    state.openingController = null;
    state.opening = false;
    opening?.abort();
  }
}
