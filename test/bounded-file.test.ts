import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileBounded, readTextFileBounded } from "../src/bounded-file";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-bounded-file-"));
  dirs.push(dir);
  return dir;
}

describe("bounded file reads", () => {
  it("reads an ordinary file within the limit", async () => {
    const dir = scratch();
    const path = join(dir, "small.txt");
    writeFileSync(path, "small");
    await expect(readTextFileBounded(path, 5)).resolves.toBe("small");
  });

  it("refuses a sparse or ordinary file before allocating past the limit", async () => {
    const dir = scratch();
    const path = join(dir, "large.bin");
    writeFileSync(path, "");
    truncateSync(path, 1025);
    await expect(readFileBounded(path, 1024)).rejects.toThrow(/read limit/);
  });

  it("can refuse a symbolic-link input", async () => {
    const dir = scratch();
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "secret");
    symlinkSync(target, link);
    await expect(readFileBounded(link, 1024, { noFollow: true })).rejects.toThrow();
  });
});
