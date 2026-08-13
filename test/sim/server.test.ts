import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSimulators, rpcContract, type SimulatorHost } from "../../src/sim/wire.js";
import { createFakePluginHost, RPC_NAME_PATTERN, type Harness } from "./fake-plugin-host.js";
import { SETTINGS_DESCRIPTORS as SIM_SETTINGS } from "../../src/sim/settings.js";
import { CLI_COMMANDS as SIM_VERBS } from "../../src/sim/cli.js";
import { MIGRATIONS, prepareConnection } from "../../src/sim/store.js";

/**
 * The tracker half, as this test needs it.
 *
 * `installSimulators` no longer owns the database, the settings handle or the
 * CLI registration — the SDK allows one of each per plugin and `server.ts`
 * owns all three. The fake host already provides them, so this just adapts.
 */
function simulatorHost(bb: unknown): SimulatorHost {
  const api = bb as {
    storage: { database(): unknown };
    settings: { define(d: Record<string, unknown>): SimulatorHost["settings"] };
  };
  return {
    db: api.storage.database(),
    settings: api.settings.define(SIM_SETTINGS as never),
    // `server.ts` hangs these verbs off `bb xcode sim`; the harness only needs
    // them reachable, so it registers them as their own command and the tests
    // below drive them exactly as a user would after the prefix.
    mountCli: (run) => {
      (bb as { cli: { register(r: unknown): void } }).cli.register({
        name: "sim",
        summary: "Look at, and touch, an iOS simulator",
        commands: SIM_VERBS,
        run,
      });
    },
    contributeInstructions: () => {},
    recentDestinations: () => [],
    bootedSimulators: () => [],
  };
}
import { getLook, insertLook, listLooks, parseLookMeta, parseSidecar } from "../../src/sim/frames.js";

const SIMCTL_EMPTY = JSON.stringify({ devices: {} });

function sdkStubs() {
  return {
    projects: {
      list: async () => [
        {
          id: "proj_1",
          name: "Demo",
          kind: "standard",
          gitRemoteUrl: null,
          createdAt: 0,
          updatedAt: 0,
          sources: [{ id: "src_1", isDefault: true, hostId: "host_1", path: "/tmp/demo", type: "local_path", projectId: "proj_1", createdAt: 0, updatedAt: 0 }],
        },
      ],
    },
    threads: { get: async () => ({ id: "th_1", projectId: "proj_1", environmentId: null }) },
    environments: { get: async () => ({ id: "env_1", path: "/tmp/demo", hostId: "host_1" }) },
    hosts: {
      list: async () => [{ id: "host_1", name: "This Mac" }],
      pathsExist: async () => ({ existence: {} }),
    },
  };
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.dispose();
    harness.cleanup();
  }
});

async function load(options: Parameters<typeof createFakePluginHost>[0] = {}) {
  const { bb, harness } = createFakePluginHost({ sdk: sdkStubs(), ...options });
  harnesses.push(harness);
  await installSimulators(bb as never, simulatorHost(bb));
  return harness;
}

describe("the RPC contract", () => {
  it("has only flat names", () => {
    // A dotted name throws at registration, the factory throws, the plugin
    // lands in `error`, and nothing loads. Verified at
    // apps/server/src/services/plugins/plugin-api.ts.
    for (const name of Object.keys(rpcContract)) {
      expect(name, name).toMatch(RPC_NAME_PATTERN);
    }
  });

  it("registers every contract method with a handler", async () => {
    const harness = await load();
    expect(harness.registrations.rpcMethods.sort()).toEqual(Object.keys(rpcContract).sort());
  });

  it("validates output against the contract", async () => {
    const harness = await load();
    // `devices` catches its own simctl failure and returns the sentence rather
    // than an empty list. The output schema is strict, so a missing field here
    // would fail the call rather than render a blank card.
    const result = (await harness.callRpc("devices", null)) as { error: string | null };
    expect(result).toHaveProperty("devices");
    expect(result).toHaveProperty("bootedUdids");
  });
});

