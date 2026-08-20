/**
 * The panel header accessory: device picker and Live/Stills segmented control.
 * The segmented control drops its labels to glyphs on compact viewports; the
 * device picker then collapses to the bare chevron.
 */
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon, type IconName } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
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
  const booted = new Set(devices?.bootedUdids ?? []);
  const available = (devices?.devices ?? []).filter((device) => device.isAvailable);
  const running = available.filter((device) => booted.has(device.udid));
  const rest = available.filter((device) => !booted.has(device.udid));

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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="min-w-0 gap-1">
            {compact ? null : (
              <span className="truncate">{current?.name ?? "Choose a simulator"}</span>
            )}
            <Icon name="ChevronDown" className="size-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
          {running.length > 0 ? (
            <>
              <DropdownMenuLabel>Already running</DropdownMenuLabel>
              {running.map((device) => (
                <DropdownMenuItem key={device.udid} onSelect={() => onPick(device.udid)}>
                  <span className="truncate">{device.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{device.osVersion}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          ) : null}
          {rest.length === 0 && running.length === 0 ? (
            <DropdownMenuItem disabled>No simulators are installed.</DropdownMenuItem>
          ) : null}
          {rest.map((device) => (
            <DropdownMenuItem key={device.udid} onSelect={() => onPick(device.udid)}>
              <span className="truncate">{device.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">{device.osVersion}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
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
