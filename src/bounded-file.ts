/** Read a regular file without allowing its size or a grow-after-stat race to allocate unbounded memory. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export interface BoundedFileOptions {
  /** Refuse a symbolic-link path rather than following it. */
  noFollow?: boolean;
}

export async function readFileBounded(
  path: string,
  maxBytes: number,
  options: BoundedFileOptions = {},
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("The file-read limit is invalid.");
  }
  // O_NONBLOCK prevents a replaced manifest path from hanging the shared
  // server on a FIFO. It has no effect on ordinary regular files.
  const flags =
    constants.O_RDONLY |
    constants.O_NONBLOCK |
    (options.noFollow ? constants.O_NOFOLLOW : 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`${path} is not a regular file.`);
    if (before.size > maxBytes) {
      throw new Error(`${path} exceeds the ${maxBytes}-byte read limit.`);
    }

    const data = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== data.length || after.size !== before.size) {
      throw new Error(`${path} changed while it was being read.`);
    }
    return data;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readTextFileBounded(
  path: string,
  maxBytes: number,
  options: BoundedFileOptions = {},
): Promise<string> {
  return (await readFileBounded(path, maxBytes, options)).toString("utf8");
}
