import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { mkdtempSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  NO_HANDSHAKE,
  parseHandshake,
  resolveSimHostPath,
  SIM_HOST_SYSTEM_PATH,
  startSimHost,
} from "../../src/sim/sim-host-sup.js";

const fakeChildren: EventEmitter[] = [];

afterEach(() => {
  for (const child of fakeChildren.splice(0)) child.emit("exit", 0, null);
});

/** A child process good enough to test the supervisor's contract with one. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: PassThrough;
    kill: (signal?: string) => boolean;
    killed: string[];
  };
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdin = new PassThrough();
  child.killed = [];
  child.kill = (signal = "SIGTERM") => {
    child.killed.push(signal);
    return true;
  };
  fakeChildren.push(child);
  return child;
}

describe("V1 — resolving sim-host.mjs from both install shapes", () => {
  it("finds it beside server.ts and beside dist/server.js", () => {
    const root = mkdtempSync(join(tmpdir(), "xcsim-v1-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "sim-host.mjs"), "");

    // A path install evaluates server.ts at the plugin root.
    const fromSource = resolveSimHostPath(pathToFileURL(join(root, "server.ts")).href);
    expect(fromSource.path).toBe(join(root, "sim-host.mjs"));

    // A git install prefers the bundled dist/server.js.
    const fromDist = resolveSimHostPath(pathToFileURL(join(root, "dist", "server.js")).href);
    expect(fromDist.path).toBe(join(root, "sim-host.mjs"));
  });

  it("names both candidates when it finds neither", () => {
    // "The capture host did not start" with no path in it is an unfixable bug
    // report.
    const root = mkdtempSync(join(tmpdir(), "xcsim-v1-empty-"));
    expect(() => resolveSimHostPath(pathToFileURL(join(root, "server.ts")).href)).toThrow(
      /sim-host\.mjs is not at .* or /,
    );
  });
});

describe("the handshake line", () => {
  it("reads the shapes the child can print", () => {
    expect(parseHandshake('{"ok":true,"port":51234,"addon":true}')).toEqual({
      ok: true,
      port: 51234,
      addon: true,
      addonError: null,
      error: undefined,
    });
    expect(parseHandshake('{"ok":false,"error":"nope"}')?.error).toBe("nope");
  });

  it("ignores anything that is not one", () => {
    expect(parseHandshake("starting up…")).toBeNull();
    expect(parseHandshake("[1,2,3]")).toBeNull();
    expect(parseHandshake('{"port":1}')).toBeNull();
  });
});

describe("spawning the capture host", () => {
  const deps = (spawnFn: unknown) => ({
    // A fake execPath, so the assertion is about the environment rather than
    // about this machine.
    execPath: "/fake/Electron",
    simHostPath: "/fake/plugin/sim-host.mjs",
    env: { PATH: "/usr/bin" } as NodeJS.ProcessEnv,
    spawnFn: spawnFn as never,
  });

  it("sets ELECTRON_RUN_AS_NODE unconditionally", async () => {
    // In the shipping desktop build the bb server is itself a child of
    // Electron, so `process.execPath` is the Electron binary and it behaves as
    // Node only while that variable is present.
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const started = startSimHost(deps(spawnFn), { onExit: () => {}, onLog: () => {} });

    child.stdout.push('{"ok":true,"port":4242,"addon":true}\n');
    const handle = await started;

    expect(handle.port).toBe(4242);
    expect(handle.addonLoaded).toBe(true);
    const [execPath, args, options] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; stdio: unknown },
    ];
    expect(execPath).toBe("/fake/Electron");
    expect(args).toEqual(["/fake/plugin/sim-host.mjs"]);
    expect(options.env.ELECTRON_RUN_AS_NODE).toBe("1");
    // A secret is minted per boot and is long enough that the child accepts it.
    expect(options.env.XCSIM_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // We own the port; there is nothing to discover from serve-sim's state files.
    expect(options.env.XCSIM_PORT).toBe("0");
    // Only the toolchain environment survives, and native scratch is private.
    expect(options.env.PATH).toBe(SIM_HOST_SYSTEM_PATH);
    expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(options.env.TMPDIR).toMatch(/bb-xcsim-host-/);
    expect(statSync(options.env.TMPDIR!).mode & 0o777).toBe(0o700);
    child.emit("exit", 0, null);
  });

  it("does not inherit bb or provider credentials", async () => {
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const started = startSimHost(
      { ...deps(spawnFn), env: { PATH: "/usr/bin", BB_SERVER_TOKEN: "no", OPENAI_API_KEY: "no" } },
      { onExit: () => {}, onLog: () => {} },
    );
    child.stdout.push('{"ok":true,"port":4242,"addon":true}\n');
    await started;
    const [, , options] = spawnFn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(options.env.BB_SERVER_TOKEN).toBeUndefined();
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    child.emit("exit", 0, null);
  });

  it("mints a different secret every time", async () => {
    const secrets: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const child = fakeChild();
      const spawnFn = vi.fn((_p: string, _a: string[], options: { env: NodeJS.ProcessEnv }) => {
        secrets.push(options.env.XCSIM_SECRET ?? "");
        return child;
      });
      const started = startSimHost(deps(spawnFn), { onExit: () => {}, onLog: () => {} });
      child.stdout.push('{"ok":true,"port":1,"addon":true}\n');
      await started;
    }
    expect(secrets[0]).not.toBe(secrets[1]);
  });

  it("reports the capture host did not start when no handshake arrives", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const started = startSimHost(deps(vi.fn(() => child)), { onExit: () => {}, onLog: () => {} });
      const assertion = expect(started).rejects.toThrow(NO_HANDSHAKE);
      await vi.advanceTimersByTimeAsync(10_001);
      await assertion;
      expect(child.killed).toContain("SIGTERM");
      expect(child.stdin.writableEnded).toBe(true);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(child.killed).toContain("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the child's own reason when it refuses to start", async () => {
    const child = fakeChild();
    const started = startSimHost(deps(vi.fn(() => child)), { onExit: () => {}, onLog: () => {} });
    child.stdout.push('{"ok":false,"error":"serve-sim/middleware did not resolve"}\n');
    await expect(started).rejects.toThrow("serve-sim/middleware did not resolve");
  });

  it("surfaces an addon that did not load without failing the start", async () => {
    // The panel can then say why before anyone presses Boot and waits twenty
    // seconds for nothing.
    const child = fakeChild();
    const started = startSimHost(deps(vi.fn(() => child)), { onExit: () => {}, onLog: () => {} });
    child.stdout.push('{"ok":true,"port":7,"addon":false,"addonError":"dlopen failed"}\n');
    const handle = await started;
    expect(handle.addonLoaded).toBe(false);
    expect(handle.addonError).toBe("dlopen failed");
  });

  it("tells an expected stop from a crash", async () => {
    const exits: Array<{ expected: boolean }> = [];
    const child = fakeChild();
    const started = startSimHost(deps(vi.fn(() => child)), {
      onExit: (info) => exits.push(info),
      onLog: () => {},
    });
    child.stdout.push('{"ok":true,"port":1,"addon":true}\n');
    const handle = await started;

    child.emit("exit", 70, null);
    expect(exits.at(-1)).toMatchObject({ expected: false, code: 70 });
    expect(handle.isAlive()).toBe(false);

    const second = fakeChild();
    const startedAgain = startSimHost(deps(vi.fn(() => second)), {
      onExit: (info) => exits.push(info),
      onLog: () => {},
    });
    second.stdout.push('{"ok":true,"port":1,"addon":true}\n');
    (await startedAgain).stop();
    second.emit("exit", 0, "SIGTERM");
    expect(exits.at(-1)).toMatchObject({ expected: true });
  });

  it("forwards stderr line by line without unbounded buffering", async () => {
    const lines: string[] = [];
    const child = fakeChild();
    const started = startSimHost(deps(vi.fn(() => child)), {
      onExit: () => {},
      onLog: (line) => lines.push(line),
    });
    child.stdout.push('{"ok":true,"port":1,"addon":true}\n');
    await started;

    child.stderr.push("[sim-host] first\n[sim-host] second\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual(["[sim-host] first", "[sim-host] second"]);

    // A child that writes megabytes without a newline must not grow the buffer.
    child.stderr.push("x".repeat(70_000));
    await new Promise((resolve) => setImmediate(resolve));
    child.stderr.push("y\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual(["[sim-host] first", "[sim-host] second", "y"]);
  });

  it("does not let a throwing exit reporter escape into an uncaughtException", async () => {
    // A throw from an `exit` handler is exactly the crash the child process
    // exists to prevent.
    const child = fakeChild();
    const started = startSimHost(deps(vi.fn(() => child)), {
      onExit: () => {
        throw new Error("stale handle");
      },
      onLog: () => {},
    });
    child.stdout.push('{"ok":true,"port":1,"addon":true}\n');
    await started;
    expect(() => child.emit("exit", 1, null)).not.toThrow();
  });
});
