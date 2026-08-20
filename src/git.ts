/**
 * Git context for a build, read straight from disk.
 *
 * Deliberately no `git` subprocess: this runs on every new build the probe
 * sees, and reading two small files is orders of magnitude cheaper than
 * spawning git. Handles both repo layouts that exist on this machine:
 *
 *  - a normal checkout: `<root>/.git` directory, `HEAD` inside it;
 *  - a linked worktree (bb's `~/.bb/worktrees/env_XXX/App`): `<root>/.git` is
 *    a plain file containing `gitdir: /main/.git/worktrees/<name>`, and HEAD
 *    lives in that referenced directory.
 */

import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readTextFileBounded } from "./bounded-file";

export interface GitInfo {
  /** Repo (or worktree) root directory. */
  root: string;
  /** Branch name, or a short detached SHA. */
  branch: string | null;
  /** Basename of the root — the human name of the checkout/worktree. */
  worktree: string;
  /** True when the root is a linked worktree rather than the main checkout. */
  isLinkedWorktree: boolean;
}

const MAX_ASCEND = 8;
const MAX_GIT_POINTER_BYTES = 64 * 1024;

async function pathKind(path: string): Promise<"file" | "dir" | null> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

/** Parse a HEAD file's content into a branch name or short SHA. */
export function parseHead(content: string): string | null {
  const text = content.trim();
  if (!text) return null;
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
  if (ref) return ref[1]!;
  // Detached: a bare SHA. Shorten it the way git status would.
  if (/^[0-9a-f]{40}$/.test(text)) return text.slice(0, 9);
  return null;
}

/** Parse a `.git` *file* (linked worktree) into its real git directory. */
export function parseGitFile(content: string): string | null {
  const match = /^gitdir:\s*(.+)$/m.exec(content.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * Resolve git context for any path inside a repo. Returns null when the path
 * is not inside one (within the ascent bound).
 */
export async function gitInfoFor(startPath: string): Promise<GitInfo | null> {
  let dir = startPath;
  for (let depth = 0; depth < MAX_ASCEND; depth++) {
    const gitPath = join(dir, ".git");
    const kind = await pathKind(gitPath);

    if (kind === "dir") {
      const head = await readTextFileBounded(join(gitPath, "HEAD"), MAX_GIT_POINTER_BYTES).catch(
        () => null,
      );
      return {
        root: dir,
        branch: head ? parseHead(head) : null,
        worktree: basename(dir),
        isLinkedWorktree: false,
      };
    }

    if (kind === "file") {
      const content = await readTextFileBounded(gitPath, MAX_GIT_POINTER_BYTES).catch(() => null);
      const gitdir = content ? parseGitFile(content) : null;
      const head = gitdir
        ? await readTextFileBounded(join(gitdir, "HEAD"), MAX_GIT_POINTER_BYTES).catch(() => null)
        : null;
      return {
        root: dir,
        branch: head ? parseHead(head) : null,
        worktree: basename(dir),
        isLinkedWorktree: true,
      };
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function basename(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf("/");
  return index === -1 ? trimmed : trimmed.slice(index + 1);
}
