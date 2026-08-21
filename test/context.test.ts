import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  destinationLabel,
  parseDestination,
  parseSimctlList,
} from "../src/destination";
import { gitInfoFor, parseGitFile, parseHead } from "../src/git";

const scratchDirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xcgit-"));
  scratchDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of scratchDirs) await rm(dir, { recursive: true, force: true });
});

describe("git HEAD parsing", () => {
  it("reads a branch ref", () => {
    expect(parseHead("ref: refs/heads/main\n")).toBe("main");
    expect(parseHead("ref: refs/heads/feature/foo-bar")).toBe("feature/foo-bar");
  });

  it("shortens a detached SHA", () => {
    expect(parseHead("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBe(
      "a1b2c3d4e",
    );
  });

  it("parses a linked-worktree .git file", () => {
    expect(parseGitFile("gitdir: /repo/.git/worktrees/env_x\n")).toBe(
      "/repo/.git/worktrees/env_x",
    );
  });
});

describe("gitInfoFor", () => {
  it("resolves a normal checkout, ascending from a subdirectory", async () => {
    const root = await scratch();
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await mkdir(join(root, "Sources", "App"), { recursive: true });

    const info = await gitInfoFor(join(root, "Sources", "App"));
    expect(info?.branch).toBe("main");
    expect(info?.root).toBe(root);
    expect(info?.isLinkedWorktree).toBe(false);
  });

  /**
   * The layout bb actually uses: `~/.bb/worktrees/env_X/App/.git` is a file
   * pointing into the main repo's .git/worktrees directory.
   */
  it("resolves a linked worktree through its gitdir file", async () => {
    const main = await scratch();
    const worktreeGitDir = join(main, ".git", "worktrees", "env_abc");
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(worktreeGitDir, "HEAD"), "ref: refs/heads/fix/crash\n");

    const linked = await scratch();
    const app = join(linked, "Almanac");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const info = await gitInfoFor(app);
    expect(info?.branch).toBe("fix/crash");
    expect(info?.worktree).toBe("Almanac");
    expect(info?.isLinkedWorktree).toBe(true);
  });

  it("returns null outside any repo", async () => {
    const dir = await scratch();
    expect(await gitInfoFor(dir)).toBeNull();
  });
});

describe("destination labels", () => {
  it("parses k=v specifiers", () => {
    expect(
      parseDestination("platform=iOS Simulator,name=iPhone 16,OS=26.0"),
    ).toEqual({ platform: "iOS Simulator", name: "iPhone 16", os: "26.0" });
  });

  it("renders simulator destinations the way a person says them", () => {
    expect(
      destinationLabel("platform=iOS Simulator,name=iPhone 16,OS=26.0"),
    ).toBe("iPhone 16 · iOS 26.0");
    expect(destinationLabel("platform=macOS")).toBe("macOS");
    expect(destinationLabel("platform=macOS,arch=arm64")).toBe("macOS (arm64)");
  });

  it("resolves a bare UDID through the simulator list", () => {
    const sims = [
      { udid: "B3C7738C-1111", name: "iPhone 16", os: "iOS 26.5", state: "Booted" },
    ];
    expect(destinationLabel("id=B3C7738C-1111", sims)).toBe(
      "iPhone 16 · iOS 26.5",
    );
    expect(destinationLabel("id=DEAD0000-2222", sims)).toBe("device DEAD0000");
  });

  it("passes through an already-friendly label", () => {
    expect(destinationLabel("macOS · My Mac · (26.5.2)")).toBe(
      "macOS · My Mac · (26.5.2)",
    );
  });

  it("parses real simctl JSON shape", () => {
    const parsed = parseSimctlList({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-5": [
          { udid: "AAA", name: "iPhone 16", state: "Booted" },
          { udid: "BBB", name: "iPad Pro", state: "Shutdown" },
        ],
      },
    });
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      udid: "AAA",
      name: "iPhone 16",
      os: "iOS 26.5",
      state: "Booted",
    });
  });
});
