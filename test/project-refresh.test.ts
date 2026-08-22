/**
 * The project list is a loopback fetch into the bb server, and it fails in
 * the real world — "TypeError: fetch failed" under host load, around
 * sleep/wake, or while the server restarts. These tests pin the failure
 * discipline: the last good list survives a failure, a sustained outage
 * warns twice (first failure + breaker open) rather than once per 4–30s
 * scan, the breaker actually skips the fetch during its cooldown, and the
 * log carries the undici `cause` chain instead of the bare TypeError.
 */

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  Collector,
  describeError,
  type CollectorProject,
} from "../src/collector";
import { Engine } from "../src/engine";
import { MIGRATIONS, Store, type Db } from "../src/store";

function harness(listProjects: (signal?: AbortSignal) => Promise<CollectorProject[]>): {
  collector: Collector;
  warns: string[];
  debugs: string[];
} {
  const db = new Database(":memory:") as unknown as Db;
  for (const statement of MIGRATIONS) db.prepare(statement).run();
  const store = new Store(db);
  const engine = new Engine(store, {
    projectFor: () => null,
    threadFor: () => null,
    log: () => undefined,
  });
  const warns: string[] = [];
  const debugs: string[] = [];
  const collector = new Collector(
    {
      store,
      engine,
      listProjects,
      log: {
        debug: (m) => debugs.push(m),
        warn: (m) => warns.push(m),
      },
      dataDir: "/tmp/xc-project-refresh-datadir",
      findTool: async () => null,
    },
    { scanProjects: false, extraRoots: [] },
  );
  return { collector, warns, debugs };
}

function fetchFailed(): Error {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:7777"), {
      name: "Error",
    }),
  });
}

describe("refreshProjects failure discipline", () => {
  it("keeps the last good list when a refresh fails", async () => {
    let fail = false;
    const { collector } = harness(async () => {
      if (fail) throw fetchFailed();
      return [{ id: "p1", name: "Demo", path: "/tmp/demo" }];
    });
    await collector.refreshProjects(1_000);
    expect(collector.getProjects()).toHaveLength(1);
    fail = true;
    await collector.refreshProjects(2_000);
    expect(collector.getProjects()).toHaveLength(1);
  });

  it("warns twice per outage, then skips fetches for the cooldown", async () => {
    let calls = 0;
    const { collector, warns, debugs } = harness(async () => {
      calls += 1;
      throw fetchFailed();
    });
    // A sustained outage, scanned every "4s".
    await collector.refreshProjects(4_000);
    await collector.refreshProjects(8_000);
    await collector.refreshProjects(12_000); // breaker opens here
    await collector.refreshProjects(16_000); // inside cooldown: skipped
    await collector.refreshProjects(20_000); // inside cooldown: skipped
    expect(calls).toBe(3);
    expect(warns).toHaveLength(2);
    expect(warns[1]).toContain("pausing refresh");
    expect(debugs.some((m) => m.includes("project list failed"))).toBe(true);

    // Cooldown over, still down: retries once, quietly, re-arms the breaker.
    await collector.refreshProjects(12_000 + 5 * 60_000 + 1);
    expect(calls).toBe(4);
    expect(warns).toHaveLength(2);
  });

  it("recovers and resets after a successful refresh", async () => {
    let fail = true;
    const { collector, warns } = harness(async () => {
      if (fail) throw fetchFailed();
      return [{ id: "p1", name: "Demo", path: "/tmp/demo" }];
    });
    await collector.refreshProjects(4_000);
    await collector.refreshProjects(8_000);
    await collector.refreshProjects(12_000); // breaker open
    fail = false;
    await collector.refreshProjects(12_000 + 5 * 60_000 + 1);
    expect(collector.getProjects()).toHaveLength(1);
    // A fresh outage warns again from scratch — the streak reset.
    fail = true;
    await collector.refreshProjects(12_000 + 10 * 60_000);
    expect(warns).toHaveLength(3);
  });

  it("stays quiet when the refresh dies of a reload abort", async () => {
    const controller = new AbortController();
    const { collector, warns, debugs } = harness(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    await collector.refreshProjects(1_000, controller.signal);
    expect(warns).toHaveLength(0);
    expect(debugs).toHaveLength(0);
  });
});

describe("describeError", () => {
  it("surfaces the undici cause chain", () => {
    const detail = describeError(fetchFailed());
    expect(detail).toContain("fetch failed");
    expect(detail).toContain("ECONNREFUSED");
  });

  it("handles non-Error values", () => {
    expect(describeError("boom")).toBe("boom");
  });
});
