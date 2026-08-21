/**
 * The `chatStatus` subscription, shared by the composer banner and the
 * `::xcode{…}` message directive.
 *
 * Refetches on every tracker publish (XCODE_CHANNEL) so a row updates in
 * place while xcodebuild runs, and renders correctly from the store on
 * reload. One fetch at a time; a publish landing mid-fetch queues exactly one
 * more, so a burst of probe ticks cannot stack requests.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@bb/plugin-sdk/app";

import { XCODE_CHANNEL } from "../src/channel";
import type { rpcContract } from "../src/contract";
import type { ChatStatus } from "./status-types";

/**
 * Floor between refetches, per mounted surface.
 *
 * `XCODE_CHANNEL` is machine-wide and the banner mounts on every open thread,
 * so an unthrottled subscriber turns one probe tick into an N-way rpc storm —
 * and `chatStatus` is not free: on a cold scope map it awaits two SDK calls to
 * resolve the thread's checkout. The probe can be configured down to a 1s
 * cadence, which is faster than a build's state can meaningfully change, so a
 * trailing-edge throttle costs the UI nothing and bounds the server work.
 */
const MIN_REFETCH_MS = 1_000;

export type ChatStatusState = {
  data: ChatStatus | null;
  error: boolean;
};

export function useChatStatus(
  threadId: string | null,
  runId: string | null,
  seed?: ChatStatus | null,
): ChatStatusState {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ChatStatus | null>(seed ?? null);
  const [error, setError] = useState(false);
  const inFlight = useRef(false);
  const pending = useRef(false);

  const load = useCallback(async () => {
    if (seed) {
      setData((current) => current ?? seed);
      return;
    }
    if (inFlight.current) {
      pending.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const result = await rpc.call("chatStatus", { threadId, runId });
      setData(result as ChatStatus);
      setError(false);
    } catch {
      setError(true);
    } finally {
      inFlight.current = false;
      if (pending.current) {
        pending.current = false;
        void load();
      }
    }
  }, [rpc, threadId, runId, seed]);

  // Trailing-edge throttle over the channel: a burst of publishes collapses
  // into at most one refetch per MIN_REFETCH_MS, and the last one always runs
  // so the row cannot settle on a stale snapshot.
  const lastAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = useCallback(() => {
    if (timer.current) return;
    const wait = Math.max(0, MIN_REFETCH_MS - (Date.now() - lastAt.current));
    timer.current = setTimeout(() => {
      timer.current = null;
      lastAt.current = Date.now();
      void load();
    }, wait);
  }, [load]);

  useEffect(() => {
    lastAt.current = Date.now();
    void load();
  }, [load]);
  useRealtime(XCODE_CHANNEL, schedule);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { data, error };
}

/**
 * Re-render once a second while `active`, so a live row's elapsed time — which
 * is derived from `Date.now()`, not from the server — actually advances.
 */
export function useLiveTick(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    // Slow when idle rather than off: the settled card's "2m ago" tail is
    // rendered from the same clock, and without any tick it froze at
    // whatever it said when the build finished.
    const timer = setInterval(() => setTick((n) => n + 1), active ? 1000 : 60_000);
    return () => clearInterval(timer);
  }, [active]);
}