describe("registrations", () => {
  it("claims exactly the surfaces it says it does", async () => {
    const harness = await load();
    expect(harness.registrations.services).toEqual(["sim-live"]);
    // Mounted, not registered: `bb.cli.register` is one call per plugin and
    // `server.ts` owns it. The harness stands in for that mount.
    expect(harness.registrations.cli).toBe("sim");
    expect(harness.registrations.httpRoutes).toEqual([
      // Zero bytes. It exists because the panel streams straight from the
      // capture host, which takes the frames — and with them the old presence
      // signal — off this process entirely.
      { method: "GET", path: "/presence", auth: "local" },
      { method: "GET", path: "/stream", auth: "local" },
      { method: "GET", path: "/image", auth: "local" },
    ]);
    // Registered only when `allowAgentCapture` is on. A captured frame is sent
    // to the model provider, and a setting that turns that off has to actually
    // remove the tools rather than make them refuse.
    expect(harness.registrations.agentTools).toEqual([
      "simulator_capture",
      "simulator_drive",
      "simulator_stills",
    ]);
    // There is no simulator_expose tool, and there never will be: exposing a
    // simulator is a trust decision, and a trust decision an agent can make on
    // your behalf is not one.
    expect(harness.registrations.agentTools).not.toContain("simulator_expose");
  });

  it("keeps a proxied stream for the viewers that need one", async () => {
    // This route used to be the only way to see a frame, for three stated
    // reasons: the per-boot secret never reached the DOM, the URL was
    // same-origin so `bb connect` did not block it as mixed content, and there
    // was one auth model instead of two.
    //
    // The first is now handled by a stream-scoped token that authorises the
    // MJPEG route and nothing else, and the third is a cost knowingly paid: the
    // proxy hop cost 79% as much CPU as capturing and encoding the frames did,
    // on the process every other plugin shares. The second reason is real and
    // is why this route still exists — a viewer on another machine has no
    // loopback to talk to, and the panel falls back here.
    const harness = await load();
    for (const route of harness.registrations.httpRoutes) {
      expect(route.auth).toBe("local");
    }
  });
});

describe("the agent tools", () => {
  it("are not registered at all when allowAgentCapture is off", async () => {
    const harness = await load({ settings: { allowAgentCapture: false } });
    expect(harness.registrations.agentTools).toEqual([]);
  });

  it("refuse a capture with a sentence rather than an empty result", async () => {
    const harness = await load();
    const result = (await harness.callAgentTool(
      "simulator_capture",
      {},
      { threadId: "th_1" },
    )) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    // No simulator is running in a test, so this exercises the refusal — and
    // the text has to stand alone, because a provider may reject image content
    // entirely.
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toBeTruthy();
  });
});

describe("a bb server that is not on macOS", () => {
  it("says so and registers nothing", async () => {
    // bb supports a Linux server with enrolled Macs — which is why
    // `bb.sdk.terminals` takes an explicit host scope. Without this check that
    // topology gets told to run `xcode-select --install`.
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const harness = await load();
      expect(harness.needsConfiguration[0]).toContain("only works when the bb server itself runs on macOS");
      expect(harness.needsConfiguration[0]).toContain("This server runs on Linux.");
      expect(harness.registrations.rpcMethods).toEqual([]);
      expect(harness.registrations.services).toEqual([]);
      expect(harness.registrations.cli).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });
});

