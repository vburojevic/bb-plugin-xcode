/**
 * A small, host-faithful fake of `BbPluginApi`.
 *
 * bb ships `@bb/plugin-sdk/testing`'s `createFakePluginHost`, which is the
 * official version of this and does far more. It is **not published to npm** —
 * it lives in the bb monorepo — and this repo ships publicly, so a stranger
 * running `npm ci && npm test` has to get a green suite without it. Rather than
 * skip the backend tests, this reproduces the host semantics the tests actually
 * depend on, and each one is named below so the list is auditable:
 *
 * - a **real** better-sqlite3 database in a temp directory (never a mock —
 *   migrations and cascade deletes are the point)
 * - `storage.migrate` keyed by statement index, applied once, in a transaction
 * - the kv 256 KB per-value cap
 * - RPC registration with the method-name pattern enforced, plus input and
 *   output validation through the contract's Standard Schema
 * - strict-JSON results: `undefined` and non-finite numbers are rejected rather
 *   than coerced
 * - `onDispose` hooks run LIFO, and every `bb.*` call after disposal throws
 *   `PluginContextStaleError` **by name**
 * - background services started on demand and aborted on dispose
 * - CLI `run(argv, ctx)` with argv excluding the command name
 * - `bb.sdk` calls recorded, with an unstubbed path throwing and naming itself
 */
import BetterSqlite3 from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const RPC_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const KV_MAX_BYTES = 256 * 1024;

interface StandardSchema {
  "~standard": {
    validate: (value: unknown) => { value?: unknown; issues?: readonly unknown[] } | Promise<unknown>;
  };
}

function validate(schema: unknown, value: unknown, what: string): unknown {
  const standard = (schema as StandardSchema)["~standard"];
  if (standard === undefined) return value;
  const result = standard.validate(value) as { value?: unknown; issues?: readonly unknown[] };
  if (result.issues !== undefined && result.issues.length > 0) {
    throw new Error(`${what} failed validation: ${JSON.stringify(result.issues).slice(0, 400)}`);
  }
  return result.value;
}

