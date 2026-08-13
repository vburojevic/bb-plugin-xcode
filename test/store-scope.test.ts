/**
 * The SQL scope filter and the in-memory one must agree.
 *
 * There are now two implementations of "does this run belong to this thread's
 * checkout": `scopeClause` inside the store, applied BEFORE a limit, and
 * `runMatchesScope` in `scopes.ts`, applied to collections already in hand.
 * Two implementations of one predicate is a standing invitation to drift, and
 * drift here is invisible — a thread quietly stops seeing one of its own runs.
 * So every fixture below is asserted through both.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { RANK, type Run } from "../src/model";
import { runMatchesScope } from "../src/scopes";
import { likePrefix, MIGRATIONS, Store, type Db } from "../src/store";

const NOW = 1_700_000_000_000;

const SCOPE = {
  threadId: "th_app",
  path: "/Users/me/.bb/worktrees/env_q29t/App",
  branch: "feature/login",
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
    projectId: null,
    root: null,
    cwd: null,
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
    branch: null,
    worktree: null,
    threadId: null,
    ...overrides,
  };
}

/** Every fixture, with whether the scope should claim it. */
const CASES: Array<{ why: string; run: Run; inScope: boolean }> = [
  {
    why: "attributed to the thread when it was observed",
    run: run("r:thread", { threadId: "th_app" }),
    inScope: true,
  },
  {
    why: "cwd is the checkout itself",
    run: run("r:cwd-exact", { cwd: SCOPE.path }),
    inScope: true,
  },
  {
    why: "cwd is under the checkout",
    run: run("r:cwd-under", { cwd: `${SCOPE.path}/Sources` }),
    inScope: true,
  },
  {
    why: "container is under the checkout",
    run: run("r:container", { container: `${SCOPE.path}/App.xcworkspace` }),
    inScope: true,
  },
  {
    why: "derived data root is under the checkout",
    run: run("r:root", { root: `${SCOPE.path}/.build-sim` }),
    inScope: true,
  },
  {
    why: "same checkout name and branch, cwd unresolvable",
    run: run("r:weak", { worktree: "App", branch: "feature/login" }),
    inScope: true,
  },
  {
    why: "another thread's build entirely",
    run: run("r:other", { cwd: "/Users/me/Git/Other", threadId: "th_other" }),
    inScope: false,
  },
  {
    why: "same checkout name but a different branch",
    run: run("r:wrong-branch", { worktree: "App", branch: "main" }),
    inScope: false,
  },
  {
    why: "a sibling path that merely shares a prefix",
    run: run("r:sibling", { cwd: `${SCOPE.path}-backup/Sources` }),
    inScope: false,
  },
  {
    why: "an underscore in the path is a literal, not a LIKE wildcard",
    run: run("r:wildcard", {
      cwd: "/Users/me/.bb/worktrees/envXq29t/App/Sources",
    }),
    inScope: false,
  },
];

describe("scope filtering agrees in SQL and in memory", () => {
  it("selects exactly the runs the in-memory predicate accepts", () => {
    const store = makeStore();
    for (const entry of CASES) store.insertRun(entry.run);

    const selected = new Set(
      store.listRuns({ limit: 500, scope: SCOPE }).map((row) => row.id),
    );
    const expected = new Set(
      CASES.filter((entry) => entry.inScope).map((entry) => entry.run.id),
    );

    expect([...selected].sort()).toEqual([...expected].sort());

    // …and the in-memory predicate reaches the same verdict on each fixture,
    // one at a time, so a failure names the case that drifted.
    for (const entry of CASES) {
      expect(
        runMatchesScope(entry.run, SCOPE),
        `${entry.run.id}: ${entry.why}`,
      ).toBe(entry.inScope);
    }
  });

  it("finds a scoped run that sits far outside the machine-wide window", () => {
    const store = makeStore();
    store.insertRun(run("r:mine", { threadId: "th_app", startedAt: NOW }));
    // Two hundred unrelated builds land afterwards, as they do on a machine
    // with several agents working. Filtering after a LIMIT lost this run.
    for (let i = 0; i < 200; i++) {
      store.insertRun(
        run(`r:noise-${i}`, {
          cwd: "/Users/me/Git/Other",
          startedAt: NOW + (i + 1) * 1_000,
        }),
      );
    }

    expect(store.listRuns({ limit: 5 }).map((row) => row.id)).not.toContain(
      "r:mine",
    );
    expect(store.listRuns({ limit: 5, scope: SCOPE }).map((row) => row.id)).toEqual(
      ["r:mine"],
    );
  });

  it("scopes the problem-run query too", () => {
    const store = makeStore();
    store.insertRun(
      run("r:mine-failed", {
        threadId: "th_app",
        status: "failed",
        errorCount: 2,
        startedAt: NOW,
      }),
    );
    for (let i = 0; i < 50; i++) {
      store.insertRun(
        run(`r:other-failed-${i}`, {
          cwd: "/Users/me/Git/Other",
          status: "failed",
          errorCount: 1,
          startedAt: NOW + (i + 1) * 1_000,
        }),
      );
    }

    const failed = store.listRuns({
      onlyProblems: true,
      limit: 1,
      scope: SCOPE,
    });
    expect(failed.map((row) => row.id)).toEqual(["r:mine-failed"]);
  });
});

describe("likePrefix", () => {
  it("escapes the LIKE metacharacters that occur in real paths", () => {
    expect(likePrefix("/w/my_project")).toBe("/w/my\\_project/%");
    expect(likePrefix("/w/100%")).toBe("/w/100\\%/%");
    expect(likePrefix("/w/back\\slash")).toBe("/w/back\\\\slash/%");
  });
});

describe("getRunByBundlePath", () => {
  it("finds a run by its bundle regardless of age", () => {
    const store = makeStore();
    const bundle = "/tmp/bundles/old.xcresult";
    store.insertRun(run("r:old", { bundlePath: bundle, startedAt: NOW }));
    for (let i = 0; i < 200; i++) {
      store.insertRun(run(`r:new-${i}`, { startedAt: NOW + (i + 1) * 1_000 }));
    }
    expect(store.getRunByBundlePath(bundle)?.id).toBe("r:old");
    expect(store.getRunByBundlePath("/tmp/bundles/absent.xcresult")).toBeNull();
  });

  it("lists bundles that still need reading, and forgets them once scanned", () => {
    const store = makeStore();
    store.insertRun(
      run("r:a", { bundlePath: "/b/a.xcresult", detailed: false }),
    );
    store.insertRun(run("r:b", { bundlePath: "/b/b.xcresult", detailed: true }));
    store.insertRun(run("r:c", { bundlePath: null }));

    // `detailed` alone is not the authority: a run whose contents were read
    // still needs a scan marker, which is what makes a deliberate re-queue
    // (clearing the marker) actually re-read.
    expect(store.listUnscannedBundlePaths().sort()).toEqual([
      "/b/a.xcresult",
      "/b/b.xcresult",
    ]);

    store.markSeen("bundle-scanned:/b/b.xcresult", NOW);
    expect(store.listUnscannedBundlePaths()).toEqual(["/b/a.xcresult"]);
  });
});
