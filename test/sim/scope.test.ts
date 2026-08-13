import { describe, expect, it } from "vitest";
import { composeScopeKey, normalizeOriginUrl, toSubPath } from "../../src/sim/scope.js";

/**
 * The scope key is the single most consequential identity in this plugin.
 *
 * bb creates a per-thread git worktree, so every thread's environment has a
 * different checkout path. A path-keyed scope mints a fresh key per worktree,
 * finds no baseline, and reports all 148 previews as `added` on every run,
 * forever — and `manifest_ran AND frame_count = expected_count` does not catch
 * it, because a full set of `added` is not empty.
 */
describe("origin normalization", () => {
  it("collapses every spelling of one repo onto one key", () => {
    const expected = "github.com/owner/repo";
    for (const url of [
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo/",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo",
      "https://user:token@GitHub.com/owner/repo.git",
    ]) {
      expect(normalizeOriginUrl(url), url).toBe(expected);
    }
  });

  it("lowercases the host but not the path", () => {
    // Every forge that matters treats the path as case-sensitive.
    expect(normalizeOriginUrl("https://GitHub.com/Owner/Repo")).toBe("github.com/Owner/Repo");
  });

  it("answers null for nothing", () => {
    expect(normalizeOriginUrl("")).toBeNull();
    expect(normalizeOriginUrl("   ")).toBeNull();
  });
});

describe("scope keys", () => {
  it("is identical for two worktrees of one repo", () => {
    // The whole point: a look written under checkout A resolves under checkout B.
    const repoKey = "github.com/owner/repo";
    const fromWorktreeA = composeScopeKey(repoKey, "ios/App.xcworkspace");
    const fromWorktreeB = composeScopeKey(repoKey, "ios/App.xcworkspace");
    expect(fromWorktreeA).toBe(fromWorktreeB);
  });

  it("differs for two projects inside one repo", () => {
    const repoKey = "github.com/owner/monorepo";
    expect(composeScopeKey(repoKey, "apps/ios-client/App.xcodeproj")).not.toBe(
      composeScopeKey(repoKey, "tools/Bench.xcodeproj"),
    );
  });

  it("cannot be confused by a separator inside either half", () => {
    // A NUL separates, because a path may contain anything else — including the
    // characters a naive join would use.
    expect(composeScopeKey("a", "b/c")).not.toBe(composeScopeKey("a/b", "c"));
  });
});

describe("sub-paths", () => {
  it("is repo-relative, and therefore portable", () => {
    expect(toSubPath("/Users/a/checkouts/repo", "/Users/a/checkouts/repo/ios/App.xcworkspace")).toBe(
      "ios/App.xcworkspace",
    );
    expect(toSubPath("/tmp/wt-1/repo", "/tmp/wt-1/repo/ios/App.xcworkspace")).toBe(
      "ios/App.xcworkspace",
    );
  });

  it("falls back to the basename for a project outside the repo", () => {
    // Stable across clones in the way the absolute path is not.
    expect(toSubPath("/repo", "/elsewhere/Other.xcodeproj")).toBe("Other.xcodeproj");
    expect(toSubPath(null, "/elsewhere/Other.xcodeproj")).toBe("Other.xcodeproj");
  });

  it("is empty when there is no project path yet", () => {
    expect(toSubPath("/repo", null)).toBe("");
  });
});
