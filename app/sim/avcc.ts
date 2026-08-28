/**
 * The capture host labels access units as key or delta, but that label comes
 * from a sample attachment rather than from the bytes the decoder consumes.
 * Recovery cannot trust it: one false key submitted after a gap merely starts
 * another corrupt prediction chain. These helpers validate the `avcC` shape
 * and inspect the length-prefixed NAL units without allocating or scanning an
 * attacker-controlled number of empty records.
 */

/** Far beyond a VideoToolbox access unit, while keeping malformed walks finite. */
export const MAX_AVCC_NAL_UNITS = 256;

/**
 * Read the access-unit length prefix width from a complete decoder record.
 *
 * Four profile bytes are enough to spell a codec string but not enough to
 * configure a decoder. Requiring at least one bounded SPS and PPS keeps a
 * truncated description out of the recovery cache, where it would otherwise
 * poison every decoder generation created after an error.
 */
export function avccNalLengthSize(description: Uint8Array): number | null {
  if (description.length < 7 || description[0] !== 1) return null;
  const lengthSize = (description[4]! & 0x03) + 1;
  // `lengthSizeMinusOne === 2` is reserved by AVCDecoderConfigurationRecord.
  if (lengthSize === 3) return null;

  const spsCount = description[5]! & 0x1f;
  if (spsCount === 0) return null;
  let offset = 6;

  const skipParameterSets = (count: number, expectedNalType: number): boolean => {
    for (let index = 0; index < count; index += 1) {
      if (offset + 2 > description.length) return false;
      const length = description[offset]! * 256 + description[offset + 1]!;
      offset += 2;
      if (length === 0 || length > description.length - offset) return false;
      if ((description[offset]! & 0x1f) !== expectedNalType) return false;
      offset += length;
    }
    return true;
  };

  if (!skipParameterSets(spsCount, 7) || offset >= description.length) return null;
  const ppsCount = description[offset]!;
  offset += 1;
  if (ppsCount === 0 || !skipParameterSets(ppsCount, 8)) return null;
  return lengthSize;
}

/**
 * Does this complete AVCC access unit contain an IDR slice NAL (type 5)?
 *
 * Finding `0x65` is not enough: it may be slice payload, or precede a length
 * that runs off the end. The whole unit must remain structurally valid even
 * after an IDR is found, because a truncated tail is not a decoder sync point.
 */
export function avccAccessUnitHasIdr(data: Uint8Array, nalLengthSize: number): boolean {
  if (!Number.isInteger(nalLengthSize) || nalLengthSize < 1 || nalLengthSize > 4) {
    return false;
  }

  let offset = 0;
  let units = 0;
  let foundIdr = false;
  while (offset < data.length) {
    if (units >= MAX_AVCC_NAL_UNITS || offset + nalLengthSize > data.length) return false;
    units += 1;

    let length = 0;
    for (let index = 0; index < nalLengthSize; index += 1) {
      length = length * 256 + data[offset + index]!;
    }
    offset += nalLengthSize;
    if (length === 0 || length > data.length - offset) return false;
    if ((data[offset]! & 0x1f) === 5) foundIdr = true;
    offset += length;
  }
  return foundIdr;
}
