/**
 * Scope identity — keyed on the repo, never on a path.
 *
 * `sha256(checkoutPath)` is the opposite of machine-portable. bb creates a
 * per-thread git worktree, so every thread's environment has a *different*
 * checkout path: a path-keyed scope mints a fresh key per worktree, finds no
 * baseline, and reports all 148 previews as `added` on every run, forever.
 * `manifest_ran AND frame_count = expected_count` does not catch that, because
 * a full set of `added` is not empty.
 *
 * The same fault hits any clone at a different path, a renamed parent
 * directory, or a volume that remounts.
 */
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { run } from "./exec.js";

export interface ScopeInput {
  /** Absolute path to the checkout, from bb's environment. Display only. */
  checkoutPath: string;
  /** Absolute path to the resolved `.xcodeproj` / `.xcworkspace` / `Package.swift`. */
  projectPath: string | null;
  /** bb's project id, the last resort for a checkout that is not a git repo. */
  projectId: string;
}

export interface Scope {
  scopeKey: string;
  /** How the repo was identified, for the doctor and for tests. */
  repoKey: string;
  repoKeySource: "origin" | "git-common-dir" | "project";
  /** The project path relative to the repo root — the part that is portable. */
  subPath: string;
  /** Kept only as a display field. Never hashed, never persisted as identity. */
  checkoutPath: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Normalize an origin URL so the same repo reached over SSH and over HTTPS,
 * with or without credentials, with or without `.git`, is one key.
 *
 * `git@github.com:Owner/Repo.git` and `https://user:tok@GitHub.com/owner/repo/`
 * both become `github.com/owner/repo`.
 */
export function normalizeOriginUrl(url: string): string | null {
  const raw = url.trim();
  if (raw === "") return null;

  let rest: string;
  const scpLike = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(raw);
  if (scpLike) {
    rest = `${scpLike[1]}/${scpLike[2]}`;
  } else {
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(.*)$/.exec(raw);
    rest = withScheme ? withScheme[1]! : raw;
    // Strip credentials from the authority.
    const at = rest.indexOf("@");
    const firstSlash = rest.indexOf("/");
    if (at !== -1 && (firstSlash === -1 || at < firstSlash)) rest = rest.slice(at + 1);
  }

  rest = rest.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (rest === "") return null;

  const slash = rest.indexOf("/");
  if (slash === -1) return rest.toLowerCase();
  const host = rest.slice(0, slash).toLowerCase();
  const path = rest.slice(slash);
  // The host is case-insensitive; the path is not, on every forge that matters.
  return `${host}${path}`;
}

async function gitOriginUrl(cwd: string): Promise<string | null> {
  try {
    const result = await run("git", ["-C", cwd, "remote", "get-url", "origin"], { timeoutMs: 5000 });
    if (result.code !== 0) return null;
    return normalizeOriginUrl(result.stdout);
  } catch {
    return null;
  }
}

/**
 * The git common directory, which every worktree of one clone shares.
 *
 * This is the fallback that makes per-thread worktrees resolve to one scope
 * even for a repo with no remote — which is a real shape, not a hypothetical:
 * a scratch repo, an internal mirror cloned by path, a `git init` someone never
 * pushed.
 */
async function gitCommonDir(cwd: string): Promise<string | null> {
  try {
    const result = await run(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeoutMs: 5000 },
    );
    if (result.code !== 0) return null;
    const path = result.stdout.trim();
    if (path === "") return null;
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  } catch {
    return null;
  }
}

/** The repo root, so the project path can be stored relative to something portable. */
export async function gitRepoRoot(cwd: string): Promise<string | null> {
  try {
    const result = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeoutMs: 5000 });
    if (result.code !== 0) return null;
    const path = result.stdout.trim();
    return path === "" ? null : path;
  } catch {
    return null;
  }
}

export async function gitHead(cwd: string): Promise<{ commitSha: string | null; branch: string | null }> {
  try {
    const [sha, branch] = await Promise.all([
      run("git", ["-C", cwd, "rev-parse", "HEAD"], { timeoutMs: 5000 }),
      run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 5000 }),
    ]);
    return {
      commitSha: sha.code === 0 && sha.stdout.trim() !== "" ? sha.stdout.trim() : null,
      branch: branch.code === 0 && branch.stdout.trim() !== "" ? branch.stdout.trim() : null,
    };
  } catch {
    return { commitSha: null, branch: null };
  }
}

/**
 * Compose the scope key from an already-resolved repo key and sub-path.
 *
 * Split out from `resolveScope` so the portability test — "a look written under
 * checkout A resolves under checkout B for the same repo" — is a pure unit test
 * with no git and no filesystem.
 */
export function composeScopeKey(repoKey: string, subPath: string): string {
  return sha256(`${repoKey}\u0000${subPath}`);
}

/**
 * Normalize a project path into a repo-relative sub-path.
 *
 * A project outside the repo root (or no repo at all) falls back to the
 * basename, which is stable across clones in the way the absolute path is not.
 */
export function toSubPath(repoRoot: string | null, projectPath: string | null): string {
  if (projectPath === null) return "";
  const absolute = resolve(projectPath);
  if (repoRoot !== null) {
    const rel = relative(resolve(repoRoot), absolute);
    if (rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep)) {
      return rel.split(sep).join("/");
    }
  }
  const segments = absolute.split(sep).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? "";
}

export async function resolveScope(input: ScopeInput): Promise<Scope> {
  const origin = await gitOriginUrl(input.checkoutPath);

  let repoKey: string;
  let repoKeySource: Scope["repoKeySource"];
  if (origin !== null) {
    repoKey = origin;
    repoKeySource = "origin";
  } else {
    const commonDir = await gitCommonDir(input.checkoutPath);
    if (commonDir !== null) {
      repoKey = sha256(commonDir);
      repoKeySource = "git-common-dir";
    } else {
      repoKey = `proj:${input.projectId}`;
      repoKeySource = "project";
    }
  }

  const repoRoot = await gitRepoRoot(input.checkoutPath);
  const subPath = toSubPath(repoRoot, input.projectPath);

  return {
    scopeKey: composeScopeKey(repoKey, subPath),
    repoKey,
    repoKeySource,
    subPath,
    checkoutPath: input.checkoutPath,
  };
}
