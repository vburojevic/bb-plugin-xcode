/**
 * The composer banner.
 *
 * `chrome: "bare"`, and the frame is **owned rather than requested**. The host
 * mounts plugin banners under a `display: contents` wrapper and the prompt
 * stack spaces itself with `margin-bottom: 8px`; a contents box generates no
 * box, so that margin is discarded and a `chrome: "card"` banner sits flush
 * against the card below. Owning the frame is what lets `.bbxs-stack-card` own
 * the 8px — and it is `-bottom`, never `-top`, because the native stack spaces
 * downward.
 */
import { useCallback, useEffect, useState } from "react";
import { useBbContext, useBbNavigate, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { rpcContract } from "../../src/sim/wire";
import { PANEL_PATH } from "./route";
import { TONE_CLASS } from "./copy";

interface Row {
  id: string;
  kind: "failure" | "run" | "exposure";
  sentence: string;
  tone: "neutral" | "dead" | "exposed";
  dismissible: boolean;
  lookId: string | null;
  watermark: string | null;
}

export function ActivityBanner() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { threadId } = useBbContext();
  const [rows, setRows] = useState<Row[]>([]);
  // Dismissal is optimistic: the row goes now, and the RPC is fired without
  // awaiting. A banner that lingers while a round trip completes reads as a
  // control that did not work.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const refresh = useCallback(() => {
    void rpc
      .call("bannerState", { threadId: threadId ?? null })
      .then((result) => setRows((result as { rows: Row[] }).rows))
      .catch(() => {
        // A failed read renders no banner and logs server-side. The banner is
        // an offer; the panel is the surface that must never lie.
        setRows([]);
      });
  }, [rpc, threadId]);

  useEffect(refresh, [refresh]);
  useRealtime("simulator-changed", refresh);

  const visible = rows.filter((row) => !hidden.has(row.id));
  if (visible.length === 0) return null;

  return (
    <>
      {visible.map((row) => (
        <div key={row.id} className={`bbxs-stack-card ${TONE_CLASS[row.tone]}`}>
          <div
            className={`flex items-center gap-2 px-3 py-2 ${row.tone === "exposed" ? "bbxs-filled" : ""}`}
          >
            {row.tone === "exposed" ? (
              <Icon name="Globe" className="size-3.5 shrink-0" />
            ) : row.tone === "dead" ? (
              <Icon name="AlertTriangle" className="size-3.5 shrink-0" />
            ) : (
              <span className="bbxs-dot shrink-0" aria-hidden />
            )}

            <p className="min-w-0 flex-1 truncate text-sm">{row.sentence}</p>

            {row.lookId !== null ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() =>
                  navigate.toPluginPanel(PANEL_PATH, { subPath: `stills/${row.lookId ?? ""}` })
                }
              >
                Open
              </Button>
            ) : null}

            {row.kind === "exposure" ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  void rpc.call("exposeStop").then(refresh);
                }}
              >
                Stop
              </Button>
            ) : null}

            {/* A trust indicator you can hide is not one, so the exposure row
                has no dismiss control at all. */}
            {row.dismissible ? (
              <button
                type="button"
                aria-label="Dismiss"
                className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setHidden((current) => new Set(current).add(row.id));
                  if (threadId != null && row.lookId !== null && row.watermark !== null) {
                    void rpc
                      .call("bannerDismiss", {
                        threadId,
                        lookId: row.lookId,
                        watermark: row.watermark,
                      })
                      .catch(() => {
                        // It is already gone from the screen; the watermark
                        // catching up later is not worth telling anyone about.
                      });
                  }
                }}
              >
                <Icon name="X" className="size-3" />
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </>
  );
}
