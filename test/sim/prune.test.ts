import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, prepareConnection } from "../../src/sim/store.js";
import { insertLook, setBaseline, setIdentityBaseline, linkThread, updateLook } from "../../src/sim/frames.js";
import { describeUsage, planPrune } from "../../src/sim/prune.js";
import { formatBytes } from "../../src/sim/format.js";
import { demoBanner, DEMO_BANNER_STATES, isDemoBannerState } from "../../src/sim/demos.js";
import { DetectCache, DETECT_TTL_MS } from "../../src/sim/detect-cache.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const MB = 1024 * 1024;

function scratch(): BetterSqlite3.Database {
  const dir = mkdtempSync(join(tmpdir(), "xcsim-prune-"));
  dirs.push(dir);
  const db = new BetterSqlite3(join(dir, "data.db"));
  prepareConnection(db);
  for (const statement of MIGRATIONS) db.exec(statement);
  return db;
}

function seed(
  db: BetterSqlite3.Database,
  id: string,
  over: { scopeKey?: string; kind?: "stills" | "live"; startedAt?: number; bytes?: number; deviceKey?: string } = {},
): void {
  insertLook(db, {
    id,
    projectId: "p",
    scopeKey: over.scopeKey ?? "scope",
    kind: over.kind ?? "stills",
    status: "ok",
    commitSha: null,
    branch: null,
    deviceKey: over.deviceKey ?? "iPhone|26.5|3|arm64",
    deviceUdid: "u",
    deviceName: "iPhone",
    osVersion: "26.5",
    scale: 3,
    startedAt: over.startedAt ?? 1,
  });
  updateLook(db, id, { bytesTotal: over.bytes ?? MB });
}

describe("retention by count", () => {
  it("keeps the newest N per scope and per kind", () => {
    // Captures and preview runs are different budgets: twenty captures must not
    // evict the preview baseline you have been comparing against all week.
    const db = scratch();
    for (let i = 0; i < 5; i += 1) seed(db, `lk_s${i}`, { kind: "stills", startedAt: i });
    for (let i = 0; i < 5; i += 1) seed(db, `lk_c${i}`, { kind: "live", startedAt: i });

    const plan = planPrune({ db, retainLooks: 2, diskBudgetBytes: 1000 * MB });
    const evicted = plan.evict.map((look) => look.id).sort();
    // Oldest three of each kind.
    expect(evicted).toEqual(["lk_c0", "lk_c1", "lk_c2", "lk_s0", "lk_s1", "lk_s2"]);
    expect(plan.reason).toBe("count");
    db.close();
  });

  it("counts scopes separately", () => {
    const db = scratch();
    for (let i = 0; i < 3; i += 1) seed(db, `lk_a${i}`, { scopeKey: "a", startedAt: i });
    for (let i = 0; i < 3; i += 1) seed(db, `lk_b${i}`, { scopeKey: "b", startedAt: i });
    const plan = planPrune({ db, retainLooks: 2, diskBudgetBytes: 1000 * MB });
    expect(plan.evict.map((look) => look.id).sort()).toEqual(["lk_a0", "lk_b0"]);
    db.close();
  });
});

describe("the three ways a look is protected", () => {
  it("never evicts a baselined, identity-baselined or thread-linked run", () => {
    const db = scratch();
    for (let i = 0; i < 6; i += 1) seed(db, `lk_${i}`, { startedAt: i });
    setBaseline(db, "scope", "iPhone|26.5|3|arm64", "lk_0", "user", 1);
    setIdentityBaseline(db, "scope", "iPhone|26.5|3|arm64", "preview:a.png", "lk_1", "user", 1);
    linkThread(db, "th_1", "lk_2", 1);

    const plan = planPrune({ db, retainLooks: 1, diskBudgetBytes: 1000 * MB });
    const evicted = new Set(plan.evict.map((look) => look.id));
    expect(evicted.has("lk_0")).toBe(false);
    expect(evicted.has("lk_1")).toBe(false);
    expect(evicted.has("lk_2")).toBe(false);
    db.close();
  });
});

describe("retention by byte budget", () => {
  it("evicts until it is under, across every scope", () => {
    const db = scratch();
    for (let i = 0; i < 10; i += 1) seed(db, `lk_${i}`, { startedAt: i, bytes: 10 * MB });
    // 100MB stored, 45MB allowed, 20 runs allowed — so only the budget bites.
    const plan = planPrune({ db, retainLooks: 20, diskBudgetBytes: 45 * MB });
    expect(plan.reason).toBe("budget");
    expect(plan.evict.length).toBe(6);
    // Oldest first.
    expect(plan.evict[0]?.id).toBe("lk_0");
    db.close();
  });

  it("counts what a run is about to write, not only what is already there", () => {
    // A budget only enforced afterwards is a budget that is always exceeded for
    // the duration of the run that exceeds it.
    const db = scratch();
    for (let i = 0; i < 4; i += 1) seed(db, `lk_${i}`, { startedAt: i, bytes: 10 * MB });
    const without = planPrune({ db, retainLooks: 20, diskBudgetBytes: 45 * MB });
    expect(without.evict).toEqual([]);
    const withIncoming = planPrune({
      db,
      retainLooks: 20,
      diskBudgetBytes: 45 * MB,
      incomingBytes: 20 * MB,
    });
    expect(withIncoming.evict.length).toBeGreaterThan(0);
    db.close();
  });

  it("keeps the newest baseline per device class even under pressure", () => {
    // Losing it would turn the next run into a first run.
    const db = scratch();
    seed(db, "lk_old", { startedAt: 1, bytes: 100 * MB });
    seed(db, "lk_new", { startedAt: 2, bytes: 100 * MB });
    setBaseline(db, "scope", "iPhone|26.5|3|arm64", "lk_new", "user", 2);
    const plan = planPrune({ db, retainLooks: 20, diskBudgetBytes: 1 * MB });
    expect(plan.evict.map((look) => look.id)).not.toContain("lk_new");
    db.close();
  });

  it("does nothing when there is nothing to do", () => {
    const db = scratch();
    seed(db, "lk_1");
    const plan = planPrune({ db, retainLooks: 20, diskBudgetBytes: 1000 * MB });
    expect(plan).toMatchObject({ evict: [], bytesFreed: 0, reason: "nothing" });
    db.close();
  });
});

