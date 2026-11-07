/**
 * A checkout bb knows by a symlinked path.
 *
 * bb hands a plugin command the invoking process's cwd, which the OS reports
 * as the physical path. A project registered through a symlink (`/tmp/App`
 * on macOS, where `/tmp` is `/private/tmp`, or a symlinked `~/Git`) therefore
 * arrives as a cwd that is not textually under the thread's checkout, and
 * `bb xcode run` refused it as "does not match this thread". The comparison
 * has to happen between real paths.
 */

import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCli } from "../src/cli";
import type { Collector } from "../src/collector";
import type { ThreadScope } from "../src/scopes";
import { MIGRATIONS, Store, type Db } from "../src/store";
import type { WrappedDeps } from "../src/wrapped";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(checkoutPath: string) {
  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  const scope: ThreadScope = {
    threadId: "th_app",
    projectId: "proj_app",
    environmentId: "env_app",
    path: checkoutPath,
    hostId: null,
    branch: "main",
    active: true,
    updatedAt: 0,
  };
  const confirmHostAction = vi.fn(async () => false);
  const cli = createCli({
    store: new Store(db),
    collector: { getSimulators: () => [], getLastActivities: () => [] } as unknown as Collector,
    dataDir: "/tmp/xcode-symlink-test",
    projectName: (id: string) => id,
    phaseFor: () => null,
    refreshProjectNames: () => undefined,
    scopeFor: async (threadId: string) => (threadId === scope.threadId ? scope : null),
    checkoutElsewhere: async () => null,
    wrapped: {} as WrappedDeps,
    onShimStateKnown: () => undefined,
    confirmHostAction,
  });
  return { cli, confirmHostAction };
}

describe("a checkout registered through a symlink", () => {
  it("accepts a build from its physical path", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "xcode-symlink-")));
    dirs.push(base);
    const real = join(base, "real", "App");
    mkdirSync(real, { recursive: true });
    const alias = join(base, "alias");
    symlinkSync(join(base, "real"), alias);

    // bb knows the checkout by the alias; the process reports the real path.
    const { cli, confirmHostAction } = fixture(join(alias, "App"));
    const result = await cli.dispatch(
      ["run", "--", "xcodebuild", "-scheme", "App", "build"],
      { threadId: "th_app", projectId: "proj_app", cwd: real },
    );

    expect(result.stderr).not.toContain("does not match this thread");
    // It reached the human confirmation, which this fixture declines.
    expect(confirmHostAction).toHaveBeenCalledOnce();
    expect(result).toEqual({
      exitCode: 1,
      stderr: "The host xcodebuild run was not confirmed.\n",
    });
  });

  it("still refuses a cwd outside the checkout's real path", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "xcode-symlink-")));
    dirs.push(base);
    mkdirSync(join(base, "real", "App"), { recursive: true });
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(join(base, "real"), join(base, "alias"));

    const { cli, confirmHostAction } = fixture(join(base, "alias", "App"));
    const result = await cli.dispatch(
      ["run", "--", "xcodebuild", "-scheme", "App", "build"],
      { threadId: "th_app", projectId: "proj_app", cwd: elsewhere },
    );

    expect(result.stderr).toContain("does not match this thread");
    expect(confirmHostAction).not.toHaveBeenCalled();
  });
});
