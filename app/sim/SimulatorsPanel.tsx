/**
 * The nav panel: one route, two tabs, full-bleed body.
 *
 * Tab state is the `subPath`, navigated with `toPluginPanel` so browser back
 * and forward walk panel history rather than dead-ending:
 *
 *   ""                              → Live
 *   "stills"                        → the latest run
 *   "stills/<lookId>"               → one run
 *   "stills/<lookId>/<identity>"    → one preview's filmstrip
 *   "doctor"                        → every prerequisite and its fix
 *
 * The host renders the title, so nothing in here repeats it.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useBbNavigate } from "@bb/plugin-sdk/app";
import { LivePanel } from "./LivePanel";
import { ControlBar } from "./ControlBar";
import { FramesStrip } from "./FramesStrip";
import { StillsPanel } from "./StillsPanel";
import { FilmStrip } from "./FilmStrip";
import { Onboarding } from "./Onboarding";
import { Doctor } from "./Doctor";
import { useLive } from "./useLive";
import { isOnboarded, useStills } from "./useStills";
import { PANEL_PATH } from "./route";
import type { Step } from "../../src/sim/steps.js";

/** `stills/<lookId>/<identity>` — the identity may contain slashes. */
export function parseStillsPath(subPath: string): { lookId?: string; identity?: string } {
  const rest = subPath.replace(/^stills\/?/, "");
  if (rest === "") return {};
  const slash = rest.indexOf("/");
  if (slash === -1) return { lookId: rest };
  return { lookId: rest.slice(0, slash), identity: decodeURIComponent(rest.slice(slash + 1)) };
}

export function SimulatorsPanel({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const go = useCallback(
    (next: string) => navigate.toPluginPanel(PANEL_PATH, { subPath: next }),
    [navigate],
  );

  if (subPath === "doctor") {
    return (
      <div className="bbxs-scroll h-full">
        <Doctor />
      </div>
    );
  }
  if (subPath.startsWith("stills")) {
    return <StillsRoute subPath={subPath} go={go} />;
  }
  return <LiveRoute go={go} />;
}

function LiveRoute({ go }: { go: (next: string) => void }) {
  const live = useLive();
  const [busy, setBusy] = useState(false);

  /**
   * Input is fire-and-forget with one exception: a refusal is worth saying out
   * loud, because the alternative is a tap that appears to do nothing.
   */
  const onStep = useCallback(
    (step: Step) => {
      void live.input(step).catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [live],
  );

  return (
    <LivePanel
      state={live.state}
      devices={live.devices}
      onStart={(device) => void live.start(device)}
      onRefresh={live.refresh}
      onStall={live.reportStall}
      onOpenDoctor={() => go("doctor")}
      onStep={onStep}
      belowMeta={<FramesStrip frames={live.frames} now={Date.now()} />}
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
  );
}

function StillsRoute({ subPath, go }: { subPath: string; go: (next: string) => void }) {
  const { lookId, identity } = parseStillsPath(subPath);
  const stills = useStills(lookId);
  const [busy, setBusy] = useState(false);

  const guard = useCallback((work: Promise<unknown>) => {
    setBusy(true);
    void work
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setBusy(false));
  }, []);

  if (identity !== undefined && lookId !== undefined) {
    return (
      <FilmStrip
        identity={identity}
        onBack={() => go(`stills/${lookId}`)}
      />
    );
  }

  return (
    <StillsPanel
      summary={stills.summary}
      isOnboarded={isOnboarded(stills.plan)}
      onboarding={
        <Onboarding
          plan={stills.plan}
          busy={busy}
          onApply={() => guard(stills.applyOnboarding())}
          onChoose={() => {
            toast.message("Set the project path in this plugin's settings to switch project.");
          }}
        />
      }
      busy={busy}
      baselineReplaces={null}
      onRun={() => guard(stills.run())}
      onSetBaseline={() => guard(stills.setBaseline())}
      onAcceptIdentity={(id) => guard(stills.acceptIdentity(id))}
      onOpenFilmstrip={(id) =>
        go(`stills/${stills.summary?.lookId ?? ""}/${encodeURIComponent(id)}`)
      }
    />
  );
}
