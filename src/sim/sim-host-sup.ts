/**
 * Spawning, handshaking and supervising the capture host.
 *
 * Nothing here loops. It spawns once, awaits one handshake line, then reacts to
 * `exit`. A crash is a restart with a reason attached, because the panel state
 * *"Xcode Simulators's capture process restarted"* exists precisely so a child
 * crash does not fall through to "the stream stopped, checking the simulator" —
 * which blames a healthy device and sends the user to reboot it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { curatedChildEnv } from "../child-env.js";

/** How long the child gets to print its handshake line before we give up on it. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const STOP_GRACE_MS = 2000;
export const SIM_HOST_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** The sentence the panel shows when it does not. */
export const NO_HANDSHAKE = "The capture host did not start.";

export interface Handshake {
  ok: boolean;
  port?: number;
  addon?: boolean;
  addonError?: string | null;
  error?: string;
}

export function parseHandshake(line: string): Handshake | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.ok !== "boolean") return null;
  return {
    ok: record.ok,
    port: typeof record.port === "number" ? record.port : undefined,
    addon: typeof record.addon === "boolean" ? record.addon : undefined,
    addonError: typeof record.addonError === "string" ? record.addonError : null,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

/**
 * Find `sim-host.mjs` from whichever server entry was loaded.
 *
 * A path install evaluates the wiring from `src/sim/`; a git install prefers
 * the bundled `dist/server.js`. Three candidates, and the failure names all of
 * them, because "the capture host did not start" without a path in it is an
 * unfixable bug report.
 */
export function resolveSimHostPath(
  moduleUrl: string,
  exists: (path: string) => boolean = existsSync,
): { path: string; searched: string[] } {
  const searched = [
    fileURLToPath(new URL("./sim-host.mjs", moduleUrl)),
    // Bundled, from `dist/server.js`.
    fileURLToPath(new URL("../sim-host.mjs", moduleUrl)),
    // Unbundled, from `src/sim/wire.ts`.
    fileURLToPath(new URL("../../sim-host.mjs", moduleUrl)),
  ];
  for (const candidate of searched) {
    if (exists(candidate)) return { path: candidate, searched };
  }
  throw new Error(`${NO_HANDSHAKE} sim-host.mjs is not at ${searched.join(" or ")}`);
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export interface SimHostHandle {
  port: number;
  secret: string;
  /**
   * Authorises the MJPEG route and nothing else.
   *
   * It exists to be put in a URL. The panel streams straight from the capture
   * host rather than through the bb server — the proxy hop cost 79% as much
   * CPU as capturing and encoding the frames, all of it on the process every
   * other plugin shares — and an `<img>` cannot set a header, so the
   * credential has to travel in the query string where it lands in the DOM.
   * Separating it is what keeps a leaked URL to "someone can watch" rather
   * than "someone can drive".
   */
  streamToken: string;
  addonLoaded: boolean;
  addonError: string | null;
  /** Kill it, and mark the exit as ours so no restart is reported. */
  stop(): void;
  /** True until the child exits. */
  isAlive(): boolean;
}

export interface SimHostEvents {
  /** The child exited. `expected` is true when `stop()` asked it to. */
  onExit(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }): void;
  /** One line the child wrote to stderr, trimmed and non-empty. */
  onLog(line: string): void;
}

export interface SpawnDeps {
  /** `process.execPath`. A parameter so the test can hand us a fake. */
  execPath: string;
  simHostPath: string;
  env: NodeJS.ProcessEnv;
  spawnFn?: typeof spawn;
}

/** Consume a stream line by line without letting an unterminated write grow forever. */
function onLines(
  stream: NodeJS.ReadableStream | null,
  limit: number,
  handle: (line: string) => void,
): void {
  if (stream === null) return;
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        try {
          handle(line);
        } catch {
          // A throw from a log sink must not take the stream down with it.
        }
      }
    }
    if (buffer.length > limit) buffer = "";
  });
  // A destroyed pipe during teardown is ordinary, not an error worth raising.
  stream.on("error", () => {});
}

/**
 * Start the child and wait for its handshake.
 *
 * `ELECTRON_RUN_AS_NODE: "1"` is unconditional. In the shipping desktop build
 * the bb server is itself a child of Electron, so `process.execPath` is the
 * Electron binary and it behaves as Node only while that variable is present.
 * bb's own agent-bridge code deliberately *deletes* it. The child still gets a
 * curated environment, but this one variable must be restored explicitly or
 * Electron launches a second full bb window instead of running the script.
 */
export function startSimHost(deps: SpawnDeps, events: SimHostEvents): Promise<SimHostHandle> {
  const secret = newSecret();
  const streamToken = newSecret();
  const spawnFn = deps.spawnFn ?? spawn;
  const scratch = mkdtempSync(join(tmpdir(), "bb-xcsim-host-"));
  const cleanupScratch = (): void => {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Best effort after the child exits.
    }
  };

  let child: ChildProcess;
  try {
    child = spawnFn(deps.execPath, [deps.simHostPath], {
      env: {
        ...curatedChildEnv(deps.env),
        // serve-sim invokes Apple tools by bare name internally. Its isolated
        // child must not resolve those through a Homebrew or checkout shim.
        PATH: SIM_HOST_SYSTEM_PATH,
        TMPDIR: scratch,
        ELECTRON_RUN_AS_NODE: "1",
        XCSIM_SECRET: secret,
        XCSIM_STREAM_KEY: streamToken,
        // 0 asks the child to bind an ephemeral port and tell us which. We own
        // the port; there is nothing to discover from serve-sim's state files.
        XCSIM_PORT: "0",
      },
      // stdin is a parent-liveness pipe. An abrupt parent death closes it, and
      // the child exits instead of leaving a privileged loopback server orphaned.
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    cleanupScratch();
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  let settled = false;
  let expected = false;
  let alive = true;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const stop = (): void => {
    expected = true;
    try {
      child.stdin?.end();
    } catch {
      // Already gone.
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    if (alive && killTimer === null) {
      killTimer = setTimeout(() => {
        if (!alive) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, STOP_GRACE_MS);
      killTimer.unref?.();
    }
  };

  return new Promise<SimHostHandle>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stop();
      reject(new Error(NO_HANDSHAKE));
    }, HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();

    onLines(child.stdout, 64 * 1024, (line) => {
      if (settled) return;
      const handshake = parseHandshake(line);
      if (handshake === null) return;
      settled = true;
      clearTimeout(timer);
      if (!handshake.ok || handshake.port === undefined) {
        stop();
        reject(new Error(handshake.error ?? NO_HANDSHAKE));
        return;
      }
      resolve({
        port: handshake.port,
        secret,
        streamToken,
        addonLoaded: handshake.addon === true,
        addonError: handshake.addonError ?? null,
        stop,
        isAlive: () => alive,
      });
    });

    onLines(child.stderr, 64 * 1024, (line) => events.onLog(line));

    child.on("error", (error) => {
      alive = false;
      if (killTimer !== null) clearTimeout(killTimer);
      cleanupScratch();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      alive = false;
      if (killTimer !== null) clearTimeout(killTimer);
      cleanupScratch();
      const wasExpected = expected;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(NO_HANDSHAKE));
        return;
      }
      try {
        events.onExit({ code, signal, expected: wasExpected });
      } catch {
        // The exit reporter is stale or broken. Rethrowing from an `exit`
        // handler is an uncaughtException, which is the crash we exist to
        // prevent.
      }
    });
  });
}
