import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { RANK, type Run } from "../src/model";
import {
  pathIsUnder,
  runMatchesScope,
  SCOPE_IDLE_TTL_MS,
  scopeFilter,
  ThreadScopes,
} from "../src/scopes";
import { MIGRATIONS, Store, type Db } from "../src/store";

const NOW = 1_700_000_000_000;

function makeScopes(): ThreadScopes {
  const scopes = new ThreadScopes();
  scopes.upsert(
    {
      threadId: "th_app",
      projectId: "proj_1",
      environmentId: "env_1",
      path: "/Users/me/.bb/worktrees/env_app/App",
      branch: "feature/login",
      active: true,
    },
    NOW,
  );
  scopes.upsert(
    {
      threadId: "th_main",
      projectId: "proj_1",
      environmentId: "env_2",
      path: "/Users/me/Git/App",
      branch: "main",
      active: false,
    },
    NOW,
  );
  return scopes;
}

describe("pathIsUnder", () => {
  it("matches the path itself and descendants only", () => {
    expect(pathIsUnder("/a/b", "/a/b")).toBe(true);
    expect(pathIsUnder("/a/b/c", "/a/b")).toBe(true);
    expect(pathIsUnder("/a/bc", "/a/b")).toBe(false);
    expect(pathIsUnder("/a", "/a/b")).toBe(false);
  });
});

describe("ThreadScopes.threadFor", () => {
  it("attributes a cwd under a scoped worktree", () => {
    expect(
      makeScopes().threadFor({
        cwd: "/Users/me/.bb/worktrees/env_app/App",
      }),
    ).toBe("th_app");
  });

  it("prefers cwd over root and picks the most specific path", () => {
    const scopes = makeScopes();
    scopes.upsert(
      {
        threadId: "th_nested",
        projectId: "proj_1",
        environmentId: "env_3",
        path: "/Users/me/Git/App/Modules/Kit",
        branch: "main",
        active: false,
      },
      NOW,
    );
    expect(
      scopes.threadFor({ cwd: "/Users/me/Git/App/Modules/Kit/Sources" }),
    ).toBe("th_nested");
  });

  it("prefers an active scope when two threads share a checkout", () => {
    const scopes = makeScopes();
    scopes.upsert(
      {
        threadId: "th_side",
        projectId: "proj_1",
        environmentId: "env_1",
        path: "/Users/me/.bb/worktrees/env_app/App",
        branch: "feature/login",
        active: false,
      },
      NOW + 1,
    );
    expect(
      scopes.threadFor({ cwd: "/Users/me/.bb/worktrees/env_app/App/Sub" }),
    ).toBe("th_app");
  });

  it("returns null for paths outside every scope", () => {
    expect(makeScopes().threadFor({ cwd: "/tmp/elsewhere" })).toBe(null);
  });

  it("prunes idle scopes past the TTL but never active ones", () => {
    const scopes = makeScopes();
    scopes.prune(NOW + SCOPE_IDLE_TTL_MS + 1);
    expect(scopes.get("th_main")).toBe(null);
    expect(scopes.get("th_app")).not.toBe(null);
  });
});

describe("runMatchesScope", () => {
  const scope = {
    threadId: "th_app",
    path: "/Users/me/.bb/worktrees/env_app/App",
    branch: "feature/login",
  };
  const base = {
    threadId: null,
    cwd: null,
    container: null,
    root: null,
    branch: null,
    worktree: null,
  };

  it("matches by persisted threadId first", () => {
    expect(runMatchesScope({ ...base, threadId: "th_app" }, scope)).toBe(true);
  });

  it("matches by cwd/container under the scope path", () => {
    expect(
      runMatchesScope(
        { ...base, container: `${scope.path}/App.xcodeproj` },
        scope,
      ),
    ).toBe(true);
  });

  it("falls back to worktree-name + branch, requiring both", () => {
    expect(
      runMatchesScope(
        { ...base, worktree: "App", branch: "feature/login" },
        scope,
      ),
    ).toBe(true);
    expect(
      runMatchesScope({ ...base, worktree: "App", branch: "main" }, scope),
    ).toBe(false);
    expect(runMatchesScope({ ...base, worktree: "App" }, scope)).toBe(false);
  });
});

describe("Store.attributeRunsToThread", () => {
  it("backfills only unattributed runs under the path since the cutoff", () => {
    const db = new Database(":memory:") as unknown as Db;
    for (const statement of MIGRATIONS) db.prepare(statement).run();
    const store = new Store(db);

    const run = (id: string, overrides: Partial<Run>): Run => ({
      id,
      status: "passed",
      statusRank: RANK.verified,
      kind: "build",
      scheme: "App",
      container: null,
      configuration: null,
      destination: null,
      projectId: null,
      root: null,
      cwd: null,
      pid: null,
      cmdline: null,
      startedAt: NOW,
      endedAt: NOW + 1000,
      errorCount: 0,
      warningCount: 0,
      analyzerCount: 0,
      testTotal: null,
      testFailed: null,
      testSkipped: null,
      bundlePath: null,
      detailed: false,
      branch: null,
      worktree: null,
      threadId: null,
      ...overrides,
    });

    store.insertRun(run("r1", { cwd: "/wt/App" }));
    store.insertRun(run("r2", { cwd: "/wt/App/Sub" }));
    store.insertRun(run("r3", { cwd: "/wt/AppOther" }));
    store.insertRun(run("r4", { cwd: "/wt/App", threadId: "th_other" }));
    store.insertRun(run("r5", { cwd: "/wt/App", startedAt: NOW - 10_000 }));

    const changed = store.attributeRunsToThread("th_app", "/wt/App", NOW - 5_000);
    expect(changed).toBe(2);
    expect(store.getRun("r1")?.threadId).toBe("th_app");
    expect(store.getRun("r2")?.threadId).toBe("th_app");
    expect(store.getRun("r3")?.threadId).toBe(null);
    expect(store.getRun("r4")?.threadId).toBe("th_other");
    expect(store.getRun("r5")?.threadId).toBe(null);
  });
});


describe("scopeFilter", () => {
  const scope = {
    threadId: "thr_mine",
    path: "/Users/v/.bb/worktrees/env_mine/indexed",
    branch: "feature",
  };
  const foreign = {
    threadId: "thr_other",
    cwd: "/Users/v/.bb/worktrees/env_other/indexed",
    container: null,
    root: "/Users/v/.bb/worktrees/env_other/indexed/ios/App/.build/DerivedData",
    branch: "bb/other-branch",
    worktree: "indexed",
  };
  const mine = { ...foreign, threadId: "thr_mine" };

  /**
   * Observed in production: a brand-new thread whose environment had not been
   * attached yet resolved to a null scope, the filter widened to the whole
   * machine, and the banner presented a finished build from a DIFFERENT and
   * since-archived worktree as that thread's last activity.
   */
  it("matches nothing when the thread's checkout is unresolved", () => {
    const filter = scopeFilter(null);
    expect(filter(foreign)).toBe(false);
    expect(filter(mine)).toBe(false);
  });

  it("opens up only when the caller explicitly asked for machine-wide", () => {
    expect(scopeFilter(null, true)(foreign)).toBe(true);
    expect(scopeFilter(scope, true)(foreign)).toBe(true);
  });

  it("keeps a resolved scope to its own checkout", () => {
    const filter = scopeFilter(scope);
    expect(filter(mine)).toBe(true);
    expect(filter(foreign)).toBe(false);
  });
});