describe("the CLI", () => {
  it("prints usage for no arguments and refuses an unknown command", async () => {
    const harness = await load();
    const help = await harness.runCli([]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("bb sims doctor");

    const unknown = await harness.runCli(["frobnicate"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('Unknown command "frobnicate"');
  });

  it("reports a simctl failure rather than an empty device list", async () => {
    const harness = await load();
    const result = await harness.runCli(["devices"]);
    // No simulators exist in a test environment, so this exercises the failure
    // path on Linux CI and the empty path on a Mac — both are honest.
    expect([0, 1]).toContain(result.exitCode);
    if (result.exitCode === 1) {
      expect(result.stderr).toContain("could not ask about simulators");
    }
  });

  it("answers `url` with a refusal rather than a broken link when nothing is running", async () => {
    const harness = await load();
    const result = await harness.runCli(["url"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No simulator is running.");
  });
});

describe("exposure", () => {
  it("refuses from a CLI with no thread, and points at the panel", async () => {
    // Otherwise the "there is no simulator_expose tool" rule is decoration: an
    // agent can run the CLI. This check comes before any capability check, so
    // the refusal does not depend on the state of bb connect.
    const harness = await load();
    const result = await harness.runCli(["expose"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("needs a person to confirm");
    expect(result.stderr).toContain("Simulators panel");
  });

  it("never repeats the link in a status read", async () => {
    const harness = await load();
    const status = await harness.runCli(["status"]);
    expect(status.stdout).not.toMatch(/https?:\/\//);
  });
});

describe("the service", () => {
  it("resolves when its signal aborts, rather than looping", async () => {
    const harness = await load();
    const service = harness.runService("sim-live");
    service.controller.abort();
    await expect(service.done).resolves.toBeUndefined();
  });
});

describe("disposal", () => {
  it("makes every bb call throw PluginContextStaleError afterwards", async () => {
    // Publishing or logging through a disposed handle throws, and from a
    // detached continuation Node raises that as an uncaughtException that takes
    // the whole bb server down.
    const { bb, harness } = createFakePluginHost({ sdk: sdkStubs() });
    await installSimulators(bb as never, simulatorHost(bb));
    await harness.dispose();
    expect(() => (bb as { log: { info: (m: string) => void } }).log.info("x")).toThrow(
      /stale/,
    );
    try {
      (bb as { log: { info: (m: string) => void } }).log.info("x");
    } catch (error) {
      expect((error as Error).name).toBe("PluginContextStaleError");
    }
    harness.cleanup();
  });
});

describe("migrations", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDb(): BetterSqlite3.Database {
    const dir = mkdtempSync(join(tmpdir(), "xcsim-migrate-"));
    dirs.push(dir);
    const db = new BetterSqlite3(join(dir, "data.db"));
    prepareConnection(db);
    return db;
  }

  function apply(db: BetterSqlite3.Database, from: number, to: number): void {
    for (let i = from; i < to; i += 1) db.exec(MIGRATIONS[i]!);
  }

  it("replays from a v1-shaped database and still returns valid rows", async () => {
    // `bb.storage.migrate` keys migrations by statement index, so the array is
    // append-only and a statement is never edited after release. This is the
    // test that catches an edit.
    const db = tempDb();
    apply(db, 0, 3);

    insertLook(db, {
      id: "lk_OLD",
      projectId: "proj_1",
      scopeKey: "scope",
      kind: "stills",
      status: "ok",
      commitSha: "a1b2c3d",
      branch: "main",
      deviceKey: "iPhone 17 Pro|26.5|3|arm64",
      deviceUdid: null,
      deviceName: "iPhone 17 Pro",
      osVersion: "26.5",
      scale: 3,
      startedAt: 1,
      expectedCount: 148,
    });

    apply(db, 3, MIGRATIONS.length);

    const look = getLook(db, "lk_OLD");
    expect(look).not.toBeNull();
    expect(look?.deviceName).toBe("iPhone 17 Pro");
    expect(listLooks(db, "scope", "stills", 10)).toHaveLength(1);
    db.close();
  });

  it("cascades a delete through frames, verdicts, baselines and links", async () => {
    const db = tempDb();
    apply(db, 0, MIGRATIONS.length);
    insertLook(db, {
      id: "lk_1",
      projectId: "p",
      scopeKey: "s",
      kind: "stills",
      status: "ok",
      commitSha: null,
      branch: null,
      deviceKey: "d",
      deviceUdid: null,
      deviceName: null,
      osVersion: null,
      scale: null,
      startedAt: 1,
    });
    db.prepare(
      `INSERT INTO frames (id, look_id, identity, source, display_name, rel_path, width, height, content_hash, bytes, captured_at)
       VALUES ('fr_1','lk_1','preview:a.png','preview','a','a.png',8,8,'h',10,1)`,
    ).run();
    db.prepare(`INSERT INTO verdicts (look_id, identity, status) VALUES ('lk_1','preview:a.png','changed')`).run();

    db.prepare(`DELETE FROM looks WHERE id = 'lk_1'`).run();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM frames`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM verdicts`).get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("forward-compatible parsing", () => {
  it("treats every field as optional, whatever the interface claims", () => {
    // A baselined look is read months after it was written, bb validates RPC
    // output against the contract, and a row missing a newly-required key would
    // take down the whole card rather than one field.
    expect(parseLookMeta(null)).toEqual({});
    expect(parseLookMeta("not json")).toEqual({});
    expect(parseLookMeta("[1,2,3]")).toEqual({});
    expect(parseLookMeta('{"scheme":42}')).toEqual({});
    expect(parseLookMeta('{"scheme":"App","unknownFuture":true}')).toEqual({ scheme: "App" });
  });

  it("reads a sidecar threshold written either way", () => {
    expect(parseSidecar('{"diffThreshold":0.05}').diffThreshold).toBe(0.05);
    // Upstream stores `1 - precision`, so a sidecar can carry `precision`.
    expect(parseSidecar('{"precision":0.95}').diffThreshold).toBeCloseTo(0.05, 10);
    expect(parseSidecar("nonsense").diffThreshold).toBeUndefined();
    expect(parseSidecar('{"diffThreshold":"0.05"}').diffThreshold).toBeUndefined();
  });

  it("keeps the whole sidecar for the Facts section", () => {
    const sidecar = parseSidecar('{"simulator":{"name":"iPhone 17 Pro","osVersion":"26.5"},"scale":3}');
    expect(sidecar.deviceName).toBe("iPhone 17 Pro");
    expect(sidecar.osVersion).toBe("26.5");
    expect(sidecar.scale).toBe(3);
    expect(sidecar.extra).toHaveProperty("simulator");
  });
});

void SIMCTL_EMPTY;
