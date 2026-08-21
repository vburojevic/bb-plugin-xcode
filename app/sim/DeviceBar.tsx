/**
 * The panel header accessory: device picker and Live/Stills segmented control.
 * The segmented control drops its labels to glyphs on compact viewports; the
 * device picker then collapses to the bare chevron.
 */
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { DevicePicker } from "./DevicePicker";
import type { DeviceList, LiveState } from "./useLive";

export type Tab = "live" | "stills";

export interface DeviceBarProps {
  tab: Tab;
  onTab: (tab: Tab) => void;
  state: LiveState | null;
  devices: DeviceList | null;
  onPick: (udid: string) => void;
}

export function DeviceBar({ tab, onTab, state, devices, onPick }: DeviceBarProps) {
  const compact = useIsCompactViewport();
  const current = state?.device ?? null;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex shrink-0 items-center rounded-md border p-0.5" role="tablist">
        <SegmentButton active={tab === "live"} compact={compact} icon="Play" label="Live" onClick={() => onTab("live")} />
        <SegmentButton
          active={tab === "stills"}
          compact={compact}
          icon="GridView"
          label="Stills"
          onClick={() => onTab("stills")}
        />
      </div>

      <DevicePicker
        devices={devices}
        liveUdid={current?.udid ?? null}
        onPick={onPick}
        label={compact ? null : (current?.name ?? "Choose a simulator")}
      />
    </div>
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
      role="tab"
      aria-selected={active}
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
