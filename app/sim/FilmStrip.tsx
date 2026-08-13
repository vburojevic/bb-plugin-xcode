/**
 * One preview's last frames, newest first, each with its commit and time.
 *
 * This is the question the whole plugin is sold on: you find a regression four
 * days later, and instead of bisecting a fortnight of agent commits you look at
 * the strip and see which run it moved in. One query against `frames_identity`,
 * which the schema already declares.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../../src/sim/wire";
import { formatAgo, shortSha } from "../../src/sim/format.js";
import type { CapturedFrame } from "./useLive";

interface Entry {
  frame: CapturedFrame;
  lookId: string;
  commitSha: string | null;
  capturedAt: number;
  status: string | null;
}

export function FilmStrip({ identity, onBack }: { identity: string; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    let alive = true;
    void rpc
      .call("stillsIdentityHistory", { identity })
      .then((result) => {
        if (!alive) return;
        setEntries((result as { entries: Entry[] }).entries);
      })
      .catch(() => {
        if (alive) setEntries([]);
      });
    return () => {
      alive = false;
    };
  }, [rpc, identity]);

  const name = identity.replace(/^preview:/, "").replace(/\.png$/, "");
  const now = Date.now();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1">
          <Icon name="ChevronLeft" className="size-3.5" />
          Back
        </Button>
        <p className="min-w-0 truncate font-mono text-xs">{name}</p>
      </div>

      {entries === null ? (
        <div className="bbxs-skeleton m-4 h-40" aria-hidden />
      ) : entries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-sm text-muted-foreground">
            This preview has not been rendered in any kept run.
          </p>
        </div>
      ) : (
        <ul className="bbxs-scroll flex min-h-0 flex-1 gap-3 p-4">
          {entries.map((entry) => (
            <li key={entry.frame.id} className="w-40 shrink-0 space-y-1">
              <img
                src={entry.frame.thumbUrl ?? entry.frame.url}
                alt=""
                loading="lazy"
                className="w-full rounded-md border"
                style={{ aspectRatio: `${entry.frame.width} / ${entry.frame.height}` }}
              />
              <div className="flex items-center gap-1">
                {entry.status === "changed" || entry.status === "layout-changed" ? (
                  <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                    changed
                  </Badge>
                ) : null}
                <code className="text-[11px] text-muted-foreground">
                  {shortSha(entry.commitSha) ?? "no commit"}
                </code>
              </div>
              <p className="text-[11px] text-muted-foreground">{formatAgo(entry.capturedAt, now)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
