/**
 * Open this thread's simulator tab when its agent starts driving.
 *
 * The server says so on `DRIVE_CHANNEL` — once per driving session, and only
 * when the `openSimulatorOnDrive` setting is on, so a client never has to ask
 * whether the feature is enabled. Every connected client hears every signal
 * (V1 realtime has no per-channel subscriptions); this thread's composer is
 * the one that acts, and only on a signal naming it.
 *
 * Opening the same action twice focuses the existing tab, so an announcement
 * that lands while the tab is already open is a no-op rather than a duplicate.
 * A tab the person closed stays closed until the next session — the server's
 * quiet window, not this hook, decides when that is.
 */
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import { DRIVE_CHANNEL, type DriveSignal } from "../../src/sim/channel.js";

/** The `threadPanelAction` id registered in `app.tsx`. */
export const SIMULATOR_PANEL_ACTION = "simulator";

function isDriveSignal(payload: unknown): payload is DriveSignal {
  return (
    typeof payload === "object" &&
    payload !== null &&
    typeof (payload as { threadId?: unknown }).threadId === "string"
  );
}

export function useOpenOnDrive(threadId: string | null): void {
  const navigate = useBbNavigate();
  useRealtime(DRIVE_CHANNEL, (payload: unknown) => {
    if (threadId === null || !isDriveSignal(payload) || payload.threadId !== threadId) return;
    // A declined open (no side panel on this surface) is logged by the host;
    // there is nothing for a banner to do about it.
    navigate.openThreadPanel({ actionId: SIMULATOR_PANEL_ACTION });
  });
}
