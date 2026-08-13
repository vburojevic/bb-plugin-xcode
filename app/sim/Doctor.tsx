/**
 * The Doctor section.
 *
 * Renders exactly the sentences `bb sims doctor` prints — same source, same
 * order, same wording. Someone who read one and then opens the other must not
 * have to learn a second vocabulary.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "../../src/sim/wire";
import { formatBytes } from "../../src/sim/format.js";

type ProbeState = "ok" | "warn" | "blocked" | "unknown";

interface Doctor {
  probes: Array<{ id: string; label: string; state: ProbeState; detail: string; value: string | null }>;
  overall: ProbeState;
  diskBytes: number;
  scopeCount: number;
  checkoutElsewhere: string | null;
  checkedAt: number;
}

const DOT: Record<ProbeState, string> = {
  ok: "bbxs-tone bbxs-tone-live",
  warn: "bbxs-tone bbxs-tone-stalled",
  blocked: "bbxs-tone bbxs-tone-dead",
  unknown: "bbxs-tone",
};

export function Doctor() {
  const rpc = useRpc<typeof rpcContract>();
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(
    (refresh: boolean) => {
      setIsRefreshing(refresh);
      void rpc
        .call("doctor", refresh ? { refresh: true } : {})
        .then((next) => setDoctor(next as Doctor))
        .finally(() => setIsRefreshing(false));
    },
    [rpc],
  );

  useEffect(() => load(false), [load]);

  if (doctor === null) {
    return <div className="bbxs-skeleton m-4 h-40" aria-hidden />;
  }

  return (
    <div className="space-y-4 p-4">
      {doctor.checkoutElsewhere !== null ? (
        <p className="rounded-md border p-3 text-sm">{doctor.checkoutElsewhere}</p>
      ) : null}

      <ul className="space-y-3">
        {doctor.probes.map((probe) => (
          <li key={probe.id} className="flex gap-3">
            <span
              className={`${DOT[probe.state]} mt-1.5 size-2 shrink-0 rounded-full`}
              style={{ backgroundColor: "var(--bbxs)" }}
              aria-hidden
            />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium">{probe.label}</p>
              <p className="text-sm text-muted-foreground">{probe.detail}</p>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          {doctor.scopeCount === 0
            ? "Xcode Simulators has not stored any frames yet."
            : `Xcode Simulators is using ${formatBytes(doctor.diskBytes)} across ${doctor.scopeCount} ${
                doctor.scopeCount === 1 ? "project" : "projects"
              }.`}
        </p>
        <Button size="sm" variant="outline" disabled={isRefreshing} onClick={() => load(true)}>
          {isRefreshing ? "Checking…" : "Check again"}
        </Button>
      </div>
    </div>
  );
}