describe("the usage sentence", () => {
  it("reads the way a person would say it", () => {
    expect(describeUsage(1_503_238_553, 6, formatBytes)).toBe(
      "Xcode Simulators is using 1.4 GB across 6 projects.",
    );
    expect(describeUsage(1024, 1, formatBytes)).toBe("Xcode Simulators is using 1.0 KB across 1 project.");
    expect(describeUsage(0, 0, formatBytes)).toBe("Xcode Simulators has not stored any frames yet.");
  });
});

describe("the demo banners", () => {
  it("covers every state a reviewer would want to see", () => {
    // The states worth reviewing are the failure states, and those are exactly
    // the ones you cannot produce on demand.
    expect(DEMO_BANNER_STATES).toContain("failed-build");
    expect(DEMO_BANNER_STATES).toContain("failed-no-target");
    expect(DEMO_BANNER_STATES).toContain("exposed-expiring");
  });

  it("renders the same sentences the real code does", () => {
    expect(demoBanner("changed")[0]?.sentence).toBe("12 previews moved since `a1b2c3d`");
    expect(demoBanner("running")[0]?.sentence).toBe("Rendering previews — 41/148");
    expect(demoBanner("exposed")[0]?.sentence).toBe(
      "Simulator exposed to your bb account — 27 more minutes",
    );
    // An exposure is never dismissible, even in a demo.
    expect(demoBanner("exposed")[0]?.dismissible).toBe(false);
    expect(demoBanner("off")).toEqual([]);
  });

  it("refuses a state that does not exist", () => {
    expect(isDemoBannerState("changed")).toBe(true);
    expect(isDemoBannerState("nonsense")).toBe(false);
  });
});

describe("project detection is never awaited in a handler", () => {
  /**
   * Measured on a real project: one `xcodebuild -list` took 47 seconds, inside
   * a handler the Stills panel calls on every mount and every realtime signal.
   * A handler must never wait on that.
   */
  it("answers immediately on a miss and publishes when the answer lands", async () => {
    let resolveDetect: ((value: never) => void) | null = null;
    const published: number[] = [];
    const cache = new DetectCache(
      () =>
        new Promise((resolve) => {
          resolveDetect = resolve as (value: never) => void;
        }),
      () => published.push(1),
    );

    const request = { checkoutPath: "/repo", relPath: "App.xcodeproj", scheme: "" };
    // The first ask does not block; it says "detecting".
    expect(cache.get(request)).toEqual({ status: "detecting" });
    expect(published).toEqual([]);

    resolveDetect!({ relPath: "App.xcodeproj", schemes: ["App"] } as never);
    await new Promise((resolve) => setImmediate(resolve));

    // The panel is brought back by a signal rather than by a held handler.
    expect(published).toEqual([1]);
    expect(cache.get(request)).toMatchObject({ status: "ready" });
  });

  it("shares one detection between concurrent askers", async () => {
    let calls = 0;
    const cache = new DetectCache(
      async () => {
        calls += 1;
        return { relPath: "App.xcodeproj" } as never;
      },
      () => {},
    );
    const request = { checkoutPath: "/repo", relPath: "App.xcodeproj", scheme: "" };
    await Promise.all([cache.resolve(request), cache.resolve(request), cache.resolve(request)]);
    expect(calls).toBe(1);
  });

  it("returns a stale answer rather than a spinner while it refreshes", async () => {
    let now = 1000;
    let generation = 0;
    const cache = new DetectCache(
      async () => ({ relPath: `gen${generation++}` }) as never,
      () => {},
      () => now,
    );
    const request = { checkoutPath: "/repo", relPath: "App.xcodeproj", scheme: "" };
    await cache.resolve(request);
    expect(cache.get(request)).toMatchObject({ status: "ready" });

    now += DETECT_TTL_MS + 1;
    // Stale, but present: a scheme list from four minutes ago is right far more
    // often than a spinner is useful.
    const stale = cache.get(request);
    expect(stale.status).toBe("ready");
    if (stale.status === "ready") expect(stale.project).toMatchObject({ relPath: "gen0" });
  });

  it("caches a failure as null rather than retrying on every keystroke", async () => {
    let calls = 0;
    const cache = new DetectCache(
      async () => {
        calls += 1;
        throw new Error("xcodebuild exploded");
      },
      () => {},
    );
    const request = { checkoutPath: "/repo", relPath: "App.xcodeproj", scheme: "" };
    expect(await cache.resolve(request)).toBeNull();
    expect(await cache.resolve(request)).toBeNull();
    expect(calls).toBe(1);
  });
});
