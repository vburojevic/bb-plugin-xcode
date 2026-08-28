import { describe, expect, it } from "vitest";

import { H264SyncGate } from "../../app/sim/h264-sync.js";

const DESCRIPTION_1 = new Uint8Array([
  0x01, 0x64, 0x00, 0x33, 0xff,
  0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x33,
  0x01, 0x00, 0x02, 0x68, 0xee,
]);
const DESCRIPTION_2 = new Uint8Array([
  0x01, 0x42, 0xc0, 0x1e, 0xff,
  0xe1, 0x00, 0x04, 0x67, 0x42, 0xc0, 0x1e,
  0x01, 0x00, 0x02, 0x68, 0xce,
]);
const IDR = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x65, 0x88]);
const DELTA = new Uint8Array([0x00, 0x00, 0x00, 0x02, 0x41, 0x9a]);

describe("H.264 decoder sync", () => {
  it("accepts description, then a verified IDR, then deltas", () => {
    const gate = new H264SyncGate();

    expect(gate.state).toBe("needs-description");
    expect(gate.acceptAccessUnit("key", IDR).decode).toBeNull();
    expect(gate.acceptDescription(DESCRIPTION_1)).toMatchObject({
      configuration: { codec: "avc1.640033", generation: 1, nalLengthSize: 4 },
      resync: null,
    });
    expect(gate.state).toBe("waiting-for-IDR");
    expect(gate.acceptAccessUnit("key", IDR)).toMatchObject({ decode: "key", recovered: true });
    expect(gate.state).toBe("decoding");
    expect(gate.acceptAccessUnit("delta", DELTA)).toMatchObject({ decode: "delta", recovered: false });
  });

  it("submits no delta across an overload drop until another IDR", () => {
    const gate = new H264SyncGate();
    gate.acceptDescription(DESCRIPTION_1);
    gate.acceptAccessUnit("key", IDR);

    expect(gate.droppedAccessUnit()).toBe("drop");
    expect(gate.state).toBe("waiting-for-IDR");
    expect(gate.acceptAccessUnit("delta", DELTA).decode).toBeNull();
    expect(gate.acceptAccessUnit("key", DELTA)).toMatchObject({ decode: null, resync: null });
    expect(gate.acceptAccessUnit("delta", DELTA).decode).toBeNull();
    expect(gate.acceptAccessUnit("key", IDR)).toMatchObject({ decode: "key", recovered: true });
    expect(gate.acceptAccessUnit("delta", DELTA).decode).toBe("delta");
  });

  it("rejects a false key tag that contains no IDR", () => {
    const gate = new H264SyncGate();
    gate.acceptDescription(DESCRIPTION_1);

    expect(gate.acceptAccessUnit("key", DELTA)).toMatchObject({ decode: null, recovered: false });
    expect(gate.state).toBe("waiting-for-IDR");
  });

  it("rebuilds after decoder error from the cached valid description", () => {
    const gate = new H264SyncGate();
    gate.acceptDescription(DESCRIPTION_1);
    gate.acceptAccessUnit("key", IDR);

    const recovery = gate.decoderError();
    expect(recovery).toMatchObject({
      configuration: { codec: "avc1.640033", generation: 1, nalLengthSize: 4 },
      resync: "decoder-error",
    });
    expect(recovery.configuration?.description).toEqual(DESCRIPTION_1);
    expect(gate.state).toBe("waiting-for-IDR");
    expect(gate.acceptAccessUnit("delta", DELTA).decode).toBeNull();
  });

  it("treats every later description as a new decoder generation", () => {
    const gate = new H264SyncGate();
    gate.acceptDescription(DESCRIPTION_1);
    gate.acceptAccessUnit("key", IDR);

    expect(gate.acceptDescription(DESCRIPTION_2)).toMatchObject({
      configuration: { codec: "avc1.42c01e", generation: 2, nalLengthSize: 4 },
      resync: "configuration-change",
    });
    expect(gate.state).toBe("waiting-for-IDR");
    expect(gate.acceptAccessUnit("delta", DELTA).decode).toBeNull();
    expect(gate.acceptAccessUnit("key", IDR).decode).toBe("key");
  });

  it("loses sync on both a sequence gap and a discontinuity", () => {
    const gate = new H264SyncGate();
    gate.acceptDescription(DESCRIPTION_1);
    gate.acceptAccessUnit("key", IDR);

    expect(gate.sequenceGap()).toBe("sequence-gap");
    expect(gate.acceptAccessUnit("delta", DELTA).decode).toBeNull();
    gate.acceptAccessUnit("key", IDR);
    expect(gate.discontinuity()).toBe("discontinuity");
    expect(gate.acceptAccessUnit("delta", DELTA).decode).toBeNull();
  });
});
