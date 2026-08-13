/**
 * Where frame bytes live, and the guard that keeps a request inside it.
 *
 * `<pluginDataDir>/frames/<scopeKey>/<lookId>/<relPath>`. The database stores
 * the relative path only — no absolute path is ever persisted, because a
 * database written on one machine is read on another the moment someone moves a
 * checkout, and an absolute path is the field that makes that fail.
 *
 * The image route resolves identifiers **through the database** and never
 * treats them as paths, then asserts the resolved absolute path is inside the
 * frames root before opening it. Both halves are needed: the first stops a
 * traversal, the second stops a bug in the first.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface FrameLocation {
  scopeKey: string;
  lookId: string;
  relPath: string;
}

/** The directory one look's frames live in. */
export function lookDir(framesRoot: string, scopeKey: string, lookId: string): string {
  return join(framesRoot, scopeKey, lookId);
}

/**
 * Resolve a stored relative path to an absolute one, or `null` if it escapes.
 *
 * A `relPath` comes from the database rather than from a request, so this is
 * the second line rather than the first — but SnapshotPreviews composes
 * filenames from preview names, and a preview named `../../etc/passwd` is a
 * string an app author controls.
 */
export function resolveInside(root: string, ...segments: string[]): string | null {
  // `join` rather than `resolve` for the segments: `join(root, "/etc/passwd")`
  // stays under the root, where `resolve(root, "/etc/passwd")` would escape to
  // the filesystem root. A leading slash in a stored segment is neutralised
  // rather than honoured.
  const candidate = resolve(join(root, ...segments));
  const rootResolved = resolve(root);
  const rel = relative(rootResolved, candidate);
  // The root itself is a directory, never something to serve or delete.
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  // A path that climbs out and back in is still suspicious enough to refuse.
  if (rel.split(sep).includes("..")) return null;
  return candidate;
}

export function frameAbsolutePath(framesRoot: string, location: FrameLocation): string | null {
  return resolveInside(framesRoot, location.scopeKey, location.lookId, location.relPath);
}

export class FrameStore {
  constructor(private readonly framesRoot: string) {}

  get root(): string {
    return this.framesRoot;
  }

  /** Every run renders into a fresh directory; one is never reused. */
  async ensureLookDir(scopeKey: string, lookId: string): Promise<string> {
    const dir = lookDir(this.framesRoot, scopeKey, lookId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async write(location: FrameLocation, bytes: Uint8Array): Promise<number> {
    const absolute = frameAbsolutePath(this.framesRoot, location);
    if (absolute === null) {
      throw new Error(`Refusing to write outside the frames directory: ${location.relPath}`);
    }
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, bytes);
    return bytes.byteLength;
  }

  async read(location: FrameLocation): Promise<Buffer | null> {
    const absolute = frameAbsolutePath(this.framesRoot, location);
    if (absolute === null) return null;
    try {
      return await readFile(absolute);
    } catch {
      // A frame that is no longer on disk is a state the UI renders, not an
      // error: the directive's tombstone and the grid's aspect box both exist
      // for exactly this.
      return null;
    }
  }

  async sizeOf(location: FrameLocation): Promise<number | null> {
    const absolute = frameAbsolutePath(this.framesRoot, location);
    if (absolute === null) return null;
    try {
      return (await stat(absolute)).size;
    } catch {
      return null;
    }
  }

  /** Remove one look's directory. Missing is success: pruning is idempotent. */
  async removeLook(scopeKey: string, lookId: string): Promise<void> {
    const dir = resolveInside(this.framesRoot, scopeKey, lookId);
    if (dir === null) return;
    await rm(dir, { recursive: true, force: true });
  }

  /** Remove everything. `bb sims purge` and nothing else. */
  async removeAll(): Promise<void> {
    await rm(this.framesRoot, { recursive: true, force: true });
  }
}
