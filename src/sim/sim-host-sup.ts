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
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/** How long the child gets to print its handshake line before we give up on it. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

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
 * bb's own agent-bridge code deliberately *deletes* it, so the instinct to hand
 * the child a curated environment is exactly how you launch a second full bb
 * window instead of a script. No preflight probe would catch it: the addon and
 * version checks both pass.
 */
export function startSimHost(deps: SpawnDeps, events: SimHostEvents): Promise<SimHostHandle> {
  const secret = newSecret();
  const spawnFn = deps.spawnFn ?? spawn;

  let child: ChildProcess;
  try {
    child = spawnFn(deps.execPath, [deps.simHostPath], {
      env: {
        ...deps.env,
        ELECTRON_RUN_AS_NODE: "1",
        XCSIM_SECRET: secret,
        // 0 asks the child to bind an ephemeral port and tell us which. We own
        // the port; there is nothing to discover from serve-sim's state files.
        XCSIM_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  let settled = false;
  let expected = false;
  let alive = true;

  const stop = (): void => {
    expected = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
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
        addonLoaded: handshake.addon === true,
        addonError: handshake.addonError ?? null,
        stop,
        isAlive: () => alive,
      });
    });

    onLines(child.stderr, 64 * 1024, (line) => events.onLog(line));

    child.on("error", (error) => {
      alive = false;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("exit", (code, signal) => {
      alive = false;
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
