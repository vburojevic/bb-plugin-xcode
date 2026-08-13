/**
 * A simulator beside the conversation.
 *
 * The nav panel is machine-wide: one surface, one device, chosen by hand. This
 * is the per-thread one, and the difference that matters is that it **does not
 * ask**. A side panel that opens onto a device picker is a side panel nobody
 * opens twice, so this guesses — from what the thread has actually been
 * building — and puts the reason for the guess on screen next to a control for
 * changing it. `src/sim/pick.ts` has the ranking and why it is in that order.
 *
 * Everything below the header is the same `LivePanel` the nav panel renders,
 * driven by the same module-level store. Two surfaces, one stream, one set of
 * `simctl` calls: mounting this while the nav panel is open must not double the
 * work, and a module store is what makes that true.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LivePanel } from "./LivePanel";
import { ControlBar } from "./ControlBar";
import { useLive } from "./useLive";
import type { rpcContract } from "../../src/sim/contract.js";
import type { Step } from "../../src/sim/steps.js";

interface PickedDevice {
  udid: string;
  name: string;
  osVersion: string;
}

interface PickResult {
  device: PickedDevice | null;
  booted: boolean;
  reason: string | null;
  because: string | null;
  alternatives: PickedDevice[];
}

export function ThreadSimulator({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const live = useLive();
  const [pick, setPick] = useState<PickResult | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Whether this panel has already acted on its guess.
   *
   * Without it, every realtime signal that re-runs the pick would re-start the
   * stream — including the signal that *starting the stream* publishes. One
   * automatic start per mount; after that the user is driving.
   */
  const [started, setStarted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void rpc
      .call("simPick", { threadId })
      .then((result) => {
        if (!cancelled) setPick(result as PickResult);
      })
      .catch(() => {
        // A picker that cannot answer leaves the panel on its own empty state,
        // which already knows how to say why there is nothing to show.
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId]);

  // Start the guess, once, and only when nothing else is already mirroring.
  useEffect(() => {
    if (started || pick?.device == null) return;
    if (live.state?.device != null) {
      setStarted(true);
      return;
    }
    setStarted(true);
    void live.start(pick.device.udid).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    });
  }, [pick, live, started]);

  const onStep = useCallback(
    (step: Step) => {
      void live.input(step).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [live],
  );

  const switchTo = useCallback(
    (udid: string) => {
      void live.start(udid).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [live],
  );

  const current = live.state?.device ?? null;
  const alternatives = pick?.alternatives ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {current?.name ?? pick?.device?.name ?? "No simulator"}
          </p>
          {/*
            The reason for the guess, verbatim from the server. It is the whole
            difference between "why is it showing me this one" and "ah, right".
          */}
          {pick?.because != null ? (
            <p className="truncate text-xs text-muted-foreground">Picked {pick.because}.</p>
          ) : null}
        </div>

        {alternatives.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" disabled={busy}>
                <Icon name="Smartphone" className="size-4" />
                Change
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {alternatives.map((device) => (
                <DropdownMenuItem key={device.udid} onSelect={() => switchTo(device.udid)}>
                  {device.name} · {device.osVersion}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      <LivePanel
        state={live.state}
        devices={live.devices}
        onStart={(device) => void live.start(device)}
        onRefresh={live.refresh}
        onStall={live.reportStall}
        // The doctor lives in the nav panel; from here the honest move is to
        // say so rather than render a second copy of it in a 400px column.
        onOpenDoctor={() => toast.info("Open the Simulators panel for the doctor.")}
        onStep={onStep}
        controls={
          live.state === null ? null : (
            <ControlBar
              state={live.state}
              busy={busy}
              onStep={onStep}
              onCapture={() => {
                setBusy(true);
                void live
                  .capture()
                  .catch((error: unknown) => {
                    toast.error(error instanceof Error ? error.message : String(error));
                  })
                  .finally(() => setBusy(false));
              }}
              shutdownEnds={null}
              onShutdown={() => {
                const udid = live.state?.device?.udid;
                if (udid === undefined) return;
                setBusy(true);
                void live.shutdown(udid).finally(() => setBusy(false));
              }}
              onErase={() => {
                const udid = live.state?.device?.udid;
                if (udid === undefined) return;
                setBusy(true);
                void live.erase(udid).finally(() => setBusy(false));
              }}
            />
          )
        }
      />
    </div>
  );
}
