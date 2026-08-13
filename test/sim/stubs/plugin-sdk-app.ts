/**
 * Runtime stand-in for `@bb/plugin-sdk/app`, so components can be rendered in
 * jsdom without a bb app shell.
 *
 * bb's own `@bb/plugin-sdk/testing/app` harness is the official version of
 * this, but it is not published to npm — this repo ships publicly and a
 * stranger running `npm ci && npm test` has to get a green suite. So the hooks
 * the plugin uses are reimplemented here with the semantics the host documents,
 * and `CONTRIBUTING.md` records which ones and why.
 *
 * Everything a test wants to assert lands in `inspect()`.
 */
import { useEffect, useSyncExternalStore } from "react";

type Handler = (payload: unknown) => void;

export interface TestRuntime {
  rpc: Record<string, (input: unknown) => unknown>;
  settings: Record<string, unknown>;
  context: { projectId: string | null; threadId: string | null };
  realtimeConnectionState: "connecting" | "connected" | "reconnecting";
}

interface Inspection {
  rpcCalls: Array<{ method: string; input: unknown }>;
  navigateCalls: Array<{ path: string; subPath: string | undefined }>;
  openThreadPanelCalls: Array<{ actionId: string; params: unknown }>;
}

let runtime: TestRuntime = {
  rpc: {},
  settings: {},
  context: { projectId: null, threadId: null },
  realtimeConnectionState: "connected",
};
let inspection: Inspection = { rpcCalls: [], navigateCalls: [], openThreadPanelCalls: [] };
const channels = new Map<string, Set<Handler>>();
const connectionListeners = new Set<() => void>();

export function installTestRuntime(partial: Partial<TestRuntime> = {}): void {
  runtime = {
    rpc: partial.rpc ?? {},
    settings: partial.settings ?? {},
    context: partial.context ?? { projectId: null, threadId: null },
    realtimeConnectionState: partial.realtimeConnectionState ?? "connected",
  };
  inspection = { rpcCalls: [], navigateCalls: [], openThreadPanelCalls: [] };
  channels.clear();
  connectionListeners.clear();
}

export function inspect(): Inspection {
  return inspection;
}

/** Drive the same signal the backend would publish. */
export function emitRealtime(channel: string, payload: unknown): void {
  for (const handler of channels.get(channel) ?? []) handler(payload);
}

export function setConnectionState(next: TestRuntime["realtimeConnectionState"]): void {
  runtime.realtimeConnectionState = next;
  for (const listener of connectionListeners) listener();
}

export function useRpc<_T = unknown>(): { call: (method: string, input?: unknown) => Promise<unknown> } {
  return {
    async call(method: string, input?: unknown) {
      inspection.rpcCalls.push({ method, input });
      const handler = runtime.rpc[method];
      if (handler === undefined) throw new Error(`unknown_method: ${method}`);
      // The wire round-trips through JSON, so a test that returns a Date or an
      // undefined would otherwise pass here and fail in the host.
      return JSON.parse(JSON.stringify(handler(input))) as unknown;
    },
  };
}

export function useRealtime(channel: string, handler: Handler): void {
  useEffect(() => {
    let set = channels.get(channel);
    if (set === undefined) {
      set = new Set();
      channels.set(channel, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  });
}

export function useRealtimeConnectionState(): TestRuntime["realtimeConnectionState"] {
  return useSyncExternalStore(
    (listener) => {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    () => runtime.realtimeConnectionState,
    () => runtime.realtimeConnectionState,
  );
}

export function useSettings(): { values: Record<string, unknown>; isLoading: boolean } {
  return { values: runtime.settings, isLoading: false };
}

export function useBbContext(): { projectId: string | null; threadId: string | null } {
  return runtime.context;
}

export function useBbNavigate(): {
  toThread: (id: string) => void;
  toProject: (id: string) => void;
  toPluginPanel: (path: string, options?: { subPath?: string; replace?: boolean }) => void;
  toCompose: (options?: { initialPrompt?: string; focusPrompt?: boolean }) => void;
  openThreadPanel: (options: { actionId: string; title?: string; params?: unknown }) => boolean;
} {
  return {
    toThread: () => {},
    toProject: () => {},
    toPluginPanel: (path, options) => {
      inspection.navigateCalls.push({ path, subPath: options?.subPath });
    },
    toCompose: () => {},
    openThreadPanel: ({ actionId, params }) => {
      inspection.openThreadPanelCalls.push({ actionId, params: params ?? null });
      return true;
    },
  };
}

export interface RegisteredApp {
  navPanels: Array<Record<string, unknown>>;
  threadPanelActions: Array<Record<string, unknown>>;
  messageDirectives: Array<Record<string, unknown>>;
  composerCustomizations: Array<Record<string, unknown>>;
}

let registered: RegisteredApp = {
  navPanels: [],
  threadPanelActions: [],
  messageDirectives: [],
  composerCustomizations: [],
};

export function definePluginApp(setup: (app: unknown) => void): RegisteredApp {
  registered = {
    navPanels: [],
    threadPanelActions: [],
    messageDirectives: [],
    composerCustomizations: [],
  };
  setup({
    slots: {
      navPanel: (entry: Record<string, unknown>) => registered.navPanels.push(entry),
      threadPanelAction: (entry: Record<string, unknown>) => registered.threadPanelActions.push(entry),
      messageDirective: (entry: Record<string, unknown>) => registered.messageDirectives.push(entry),
      homepageSection: () => {},
      settingsSection: () => {},
      pendingInteraction: () => {},
      sidebarFooterAction: () => {},
    },
    composer: {
      customize: (entry: Record<string, unknown>) => registered.composerCustomizations.push(entry),
    },
    contentScripts: { register: () => {} },
  });
  return registered;
}