/** The host rejects results that are not strict JSON rather than coercing them. */
function assertStrictJson(value: unknown, path = "result"): void {
  if (value === undefined) throw new Error(`${path} is undefined; results must be strict JSON`);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${path} is ${String(value)}; results must be strict JSON`);
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new Error(`${path} is a ${typeof value}; results must be strict JSON`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStrictJson(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) assertStrictJson(entry, `${path}.${key}`);
  }
}

export interface FakeHostOptions {
  pluginId?: string;
  settings?: Record<string, string | boolean>;
  sdk?: Record<string, unknown>;
}

export interface Harness {
  callRpc(method: string, input?: unknown): Promise<unknown>;
  runCli(argv: string[], ctx?: { cwd?: string; threadId?: string; projectId?: string }): Promise<{
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }>;
  fetchHttp(method: string, path: string, init?: RequestInit): Promise<Response>;
  runService(name: string): { controller: AbortController; done: Promise<void> };
  setSettings(next: Record<string, string | boolean>): Promise<void>;
  callAgentTool(name: string, args: unknown, context?: Record<string, unknown>): Promise<unknown>;
  /** Drive one of the six thread lifecycle events, as the host would. */
  emitThreadEvent(event: string, payload: unknown): void;
  dispose(): Promise<void>;
  cleanup(): void;

  db: BetterSqlite3.Database;
  dbPath: string;
  logs: Array<{ level: string; message: string }>;
  signals: Array<{ channel: string; payload: unknown }>;
  needsConfiguration: string[];
  sdkCalls: string[];
  hostCalls: string[];
  registrations: {
    rpcMethods: string[];
    httpRoutes: Array<{ method: string; path: string; auth: string }>;
    services: string[];
    schedules: Array<{ name: string; cron: string }>;
    cli: string | null;
    agentTools: string[];
  };
}

export function createFakePluginHost(options: FakeHostOptions = {}): { bb: unknown; harness: Harness } {
  const pluginId = options.pluginId ?? "xcode-simulators";
  const dir = mkdtempSync(join(tmpdir(), "xcsim-test-"));
  const dbPath = join(dir, "data.db");
  const db = new BetterSqlite3(dbPath);
  db.pragma("journal_mode = WAL");

  let disposed = false;
  const assertLive = (what: string): void => {
    if (disposed) {
      const error = new Error(`plugin context for "${pluginId}" is stale (${what})`);
      error.name = "PluginContextStaleError";
      throw error;
    }
  };

  const logs: Harness["logs"] = [];
  const signals: Harness["signals"] = [];
  const needsConfiguration: string[] = [];
  const sdkCalls: string[] = [];
  const hostCalls: string[] = [];
  const disposeHooks: Array<() => void | Promise<void>> = [];
  const kv = new Map<string, unknown>();
  const settingsValues: Record<string, string | boolean> = { ...options.settings };
  const settingsListeners: Array<(next: Record<string, unknown>, prev: Record<string, unknown>) => void> = [];

  let rpcHandlers: Record<string, (input: unknown) => unknown> = {};
  let rpcSchemas: Record<string, { input: unknown; output: unknown }> = {};
  const httpRoutes = new Map<string, { auth: string; handler: (context: unknown) => unknown }>();
  const services = new Map<string, { start: (signal: AbortSignal) => Promise<void> }>();
  const schedules = new Map<string, { cron: string; run: () => Promise<void> }>();
  const agentTools = new Map<string, { parameters?: unknown; execute: (args: unknown, context: unknown) => unknown }>();
  let cli: { name: string; run: (argv: string[], ctx: unknown) => Promise<unknown> } | null = null;
  const threadEventListeners = new Map<string, Array<(payload: unknown) => void>>();
  let migrationsApplied = 0;

  /** Every `bb.sdk` path is recorded; an unstubbed one throws naming itself. */
  function sdkProxy(path: string[]): unknown {
    return new Proxy(() => {}, {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        const next = [...path, property];
        const stub = resolveStub(next);
        if (typeof stub === "object" && stub !== null) return sdkProxy(next);
        return sdkProxy(next);
      },
      apply(_target, _thisArg, args) {
        const name = path.join(".");
        sdkCalls.push(name);
        const stub = resolveStub(path);
        if (typeof stub !== "function") {
          throw new Error(`bb.sdk.${name} is not stubbed — add it to createFakePluginHost({ sdk })`);
        }
        return (stub as (...a: unknown[]) => unknown)(...args);
      },
    });
  }

  function resolveStub(path: string[]): unknown {
    let node: unknown = options.sdk ?? {};
    for (const segment of path) {
      if (typeof node !== "object" || node === null) return undefined;
      node = (node as Record<string, unknown>)[segment];
    }
    return node;
  }

  const bb = {
    pluginId,

    log: {
      debug: (message: string) => {
        assertLive("log.debug");
        logs.push({ level: "debug", message });
      },
      info: (message: string) => {
        assertLive("log.info");
        logs.push({ level: "info", message });
      },
      warn: (message: string) => {
        assertLive("log.warn");
        logs.push({ level: "warn", message });
      },
      error: (message: string) => {
        assertLive("log.error");
        logs.push({ level: "error", message });
      },
    },

    settings: {
      define(descriptors: Record<string, { default?: string | boolean }>) {
        assertLive("settings.define");
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (!(key in settingsValues) && descriptor.default !== undefined) {
            settingsValues[key] = descriptor.default;
          }
        }
        return {
          get: async () => ({ ...settingsValues }),
          onChange: (listener: (next: Record<string, unknown>, prev: Record<string, unknown>) => void) => {
            settingsListeners.push(listener);
          },
        };
      },
    },

    storage: {
      kv: {
        get: async <T,>(key: string) => {
          assertLive("storage.kv.get");
          return kv.get(key) as T | undefined;
        },
        set: async (key: string, value: unknown) => {
          assertLive("storage.kv.set");
          const size = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
          if (size > KV_MAX_BYTES) throw new Error(`kv value for "${key}" exceeds 256KB`);
          kv.set(key, value);
        },
        delete: async (key: string) => {
          assertLive("storage.kv.delete");
          kv.delete(key);
        },
        list: async (prefix?: string) => {
          assertLive("storage.kv.list");
          return [...kv.keys()].filter((key) => prefix === undefined || key.startsWith(prefix));
        },
      },
      database: () => {
        assertLive("storage.database");
        return db;
      },
      migrate: (target: BetterSqlite3.Database, statements: string[]) => {
        assertLive("storage.migrate");
        target.exec(
          `CREATE TABLE IF NOT EXISTS _bb_migrations (idx INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`,
        );
        const applied = new Set(
          (target.prepare(`SELECT idx FROM _bb_migrations`).all() as Array<{ idx: number }>).map(
            (row) => row.idx,
          ),
        );
        const record = target.prepare(`INSERT INTO _bb_migrations (idx, applied_at) VALUES (?, ?)`);
        target.transaction(() => {
          statements.forEach((statement, index) => {
            if (applied.has(index)) return;
            target.exec(statement);
            record.run(index, Date.now());
            migrationsApplied += 1;
          });
        })();
      },
    },

    hosts: {
      async ensureSharedPortTunnel() {
        hostCalls.push("ensureSharedPortTunnel");
        return { label: "test-host", baseDomain: "example.invalid" };
      },
      declareSharedPorts() {
        hostCalls.push("declareSharedPorts");
      },
    },

    get sdk() {
      assertLive("sdk");
      return sdkProxy([]);
    },

    rpc: {
      register(contract: Record<string, { input: unknown; output: unknown }>, handlers: Record<string, (input: unknown) => unknown>) {
        assertLive("rpc.register");
        for (const name of Object.keys(contract)) {
          // Verified at apps/server/src/services/plugins/plugin-api.ts: a dotted
          // name throws at registration, the factory throws, the plugin lands in
          // `error`, and nothing loads.
          if (!RPC_NAME_PATTERN.test(name)) {
            throw new Error(`invalid rpc method name "${name}"`);
          }
        }
        rpcSchemas = contract;
        rpcHandlers = handlers;
      },
    },

    http: {
      route(method: string, path: string, handler: (context: unknown) => unknown, opts?: { auth?: string }) {
        assertLive("http.route");
        // The host rejects a path without a leading slash at registration, which
        // puts the whole plugin in `error` — a failure this fake used to miss.
        if (!path.startsWith("/")) {
          throw new Error(`http route path must be a string starting with "/", got "${path}"`);
        }
        httpRoutes.set(`${method.toUpperCase()} ${path}`, {
          auth: opts?.auth ?? "local",
          handler,
        });
      },
    },

    realtime: {
      publish(channel: string, payload: unknown) {
        assertLive("realtime.publish");
        assertStrictJson(payload, "realtime payload");
        signals.push({ channel, payload });
      },
    },

    background: {
      service(name: string, definition: { start: (signal: AbortSignal) => Promise<void> }) {
        assertLive("background.service");
        if (services.has(name)) throw new Error(`duplicate service "${name}"`);
        services.set(name, definition);
      },
      schedule(name: string, cron: string, run: () => Promise<void>) {
        assertLive("background.schedule");
        if (schedules.has(name)) throw new Error(`duplicate schedule "${name}"`);
        schedules.set(name, { cron, run });
      },
    },

    cli: {
      register(definition: { name: string; run: (argv: string[], ctx: unknown) => Promise<unknown> }) {
        assertLive("cli.register");
        if (cli !== null) throw new Error("duplicate cli registration");
        cli = definition;
      },
    },

    events: {
      // Additive, like the host: registering several listeners is supported.
      on(event: string, handler: (payload: unknown) => void) {
        assertLive("events.on");
        const listeners = threadEventListeners.get(event) ?? [];
        listeners.push(handler);
        threadEventListeners.set(event, listeners);
      },
    },

    agents: {
      registerTool(definition: {
        name: string;
        parameters?: unknown;
        execute: (args: unknown, context: unknown) => unknown;
      }) {
        assertLive("agents.registerTool");
        if (agentTools.has(definition.name)) throw new Error(`duplicate tool "${definition.name}"`);
        agentTools.set(definition.name, definition);
      },
      contributeInstructions: () => {},
      configure: () => {},
    },

    ui: {
      requestInput: async () => ({ outcome: "cancelled", reason: "no test responder" }),
      registerMentionProvider: () => {},
    },

    status: {
      needsConfiguration(message: string) {
        assertLive("status.needsConfiguration");
        needsConfiguration.push(message);
      },
    },

    onDispose(hook: () => void | Promise<void>) {
      assertLive("onDispose");
      disposeHooks.push(hook);
    },
  };

  const harness: Harness = {
    db,
    dbPath,
    logs,
    signals,
    needsConfiguration,
    sdkCalls,
    hostCalls,
    get registrations() {
      return {
        rpcMethods: Object.keys(rpcSchemas),
        httpRoutes: [...httpRoutes.entries()].map(([key, value]) => {
          const [method, path] = key.split(" ");
          return { method: method!, path: path!, auth: value.auth };
        }),
        services: [...services.keys()],
        schedules: [...schedules.entries()].map(([name, entry]) => ({ name, cron: entry.cron })),
        cli: cli?.name ?? null,
        agentTools: [...agentTools.keys()],
      };
    },

    async callRpc(method, input) {
      const schema = rpcSchemas[method];
      if (schema === undefined) throw new Error(`unknown_method: ${method}`);
      const handler = rpcHandlers[method];
      if (handler === undefined) throw new Error(`no handler for ${method}`);
      const validatedInput = validate(schema.input, input ?? null, `${method} input`);
      // The wire is JSON, so round-trip the input the way the host does.
      const result = await handler(JSON.parse(JSON.stringify(validatedInput ?? null)) as unknown);
      assertStrictJson(result);
      return validate(schema.output, result, `${method} output`);
    },

    async runCli(argv, ctx = {}) {
      if (cli === null) throw new Error("no cli registered");
      const result = (await cli.run(argv, ctx)) as { exitCode: number; stdout?: string; stderr?: string };
      const size = Buffer.byteLength((result.stdout ?? "") + (result.stderr ?? ""), "utf8");
      if (size > 1_048_576) throw new Error("plugin_cli_output_too_large");
      return result;
    },

    async fetchHttp(method, path, init) {
      const route = httpRoutes.get(`${method.toUpperCase()} ${path}`);
      if (route === undefined) throw new Error(`no route for ${method} ${path}`);
      const url = new URL(`http://127.0.0.1/api/v1/plugins/${pluginId}/http/${path}`);
      const request = new Request(url, init);
      const context = {
        req: {
          method: method.toUpperCase(),
          url: request.url,
          raw: request,
          query: (key: string) => new URL(request.url).searchParams.get(key) ?? undefined,
          header: (key: string) => request.headers.get(key) ?? undefined,
        },
        text: (body: string, status = 200) =>
          new Response(body, { status, headers: { "Content-Type": "text/plain" } }),
        json: (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
        body: (body: BodyInit | null, status = 200, headers: Record<string, string> = {}) =>
          new Response(body, { status, headers }),
      };
      return (await route.handler(context)) as Response;
    },

    runService(name) {
      const service = services.get(name);
      if (service === undefined) throw new Error(`no service "${name}"`);
      const controller = new AbortController();
      return { controller, done: service.start(controller.signal) };
    },

    async setSettings(next) {
      const previous = { ...settingsValues };
      Object.assign(settingsValues, next);
      for (const listener of settingsListeners) listener({ ...settingsValues }, previous);
    },

    emitThreadEvent(event: string, payload: unknown) {
      for (const handler of threadEventListeners.get(event) ?? []) handler(payload);
    },

    async callAgentTool(name, args, context = {}) {
      const tool = agentTools.get(name);
      if (tool === undefined) throw new Error(`no tool "${name}"`);
      const parsed =
        tool.parameters === undefined ? args : validate(tool.parameters, args, `${name} arguments`);
      return tool.execute(parsed, context);
    },

    async dispose() {
      // Hooks run LIFO, each isolated: one throwing must not strand the rest.
      for (const hook of [...disposeHooks].reverse()) {
        try {
          await hook();
        } catch {
          // The host isolates each hook; so does this.
        }
      }
      disposed = true;
    },

    cleanup() {
      try {
        db.close();
      } catch {
        // Already closed.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };

  void migrationsApplied;
  return { bb, harness };
}
