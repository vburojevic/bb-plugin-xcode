/**
 * One nav panel for the whole plugin: Builds, Live, and Stills under a single
 * sidebar entry, with the tab living in the `subPath` so browser back and
 * forward walk panel history. `app/sim/route.ts` owns the namespace and why
 * run ids cannot collide with the tab segments.
 *
 * The body components are unchanged — `XcodePanel` still owns builds and its
 * run drill-in, `SimulatorsPanel` still owns live/stills/doctor. This file is
 * only the seam: one header, one route split, no duplicated state.
 */
import { useBbNavigate } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { XcodePanel } from "./XcodePanel";
import { PanelOptionsMenu } from "./PanelOptionsMenu";
import { SimulatorsPanel } from "./sim/SimulatorsPanel";
import { DevicePicker } from "./sim/DevicePicker";
import { useLive } from "./sim/useLive";
import { PANEL_PATH, subPathForTab, tabOf, type Tab } from "./sim/route";

export function PanelRoot({ subPath = "" }: { subPath?: string }) {
  const tab = tabOf(subPath);
  if (tab === "builds") return <XcodePanel subPath={subPath} />;
  return <SimulatorsPanel subPath={subPath} />;
}

/**
 * The header accessory: tab control, then the device picker on the simulator
 * tabs, then the gear. It reads the same module-level live store as the panel
 * body — the host renders this inside its own title bar, a separate React
 * tree, and a per-instance fetch here would double every `simctl` call.
 */
export function PanelHeader({ subPath = "" }: { subPath?: string }) {
  const navigate = useBbNavigate();
  const compact = useIsCompactViewport();
  const tab = tabOf(subPath);

  const go = (next: Tab): void =>
    navigate.toPluginPanel(PANEL_PATH, { subPath: subPathForTab(next) });

  return (
    <div className="flex min-w-0 items-center gap-1">
      {/* Navigation, not ARIA tabs: the panels live in another React tree, so
          the tablist contract (roving tabindex, aria-controls, arrow keys)
          cannot be honoured — and half of it is worse than none. */}
      <nav aria-label="Xcode panel sections" className="flex shrink-0 items-center rounded-md border p-0.5">
        <SegmentButton active={tab === "builds"} compact={compact} icon="Toolbox" label="Builds" onClick={() => go("builds")} />
        <SegmentButton active={tab === "live"} compact={compact} icon="Play" label="Live" onClick={() => go("live")} />
        <SegmentButton active={tab === "stills"} compact={compact} icon="GridView" label="Stills" onClick={() => go("stills")} />
      </nav>

      {/* Mounted only on the simulator tabs: `useLive` fetches the device
          list on mount, and someone reading build history should not be
          paying for a `simctl list` to do it. */}
      {tab === "builds" ? null : <HeaderDevicePicker compact={compact} />}

      <PanelOptionsMenu onOpenDoctor={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "doctor" })} />
    </div>
  );
}

function HeaderDevicePicker({ compact }: { compact: boolean }) {
  const live = useLive();
  return (
    <DevicePicker
      devices={live.devices}
      liveUdid={live.state?.device?.udid ?? null}
      onPick={(udid) => void live.start(udid)}
      label={compact ? null : (live.state?.device?.name ?? "Choose a simulator")}
    />
  );
}

function SegmentButton({
  active,
  compact,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  compact: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      aria-current={active ? "page" : undefined}
      aria-label={label}
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className="h-6 gap-1.5 px-2"
      onClick={onClick}
    >
      <Icon name={icon} className="size-3.5" />
      {compact ? null : <span className="text-xs">{label}</span>}
    </Button>
  );
}
