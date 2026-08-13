/**
 * Expose, in the panel header.
 *
 * It lives there because it is not a device control. Three states: enabled,
 * disabled with one sentence, and active — in which case the header reads
 * *"Exposed for 27 more minutes"* with `Stop` as its own control beside it.
 *
 * Minutes, not `27:14`. A second-precision countdown on a 30-minute TTL is a
 * nervous animation that re-renders the prompt stack at 1Hz, for a number
 * nobody is reading that precisely.
 *
 * The URL is a QR code and a `Copy link` button, never selectable plaintext:
 * the token is a capability, and a capability sitting in a transcript
 * screenshot is a capability someone else has.
 */
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { rpcContract } from "../../src/sim/wire";
import { formatRemaining } from "../../src/sim/format.js";
import { TONE_CLASS } from "./copy";

interface ExposeState {
  available: boolean;
  reason: string | null;
  msLeft: number | null;
  deviceName: string | null;
  consent: { title: string; facts: string[]; confirmLabel: string } | null;
}

export function ExposeControl() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ExposeState | null>(null);
  const [asking, setAsking] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void rpc
      .call("exposeState")
      .then((result) => setState(result as ExposeState))
      .catch(() => setState(null));
  }, [rpc]);

  useEffect(refresh, [refresh]);
  useRealtime("simulator-changed", refresh);

  // Minutes, so this re-renders twice a minute rather than sixty times.
  useEffect(() => {
    if (state?.msLeft == null) return;
    const timer = setInterval(refresh, 30_000);
    return () => clearInterval(timer);
  }, [state?.msLeft, refresh]);

  if (state === null) return null;

  // Active: the countdown never collapses and never moves. It is the only
  // element in that bar that is a safety claim.
  if (state.msLeft !== null) {
    return (
      <div className={`${TONE_CLASS.exposed} flex shrink-0 items-center gap-1`}>
        <span className="bbxs-filled flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs">
          <Icon name="Globe" className="size-3" />
          Exposed for {formatRemaining(state.msLeft)}
        </span>
        {url !== null ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => {
              void navigator.clipboard.writeText(url).then(
                () => toast.success("Link copied. It works until the exposure ends."),
                () => toast.error("Could not copy the link."),
              );
            }}
          >
            Copy link
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => {
            setUrl(null);
            void rpc.call("exposeStop").then(refresh);
          }}
        >
          Stop
        </Button>
      </div>
    );
  }

  if (!state.available) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0">
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" disabled>
              <Icon name="Globe" className="size-3" />
              Expose
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{state.reason ?? "Exposure is unavailable."}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 gap-1 px-2 text-xs"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        <Icon name="Globe" className="size-3" />
        Expose
      </Button>

      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{state.consent?.title ?? "Expose this simulator?"}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              {/* Three facts in words: what is on screen right now, who can
                  reach it, and for how long. */}
              <ul className="list-inside list-disc space-y-1.5 text-left">
                {(state.consent?.facts ?? []).map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void rpc
                  .call("exposeStart")
                  .then((result) => {
                    const { url: link, error } = result as { url: string | null; error: string | null };
                    if (error !== null) {
                      toast.error(error);
                      return;
                    }
                    // Returned exactly once, to the surface that asked.
                    setUrl(link);
                    setAsking(false);
                    refresh();
                  })
                  .catch((error: unknown) => {
                    toast.error(error instanceof Error ? error.message : String(error));
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {/* Reads `Expose for 30 minutes`, never `OK`. */}
              {state.consent?.confirmLabel ?? "Expose"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
