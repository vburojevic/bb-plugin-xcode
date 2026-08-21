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
  it("has no simulator-specific public exposure surface", async () => {
    const harness = await load();
    for (const name of ["exposeState", "exposeStart", "exposeClaim", "exposeStop"]) {
      expect(harness.registrations.rpcMethods).not.toContain(name);
    }
    const verbs = SIM_VERBS.map((command) => command.name);
    for (const name of ["expose", "unexpose", "url"]) expect(verbs).not.toContain(name);
    expect(SIM_SETTINGS).not.toHaveProperty("exposeTtlMinutes");
    expect(harness.hostCalls).toEqual([]);
  });

  it("claims exactly the surfaces it says it does", async () => {
    const harness = await load({ settings: { allowAgentCapture: true } });
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
    // No agent tool can create or return a network share. Remote viewing stays
    // inside the main bb panel.
    expect(harness.registrations.agentTools).not.toContain("simulator_expose");
  });

  it("keeps a proxied stream for the viewers that need one", async () => {
    // This route used to be the only way to see a frame, for three stated
    // reasons: the per-boot secret never reached the DOM, the URL was
    // same-origin so a remote bb panel did not hit mixed-content rules, and
    // there was one auth model instead of two.
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

  it("also refuses already-registered tools after agent capture is switched off", async () => {
    const harness = await load({ settings: { allowAgentCapture: true } });
    await harness.setSettings({ allowAgentCapture: false });
    const result = (await harness.callAgentTool(
      "simulator_capture",
      {},
      { threadId: "th_1" },
    )) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Simulator agent access is disabled");
  });

  it("refuse a capture with a sentence rather than an empty result", async () => {
    const harness = await load({ settings: { allowAgentCapture: true } });
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
    expect(help.stdout).toContain("bb xcode sim doctor");

    const unknown = await harness.runCli(["frobnicate"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('Unknown command "frobnicate"');
  });

  it("reports a simctl failure rather than an empty device list", async () => {
    const harness = await load({ settings: { allowAgentCapture: true } });
    const result = await harness.runCli(["devices"]);
    // No simulators exist in a test environment, so this exercises the failure
    // path on Linux CI and the empty path on a Mac — both are honest.
    expect([0, 1]).toContain(result.exitCode);
    if (result.exitCode === 1) {
      expect(result.stderr).toContain("could not ask about simulators");
    }
  });

  it("keeps model-facing CLI capture off by default", async () => {
    const harness = await load();
    const result = await harness.runCli(["shot"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Simulator agent access is disabled");
  });

  it("rejects screenshot output paths outside the invoking checkout before capture", async () => {
    const harness = await load({ settings: { allowAgentCapture: true } });
    const absolute = await harness.runCli(["shot", "--out", "/tmp/overwrite.jpg"], {
      cwd: "/tmp/demo",
      threadId: "th_1",
      projectId: "proj_1",
    });
    expect(absolute.stderr).toContain("not an absolute path");
    const traversal = await harness.runCli(["shot", "--out", "../overwrite.jpg"], {
      cwd: "/tmp/demo",
      threadId: "th_1",
      projectId: "proj_1",
    });
    expect(traversal.stderr).toContain("stay inside this thread's checkout");
  });

  it("requires host confirmation for agent-facing CLI host mutations", async () => {
    const harness = await load({ settings: { allowAgentCapture: true } });
    const invocation = {
      cwd: "/tmp/demo",
      threadId: "th_1",
      projectId: "proj_1",
    };

    const shot = await harness.runCli(
      ["shot", "--out", "capture.jpg"],
      invocation,
    );
    expect(shot.exitCode).toBe(1);
    expect(shot.stderr).toContain("was not confirmed");

    const stills = await harness.runCli(["stills"], invocation);
    expect(stills.exitCode).toBe(1);
    expect(stills.stderr).toContain("was not confirmed");

    const baseline = await harness.runCli(
      ["baseline", "clear"],
      invocation,
    );
    expect(baseline.exitCode).toBe(1);
    expect(baseline.stderr).toContain("was not confirmed");

  });

  it("does not return an explicitly named run outside the invoking checkout scope", async () => {
    const harness = await load({ settings: { allowAgentCapture: true } });
    const otherLookId = "lk_00000000000000000000000000";
    for (const statement of MIGRATIONS) harness.db.exec(statement);
    insertLook(harness.db, {
      id: otherLookId,
      projectId: "proj_other",
      scopeKey: "scope-other",
      kind: "stills",
      status: "ok",
      commitSha: "deadbeef",
      branch: "main",
      deviceKey: "device",
      deviceUdid: null,
      deviceName: "Private simulator",
      osVersion: "26.5",
      scale: 3,
      startedAt: 1,
    });
    const invocation = { cwd: "/tmp/demo", threadId: "th_1", projectId: "proj_1" };

    for (const argv of [
      ["look", otherLookId],
      ["card", otherLookId],
      ["baseline", "set", otherLookId],
    ]) {
      const result = await harness.runCli(argv, invocation);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe(`No run called ${otherLookId}.\n`);
    }
  });

  it("does not infer the first bb project for a CLI invocation with no checkout", async () => {
    const harness = await load({ settings: { allowAgentCapture: true } });
    const result = await harness.runCli(["look"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Run this command from the bb thread checkout");
  });
});

describe("server-side destructive authorization", () => {
  it("does not run a Stills test target from raw RPC without host confirmation", async () => {
    const harness = await load();
    const result = (await harness.callRpc("stillsRun", {
      threadId: "th_1",
      projectId: "proj_1",
    })) as { lookId: string | null; queued: number; error: string | null };
    expect(result.lookId).toBeNull();
    expect(result.queued).toBe(0);
    expect(result.error).toMatch(/not confirmed/);
  });

  it("does not erase or shut down from raw RPC without host confirmation", async () => {
    const harness = await load();
    await expect(
      harness.callRpc("liveStop", {
        erase: "11111111-2222-3333-4444-555555555555",
        threadId: "th_1",
        projectId: "proj_1",
      }),
    ).rejects.toThrow(/currently shown|not confirmed/);
  });

  it("does not purge stored rows when host confirmation is cancelled", async () => {
    const harness = await load();
    for (const statement of MIGRATIONS) harness.db.exec(statement);
    insertLook(harness.db, {
      id: "lk_keep",
      projectId: "proj_1",
      scopeKey: "scope",
      kind: "live",
      status: "ok",
      commitSha: null,
      branch: null,
      deviceKey: "device",
      deviceUdid: null,
      deviceName: null,
      osVersion: null,
      scale: null,
      startedAt: 1,
    });
    await expect(
      harness.callRpc("purgeApply", { threadId: "th_1", projectId: "proj_1" }),
    ).rejects.toThrow(/not confirmed/);
    expect(getLook(harness.db, "lk_keep")).not.toBeNull();
  });
});

describe("the gear menu's allowlist, at the RPC boundary", () => {
  it("refuses a trust-shaped key with a sentence, before any write", async () => {
    // `bb.sdk.plugins.updateSettings` is deliberately NOT stubbed here: if the
    // handler reached for it, the fake host would throw naming the unstubbed
    // path instead of this sentence — so the message match also proves the
    // write was never attempted.
    const harness = await load();
    await expect(
      harness.callRpc("uiOptionSet", { key: "allowAgentCapture", value: true }),
    ).rejects.toThrow(/not a toggle this menu owns/);
  });

  it("flips a whitelisted display toggle and answers the new truth", async () => {
    const box: { setSettings: ((next: Record<string, boolean>) => Promise<void>) | null } = {
      setSettings: null,
    };
    const harness = await load({
      sdk: {
        ...sdkStubs(),
        plugins: {
          updateSettings: async ({ values }: { values: Record<string, boolean> }) => {
            await box.setSettings?.(values);
            return {};
          },
        },
      },
    });
    box.setSettings = (next) => harness.setSettings(next);

    const result = (await harness.callRpc("uiOptionSet", {
      key: "showDeviceChrome",
      value: true,
    })) as { options: Array<{ key: string; value: boolean }> };
    expect(result.options.find((option) => option.key === "showDeviceChrome")?.value).toBe(true);
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
