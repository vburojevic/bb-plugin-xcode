/**
 * The device picker, shared by the nav panel's header and the thread panel.
 *
 * One menu, three shelves — Booted, Recent, everything else by runtime — with
 * a search field that earns its place the day a machine has fifty simulators
 * named after branches. The machine line names where these simulators actually
 * run; other enrolled Macs are listed disabled with the reason, because a row
 * that pretends to work is worse than a row that says why it cannot.
 *
 * Built on the vendored DropdownMenu so it inherits the house behaviour —
 * including collapsing to a drawer on compact viewports. The search input
 * stops key events from reaching Radix's typeahead: typing "iphone" must
 * filter the list, not jump focus around it.
 */
import { useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { sectionDevices, usedClause, type PickerDevice } from "./picker-model";
import type { DeviceList } from "./useLive";

/** Search is noise for a handful of devices and oxygen for a herd of them. */
export const SEARCH_THRESHOLD = 8;

export function familyIcon(family: string): IconName {
  switch (family) {
    case "ipad":
      return "Tablet";
    case "tv":
      return "Tv";
    case "watch":
      return "SmartWatch";
    case "vision":
      return "VisionPro";
    default:
      return "Smartphone";
  }
}

export interface DevicePickerProps {
  devices: DeviceList | null;
  /** The device the live surface is currently mirroring, if any. */
  liveUdid: string | null;
  onPick: (udid: string) => void;
  /** The trigger's label; compact surfaces pass none and get the chevron. */
  label?: string | null;
}

export function DevicePicker({ devices, liveUdid, onPick, label }: DevicePickerProps) {
  const [query, setQuery] = useState("");

  const sections = useMemo(
    () =>
      sectionDevices((devices?.devices ?? []) as PickerDevice[], {
        bootedUdids: devices?.bootedUdids ?? [],
        query,
        now: Date.now(),
      }),
    [devices, query],
  );

  const machine = devices?.machine ?? null;
  const otherMachines = devices?.otherMachines ?? [];
  const searchable = (devices?.devices.filter((device) => device.isAvailable).length ?? 0) >= SEARCH_THRESHOLD;

  return (
    <DropdownMenu onOpenChange={(open) => open || setQuery("")}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="min-w-0 gap-1">
          {label == null ? null : <span className="truncate">{label}</span>}
          <Icon name="ChevronDown" className="size-3.5 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[26rem] w-72 overflow-y-auto">
        {searchable ? (
          <div className="sticky top-0 z-10 -mx-1 -mt-1 border-b bg-popover p-1.5">
            <div className="relative">
              <Icon
                name="Search"
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                autoFocus
                value={query}
                placeholder="Search simulators"
                aria-label="Search simulators"
                className="h-7 pl-7 text-sm"
                onChange={(event) => setQuery(event.target.value)}
                // Radix typeahead and item navigation must not eat keystrokes
                // meant for the field; arrows and Escape stay with the menu.
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Escape") {
                    event.stopPropagation();
                  }
                }}
              />
            </div>
          </div>
        ) : null}

        {machine !== null && otherMachines.length > 0 ? (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Icon name="Laptop" className="size-3.5" />
              <span className="truncate">On {machine}</span>
            </DropdownMenuLabel>
            {otherMachines.map((name) => (
              <DropdownMenuItem key={name} disabled className="gap-1.5">
                <Icon name="Laptop" className="size-3.5 opacity-50" />
                <span className="truncate">{name}</span>
                <span className="ml-auto text-xs text-muted-foreground">no simulators here</span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        ) : null}

        {sections.total === 0 ? (
          <DropdownMenuItem disabled>
            {query.trim() === "" ? "No simulators are installed." : `Nothing matches “${query.trim()}”.`}
          </DropdownMenuItem>
        ) : null}

        {sections.booted.length > 0 ? (
          <>
            <DropdownMenuLabel>Booted</DropdownMenuLabel>
            {sections.booted.map((device) => (
              <DeviceRow
                key={device.udid}
                device={device}
                live={device.udid === liveUdid}
                booted
                onPick={onPick}
              />
            ))}
          </>
        ) : null}

        {sections.recent.length > 0 ? (
          <>
            {sections.booted.length > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuLabel>Recent</DropdownMenuLabel>
            {sections.recent.map((device) => (
              <DeviceRow key={device.udid} device={device} live={false} booted={false} onPick={onPick} />
            ))}
          </>
        ) : null}

        {sections.groups.map((group, index) => (
          <div key={group.label}>
            {index > 0 || sections.booted.length > 0 || sections.recent.length > 0 ? (
              <DropdownMenuSeparator />
            ) : null}
            <DropdownMenuLabel>{group.label}</DropdownMenuLabel>
            {group.devices.map((device) => (
              <DeviceRow key={device.udid} device={device} live={false} booted={false} onPick={onPick} />
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeviceRow({
  device,
  live,
  booted,
  onPick,
}: {
  device: PickerDevice;
  live: boolean;
  booted: boolean;
  onPick: (udid: string) => void;
}) {
  const clause = usedClause(device, Date.now());
  return (
    <DropdownMenuItem onSelect={() => onPick(device.udid)} className="gap-2">
      <Icon name={familyIcon(device.family)} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          {booted ? (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: "light-dark(#16a34a, #4ade80)" }}
            />
          ) : null}
          <span className="truncate">{device.name}</span>
          {live ? <span className="shrink-0 text-xs text-muted-foreground">on screen</span> : null}
        </span>
        {clause !== null ? (
          <span className="block truncate text-xs text-muted-foreground">{clause}</span>
        ) : null}
      </span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{device.osVersion}</span>
    </DropdownMenuItem>
  );
}
