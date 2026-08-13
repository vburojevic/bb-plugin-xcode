import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENT_IMAGE_BUDGET_BYTES,
  contentTypeOf,
  detectFormat,
  dimensions,
  fitToBudget,
  jpegDimensions,
  pngDimensions,
} from "../../src/sim/image.js";
import { frameAbsolutePath, resolveInside } from "../../src/sim/framestore.js";

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/png/${name}`, import.meta.url))));
}

describe("PNG dimensions", () => {
  it("reads IHDR from the checked-in fixtures", () => {
    // Load-bearing rather than an optimisation: odiff without
    // `--fail-on-layout` silently compares images of different sizes and
    // reports a fabricated ratio over the larger one's pixel count.
    expect(pngDimensions(fixture("base.png"))).toEqual({ width: 8, height: 8 });
    expect(pngDimensions(fixture("layout.png"))).toEqual({ width: 8, height: 10 });
  });

  it("refuses anything that is not a PNG", () => {
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(pngDimensions(new Uint8Array(40))).toBeNull();
    // Right signature, wrong chunk.
    const wrongChunk = new Uint8Array(fixture("base.png"));
    wrongChunk[12] = 0x00;
    expect(pngDimensions(wrongChunk)).toBeNull();
  });
});

describe("JPEG dimensions", () => {
  /** A minimal JPEG: SOI, an APP1 block, then an SOF0 carrying the size. */
  function jpeg(width: number, height: number, withExif = true): Uint8Array {
    const parts: number[] = [0xff, 0xd8];
    if (withExif) {
      // An EXIF block before the SOF is exactly what the simulator sends, and
      // it is why the reader walks segments rather than assuming an offset.
      const payload = new Array(60).fill(0x00);
      parts.push(0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload);
    }
    parts.push(
      0xff, 0xc0, 0x00, 0x11, 0x08,
      (height >> 8) & 0xff, height & 0xff,
      (width >> 8) & 0xff, width & 0xff,
      0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    );
    return new Uint8Array(parts);
  }

  it("walks past an EXIF block to the start-of-frame marker", () => {
    expect(jpegDimensions(jpeg(1320, 2868))).toEqual({ width: 1320, height: 2868 });
    expect(jpegDimensions(jpeg(1320, 2868, false))).toEqual({ width: 1320, height: 2868 });
  });

  it("refuses a truncated or wrong-format buffer", () => {
    expect(jpegDimensions(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(jpegDimensions(new Uint8Array([0x89, 0x50]))).toBeNull();
  });

  it("is reachable through the format-agnostic entry point", () => {
    expect(detectFormat(jpeg(4, 4))).toBe("jpeg");
    expect(detectFormat(fixture("base.png"))).toBe("png");
    expect(detectFormat(new Uint8Array([0, 1, 2]))).toBeNull();
    expect(dimensions(jpeg(100, 200))).toEqual({ width: 100, height: 200 });
    expect(dimensions(new Uint8Array([0, 1, 2]))).toBeNull();
  });
});

describe("content types", () => {
  it("follows the stored extension rather than guessing", () => {
    // Frames are stored in whatever format they arrived in: preview renders are
    // PNG, captures are JPEG straight off the stream.
    expect(contentTypeOf("a.png")).toBe("image/png");
    expect(contentTypeOf("a.jpg")).toBe("image/jpeg");
  });
});

describe("the agent image budget", () => {
  it("counts base64, because that is what the provider is billed for", () => {
    const items = [{ bytes: 600_000 }, { bytes: 600_000 }, { bytes: 600_000 }];
    // 600KB inflates to 800KB encoded, so two fit inside 1.5MB and the third
    // does not.
    const { included, omitted } = fitToBudget(items);
    expect(included).toHaveLength(1);
    expect(omitted).toBe(2);
  });

  it("always includes at least one, so a reply is never imageless by arithmetic", () => {
    const { included, omitted } = fitToBudget([{ bytes: AGENT_IMAGE_BUDGET_BYTES * 4 }]);
    expect(included).toHaveLength(1);
    expect(omitted).toBe(0);
  });

  it("includes everything that fits", () => {
    const { included, omitted } = fitToBudget([{ bytes: 1000 }, { bytes: 1000 }]);
    expect(included).toHaveLength(2);
    expect(omitted).toBe(0);
  });
});

describe("the frames-root guard", () => {
  const root = "/data/plugins/xcode-simulators/frames";

  it("resolves a path inside the root", () => {
    expect(resolveInside(root, "scope", "lk_1", "a.png")).toBe(`${root}/scope/lk_1/a.png`);
  });

  it("refuses a path that climbs out", () => {
    // A `relPath` comes from the database rather than a request, so this is the
    // second line rather than the first — but SnapshotPreviews composes
    // filenames from preview names, and a preview name is a string an app
    // author controls.
    expect(resolveInside(root, "scope", "lk_1", "../../../etc/passwd")).toBeNull();
    expect(resolveInside(root, "..", "..", "etc")).toBeNull();
    expect(resolveInside(root, "scope", "..", "..", "..", "escape")).toBeNull();
  });

  it("neutralises an absolute path spliced into a segment", () => {
    // `join` is the right primitive here and `resolve` is not: `join` treats a
    // leading slash as ordinary, where `resolve` would honour it and escape to
    // the filesystem root.
    expect(resolveInside(root, "/etc/passwd")).toBe(`${root}/etc/passwd`);
  });

  it("refuses the root itself, which is a directory rather than a frame", () => {
    expect(resolveInside(root)).toBeNull();
    expect(frameAbsolutePath(root, { scopeKey: ".", lookId: ".", relPath: "." })).toBeNull();
  });
});
