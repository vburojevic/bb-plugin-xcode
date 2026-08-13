/**
 * The Stills data store.
 *
 * Module-level for the same reason as the Live store: the header and the body
 * are separate React trees, and a split view mounts the body twice.
 *
 * On error the durable state stays on screen. A panel that blanks during a
 * reconnect has told the user their run vanished.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../../src/sim/wire";
import type { CapturedFrame } from "./useLive";

export interface VerdictRow {
  identity: string;
  displayName: string;
  groupName: string;
  status: "unchanged" | "changed" | "layout-changed" | "added" | "removed" | "missing" | "errored";
  diffRatio: number | null;
  flaky: boolean;
  flakyDetail: string | null;
  frame: CapturedFrame | null;
  maskUrl: string | null;
  baseUrl: string | null;
  baseWidth: number | null;
  baseHeight: number | null;
}

export interface LookSummary {
  lookId: string | null;
  status: "running" | "ok" | "failed" | "cancelled" | "none";
  sentence: string;
  rekey: { changed: number; total: number; realCount: number; sentence: string; primaryLabel: string } | null;
  truncation: { stoppedAfter: string; neverReached: number; sentence: string } | null;
  rows: VerdictRow[];
  counts: Record<VerdictRow["status"], number>;
  missingOverflow: number;
  undiffed: boolean;
  isBaseline: boolean;
  facts: Array<{ label: string; value: string }>;
  progress: { done: number; total: number | null } | null;
  startedAt: number | null;
  endedAt: number | null;
}

export interface OnboardPlan {
  candidates: Array<{ shape: string; relPath: string }>;
  detected: {
    shape: string;
    relPath: string;
    schemes: string[];
    targets: string[];
    scheme: string | null;
    appTarget: string | null;
    snapshotTestTarget: string | null;
    summary: string;
  } | null;
  files: Array<{ relPath: string; contents: string }>;
  manualSteps: string[];
  conflict: string | null;
  alreadyDone: string[];
  checkoutElsewhere: string | null;
  searched: string | null;
}

interface Snapshot {
  summary: LookSummary | null;
  plan: OnboardPlan | null;
  error: string | null;
}

const EMPTY: Snapshot = { summary: null, plan: null, error: null };
let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
let rpc: Rpc | null = null;
let inFlight = false;
let queued = false;

function emit(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function refresh(lookId?: string): void {
  const client = rpc;
  if (client === null) return;
  if (inFlight) {
    queued = true;
    return;
  }
  inFlight = true;
  Promise.allSettled([
    client.call("stillsLatest", lookId === undefined ? {} : { lookId }),
    client.call("onboardPlan", {}),
  ])
    .then(([latest, plan]) => {
      const patch: Partial<Snapshot> = { error: null };
      if (latest.status === "fulfilled") patch.summary = latest.value as LookSummary;
      else patch.error = describe(latest.reason);
      if (plan.status === "fulfilled") patch.plan = plan.value as OnboardPlan;
      emit(patch);
    })
    .finally(() => {
      inFlight = false;
      if (queued) {
        queued = false;
        refresh();
      }
    });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resetStillsStore(): void {
  snapshot = EMPTY;
  rpc = null;
  inFlight = false;
  queued = false;
  listeners.clear();
}

/**
 * Is this project set up for Stills?
 *
 * Un-onboarded is a first-class state: the tab renders the detector's finding
 * by name rather than an empty grid.
 */
export function isOnboarded(plan: OnboardPlan | null): boolean {
  return plan?.detected?.snapshotTestTarget != null;
}

export function useStills(lookId?: string) {
  const client = useRpc<typeof rpcContract>();
  rpc = client;

  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );

  useEffect(() => refresh(lookId), [lookId]);

  useRealtime("simulator-changed", (payload: unknown) => {
    if ((payload as { kind?: string } | null)?.kind === "look") refresh(lookId);
  });

  const connection = useRealtimeConnectionState();
  useEffect(() => {
    if (connection === "connected") refresh(lookId);
  }, [connection, lookId]);

  const run = useCallback(async () => {
    const result = (await client.call("stillsRun", {})) as { error: string | null };
    if (result.error !== null) throw new Error(result.error);
    refresh();
  }, [client]);

  const setBaseline = useCallback(async () => {
    const current = snapshot.summary?.lookId;
    if (current == null) return;
    await client.call("baselineSet", { lookId: current });
    refresh();
  }, [client]);

  const acceptIdentity = useCallback(
    async (identity: string) => {
      const current = snapshot.summary?.lookId;
      if (current == null) return;
      await client.call("stillsAcceptIdentity", { lookId: current, identity });
      refresh();
    },
    [client],
  );

  const applyOnboarding = useCallback(async () => {
    const result = (await client.call("onboardApply", {})) as {
      written: string[];
      error: string | null;
    };
    if (result.error !== null) throw new Error(result.error);
    refresh();
    return result;
  }, [client]);

  return useMemo(
    () => ({ ...value, run, setBaseline, acceptIdentity, applyOnboarding, refresh: () => refresh(lookId) }),
    [value, run, setBaseline, acceptIdentity, applyOnboarding, lookId],
  );
}
