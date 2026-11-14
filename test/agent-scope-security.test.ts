import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { createCli } from "../src/cli";
import type { Collector } from "../src/collector";
import { createLauncher } from "../src/launcher";
import { RANK, type Run } from "../src/model";
import type { RemoteBuilds } from "../src/remote";
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
  hostId: null,
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
  hostId: null,
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
    hostId: null,
    ...overrides,
  };
}

/** The refusal a remote Mac's worker gives, when the test wants one. */
const REMOTE_REFUSAL = "-derivedDataPath must stay inside this thread's checkout.";

function fixture(checkoutHostId: string | null = null) {
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
  // The same checkout path and branch on another Mac, owned by its thread,
  // and a build there no thread has claimed yet.
  store.insertRun(
    run("w:twin-live", {
      status: "running",
      statusRank: RANK.observed,
      threadId: "th_twin",
      hostId: "host_other",
      startedAt: NOW + 20_000,
      endedAt: null,
      pid: 5151,
    }),
  );
  store.insertRun(
    run("w:twin-unclaimed", { threadId: null, hostId: "host_other", startedAt: NOW + 21_000 }),
  );
  // A build on this machine at the path, before any thread claimed it.
  store.insertRun(run("r:local-unclaimed", { threadId: null, startedAt: NOW + 22_000 }));
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
  // Stands in for the other Mac's worker: it refuses, so nothing starts.
  const remoteValidate = vi.fn(async () => ({ ok: false as const, message: REMOTE_REFUSAL }));
  const launcher = createLauncher({
    wrapped: {} as WrappedDeps,
    remote: { validate: remoteValidate } as unknown as RemoteBuilds,
    serverHostId: async () => "host_server",
    listHosts: async () => [
      { id: "host_server", name: "MacMini" },
      { id: "host_other", name: "scw-mini" },
    ],
    log: { debug: () => undefined },
  });
  const scope = { ...SCOPE, hostId: checkoutHostId };
  const common = {
    launcher,
    machineName: (hostId: string) => (hostId === "host_other" ? "scw-mini" : null),
    store,
    collector,
    dataDir: "/tmp/xcode-security-test",
    projectName: (id: string) => id,
    phaseFor: () => null,
    refreshProjectNames: () => undefined,
    scopeFor: async (threadId: string) =>
      threadId === SCOPE.threadId
        ? scope
        : threadId === OTHER_SCOPE.threadId
          ? OTHER_SCOPE
          : null,
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
  return { cli, confirmHostAction, tools, remoteValidate };
}

describe("a checkout on another machine is built on that machine", () => {
  it("routes the agent build tool to that Mac, which validates before anything runs", async () => {
    const { tools, confirmHostAction, remoteValidate } = fixture("host_other");
    const result = await tools.build.execute(
      { args: ["-scheme", "App", "-derivedDataPath", "../../elsewhere"] },
      { threadId: SCOPE.threadId, signal: new AbortController().signal },
    );
    // The boundary was checked by the Mac that holds the checkout, and its
    // sentence came back verbatim. The old failure was a bare ENOENT from
    // realpath on the server, which does not have that directory.
    expect(result).toBe(REMOTE_REFUSAL);
    expect(result).not.toContain("ENOENT");
    expect(remoteValidate).toHaveBeenCalledWith(
      { kind: "remote", hostId: "host_other", machineName: "scw-mini" },
      {
        argv: ["/usr/bin/xcodebuild", "-scheme", "App", "-derivedDataPath", "../../elsewhere"],
        root: SCOPE.path,
      },
    );
    expect(confirmHostAction).not.toHaveBeenCalled();
  });

  it("names the machine and validates there before asking a person", async () => {
    const { cli, confirmHostAction, remoteValidate } = fixture("host_other");
    const result = await cli.dispatch(
      ["run", "--", "xcodebuild", "-scheme", "App", "build"],
      { threadId: SCOPE.threadId, projectId: SCOPE.projectId!, cwd: SCOPE.path },
    );
    expect(remoteValidate).toHaveBeenCalledOnce();
    // Refused by the worker, so nobody was asked to approve a doomed build.
    expect(confirmHostAction).not.toHaveBeenCalled();
    expect(result).toEqual({ exitCode: 1, stderr: `${REMOTE_REFUSAL}\n` });
  });

  it("keeps a checkout on this machine local", async () => {
    const { tools, remoteValidate } = fixture("host_server");
    const result = await tools.build.execute(
      { args: ["-scheme", "App"] },
      { threadId: SCOPE.threadId, signal: new AbortController().signal },
    );
    // It took the local path (whose realpath of a fixture directory fails),
    // and never asked a worker anything.
    expect(remoteValidate).not.toHaveBeenCalled();
    expect(result).not.toBe(REMOTE_REFUSAL);
  });
});

describe("the same checkout path on two Macs", () => {
  const ctx = { threadId: SCOPE.threadId, projectId: SCOPE.projectId!, cwd: SCOPE.path };

  it("never shows, waits on or stops the other Mac's run", async () => {
    const { cli, confirmHostAction } = fixture(null);
    for (const id of ["w:twin-live", "w:twin-unclaimed"]) {
      expect(await cli.dispatch(["show", id], ctx)).toEqual({
        exitCode: 1,
        stderr: `No run with id '${id}'.\n`,
      });
      expect(await cli.dispatch(["wait", id, "--timeout", "1"], ctx)).toEqual({
        exitCode: 1,
        stderr: `No run with id '${id}'.\n`,
      });
    }
    expect(await cli.dispatch(["stop", "w:twin-live"], ctx)).toEqual({
      exitCode: 1,
      stderr: "No run with id 'w:twin-live'.\n",
    });
    expect(confirmHostAction).not.toHaveBeenCalled();
    expect((await cli.dispatch(["status"], ctx)).stdout).not.toContain("w:twin");
    const runs = (await cli.dispatch(["runs"], ctx)).stdout ?? "";
    expect(runs).not.toContain("w:twin");
    expect(runs).toContain("r:local-unclaimed");
  });

  it("keeps a thread on the other Mac away from this machine's unclaimed run", async () => {
    const { cli, tools } = fixture("host_other");
    const runs = (await cli.dispatch(["runs"], ctx)).stdout ?? "";
    expect(runs).toContain("w:twin-unclaimed");
    expect(runs).not.toContain("r:local-unclaimed");
    expect((await cli.dispatch(["show", "r:local-unclaimed"], ctx)).exitCode).toBe(1);
    const status = await tools.status.execute({}, { threadId: SCOPE.threadId });
    expect(status).not.toContain("r:local-unclaimed");
    // Same Mac, same path: that is the same checkout, so it is this thread's.
    expect(status).toContain("w:twin-live");
  });
});

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
