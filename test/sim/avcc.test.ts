import { describe, expect, it } from "vitest";

import {
  MAX_AVCC_NAL_UNITS,
  avccAccessUnitHasIdr,
  avccNalLengthSize,
} from "../../app/sim/avcc.js";

const AVC_CONFIG = new Uint8Array([
  0x01, 0x64, 0x00, 0x33, 0xff,
  0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x33,
  0x01, 0x00, 0x02, 0x68, 0xee,
]);

describe("AVCC decoder configuration", () => {
  it("reads the NAL length width only from a complete SPS/PPS record", () => {
    expect(avccNalLengthSize(AVC_CONFIG)).toBe(4);
    expect(avccNalLengthSize(new Uint8Array([0x01, 0x64, 0x00, 0x33, 0xfd, ...AVC_CONFIG.slice(5)]))).toBe(2);
    expect(avccNalLengthSize(new Uint8Array([0x01, 0x64, 0x00, 0x33]))).toBeNull();
    expect(avccNalLengthSize(new Uint8Array([0x01, 0x64, 0x00, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67]))).toBeNull();
    expect(
      avccNalLengthSize(
        new Uint8Array([
          0x01, 0x64, 0x00, 0x33, 0xff,
          0xe1, 0x00, 0x04, 0x65, 0x64, 0x00, 0x33,
          0x01, 0x00, 0x02, 0x68, 0xee,
        ]),
      ),
    ).toBeNull();
  });
});

describe("AVCC access-unit walking", () => {
  it("finds an IDR after earlier non-IDR NAL units", () => {
    expect(
      avccAccessUnitHasIdr(
        new Uint8Array([
          0x00, 0x00, 0x00, 0x02, 0x41, 0x9a,
          0x00, 0x00, 0x00, 0x02, 0x65, 0x88,
        ]),
        4,
      ),
    ).toBe(true);
  });

  it("does not trust an IDR-looking byte outside a complete NAL unit", () => {
    expect(
      avccAccessUnitHasIdr(
        new Uint8Array([0x00, 0x00, 0x00, 0x03, 0x41, 0x65, 0x88]),
        4,
      ),
    ).toBe(false);
    expect(
      avccAccessUnitHasIdr(
        new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x65, 0x88]),
        4,
      ),
    ).toBe(false);
  });

  it("stops after a fixed number of NAL units", () => {
    const data = new Uint8Array((MAX_AVCC_NAL_UNITS + 1) * 2);
    for (let index = 0; index <= MAX_AVCC_NAL_UNITS; index += 1) {
      data[index * 2] = 1;
      data[index * 2 + 1] = index === MAX_AVCC_NAL_UNITS ? 0x65 : 0x41;
    }
    expect(avccAccessUnitHasIdr(data, 1)).toBe(false);
  });
});
