import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createCli } from "../src/cli";
import type { Collector } from "../src/collector";
import { RANK, type Run } from "../src/model";
import type { ThreadScope } from "../src/scopes";
import { MIGRATIONS, Store, type Db } from "../src/store";
import { createTools } from "../src/tools";
import type { WrappedDeps } from "../src/wrapped";

const NOW = 1_700_000_000_000;
const SCOPE: ThreadScope = {
  threadId: "th_app",
  projectId: "proj_app",
  environmentId: "env_app",
  path: "/Users/me/.bb/worktrees/env_app/App",
  branch: "feature/security",
  active: true,
  updatedAt: NOW,
};
const OTHER_SCOPE: ThreadScope = {
  ...SCOPE,
  threadId: "th_other",
  projectId: "proj_other",
  environmentId: "env_other",
  path: "/Users/me/Git/Other",
  branch: "main",
};

function makeStore(): Store {
  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  return new Store(db);
}

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    status: "passed",
    statusRank: RANK.verified,
    kind: "build",
    scheme: "App",
    container: null,
    configuration: null,
    destination: null,
    projectId: "proj_app",
    root: null,
    cwd: SCOPE.path,
    pid: null,
    cmdline: null,
    startedAt: NOW,
    endedAt: NOW + 1_000,
    errorCount: 0,
    warningCount: 0,
    analyzerCount: 0,
    testTotal: null,
    testFailed: null,
    testSkipped: null,
    bundlePath: null,
    detailed: false,
    branch: SCOPE.branch,
    worktree: "App",
    threadId: SCOPE.threadId,
    ...overrides,
  };
}

function fixture() {
  const store = makeStore();
  store.insertRun(run("r:mine"));
  store.insertRun(
    run("r:other", {
      projectId: "proj_other",
      cwd: "/Users/me/Git/Other",
      branch: "main",
      worktree: "Other",
      threadId: "th_other",
      startedAt: NOW + 5_000,
    }),
  );
  store.insertRun(
    run("r:other-live", {
      status: "running",
      statusRank: RANK.observed,
      projectId: "proj_other",
      cwd: "/Users/me/Git/Other",
      branch: "main",
      worktree: "Other",
      threadId: "th_other",
      startedAt: NOW + 10_000,
      endedAt: null,
      pid: 4242,
    }),
  );
  store.upsertRoot("/private/DerivedData/App", "proj_app", "manifest", NOW);
  store.upsertRoot(
    "/private/DerivedData/SecretOther",
    "proj_other",
    "manifest",
    NOW,
  );

  const collector = {
    getSimulators: () => [],
    getLastActivities: () => [],
  } as unknown as Collector;
  const confirmHostAction = vi.fn(async () => false);
  const common = {
    store,
    collector,
    dataDir: "/tmp/xcode-security-test",
    projectName: (id: string) => id,
    phaseFor: () => null,
    refreshProjectNames: () => undefined,
    scopeFor: async (threadId: string) =>
      threadId === SCOPE.threadId
        ? SCOPE
        : threadId === OTHER_SCOPE.threadId
          ? OTHER_SCOPE
          : null,
    wrapped: {} as WrappedDeps,
    confirmHostAction,
  };
  const cli = createCli({
    ...common,
    onShimStateKnown: () => undefined,
  });
  const tools = createTools({
    ...common,
    showRun: (id) => ({ stdout: `detail:${id}` }),
  });
  return { cli, confirmHostAction, tools };
}

describe("agent Xcode surfaces fail closed to the invoking thread", () => {
  it("removes the machine-wide escape hatch from agent tool schemas", () => {
    const { tools } = fixture();
    expect(Object.keys(tools.status.parameters.shape)).toEqual(["limit"]);
    expect(Object.keys(tools.lastFailure.parameters.shape)).toEqual([
      "projectId",
    ]);
  });

  it("scopes CLI history, detail, active status, and DerivedData roots", async () => {
    const { cli } = fixture();
    const ctx = { threadId: SCOPE.threadId, projectId: SCOPE.projectId!, cwd: SCOPE.path };

    const runs = await cli.dispatch(["runs"], ctx);
    expect(runs.stdout).toContain("r:mine");
    expect(runs.stdout).not.toContain("r:other");

    const detail = await cli.dispatch(["show", "r:other"], ctx);
    expect(detail).toEqual({
      exitCode: 1,
      stderr: "No run with id 'r:other'.\n",
    });

    const status = await cli.dispatch(["status"], ctx);
    expect(status.stdout).not.toContain("r:other-live");

    const roots = await cli.dispatch(["roots"], ctx);
    expect(roots.stdout).toContain("/private/DerivedData/App");
    expect(roots.stdout).not.toContain("SecretOther");
  });

  it("cannot stop another thread or trigger machine-wide administration", async () => {
    const { cli, confirmHostAction } = fixture();
    const ctx = { threadId: SCOPE.threadId, projectId: SCOPE.projectId!, cwd: SCOPE.path };

    expect(await cli.dispatch(["stop", "r:other-live"], ctx)).toEqual({
      exitCode: 1,
      stderr: "No run with id 'r:other-live'.\n",
    });
    expect((await cli.dispatch(["rescan"], ctx)).exitCode).toBe(1);
    expect(
      (await cli.dispatch(["shim", "uninstall"], ctx)).exitCode,
    ).toBe(1);
    expect(confirmHostAction).toHaveBeenCalledWith(
      SCOPE.threadId,
      expect.objectContaining({
        title: "Remove the host-wide xcodebuild shim?",
        confirmLabel: "Remove shim",
      }),
    );
  });

  it("does not treat an omitted thread id as a trusted host identity", async () => {
    const { cli } = fixture();
    const runs = await cli.dispatch(["runs"], {});
    expect(runs.stdout).not.toContain("r:mine");
    expect(runs.stdout).not.toContain("r:other");
    const build = await cli.dispatch(
      ["run", "--", "xcodebuild", "-scheme", "App", "build"],
      { cwd: SCOPE.path },
    );
    expect(build).toEqual({
      exitCode: 1,
      stderr:
        "Tracked builds require a bb thread so the checkout security boundary can be enforced.\n",
    });
    expect((await cli.dispatch(["rescan"], {})).exitCode).toBe(1);
    expect(
      (await cli.dispatch(["shim", "install"], {})).exitCode,
    ).toBe(1);
  });

  it("does not trust a caller-selected thread id that disagrees with cwd", async () => {
    const { cli, confirmHostAction } = fixture();
    const spoofed = {
      threadId: OTHER_SCOPE.threadId,
      projectId: OTHER_SCOPE.projectId!,
      cwd: SCOPE.path,
    };

    expect((await cli.dispatch(["show", "r:other"], spoofed)).exitCode).toBe(1);
    expect((await cli.dispatch(["runs"], spoofed)).stdout).not.toContain("r:other");
    expect((await cli.dispatch(["stop", "r:other-live"], spoofed)).exitCode).toBe(1);
    expect((await cli.dispatch(["shim", "uninstall"], spoofed)).exitCode).toBe(1);
    expect(confirmHostAction).not.toHaveBeenCalled();
  });
});
