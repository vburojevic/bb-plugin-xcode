/**
 * Controls, along the bottom edge.
 *
 * Controls last is deliberate: a destructive action should not be under your
 * cursor when a panel springs open.
 *
 * The overflow is split by a divider, because a device wipe and a party trick
 * are not one taxonomy. Above it, input affordances. Below it, under a heading
 * that names them, the two that end something.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EraseDialog } from "./EraseDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import type { LiveState } from "./useLive";
import type { Step } from "../../src/sim/steps.js";

export interface ControlBarProps {
  state: LiveState;
  onStep: (step: Step) => void;
  onCapture: () => void;
  onShutdown: () => void;
  onErase: () => void;
  /** What a shutdown would end right now, if anything. Drives the confirmation. */
  shutdownEnds: string | null;
  busy?: boolean;
}

export function ControlBar({
  state,
  onStep,
  onCapture,
  onShutdown,
  onErase,
  shutdownEnds,
  busy = false,
}: ControlBarProps) {
  const [erasing, setErasing] = useState(false);
  const [confirmingShutdown, setConfirmingShutdown] = useState(false);

  const live = state.kind === "streaming" || state.kind === "waiting-frame";
  const device = state.device;
  const landscape = (state.screen?.orientation ?? "portrait").startsWith("landscape");

  return (
    <div className="flex items-center gap-1 border-t px-2 py-1.5">
      <Button size="sm" disabled={!live || busy} onClick={onCapture} className="gap-1.5 pointer-coarse:h-9">
        <Icon name="Eye" className="size-3.5" />
        Capture
      </Button>

      <div className="ml-auto flex items-center gap-0.5">
        <Control
          icon="RotateCcw"
          label={landscape ? "Rotate to portrait" : "Rotate to landscape"}
          disabled={!live || busy}
          onClick={() =>
            onStep({ kind: "rotate", orientation: landscape ? "portrait" : "landscape_left" })
          }
        />
        <Control
          icon="Circle"
          label="Home"
          // Xcode 26+ silently drops the Indigo HID home button, so serve-sim
          // relaunches SpringBoard instead — which is neither instant nor
          // animated the way a real home press is. Saying so beats letting
          // someone conclude the button is broken.
          hint="relaunches SpringBoard"
          disabled={!live || busy}
          onClick={() => onStep({ kind: "button", name: "home" })}
        />
        <Control
          icon="Layers"
          label="App switcher"
          disabled={!live || busy}
          onClick={() => onStep({ kind: "button", name: "app_switcher" })}
        />
        <Control
          icon="Edit"
          label="Software keyboard"
          disabled={!live || busy}
          onClick={() => onStep({ kind: "keyboard" })}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="size-7 p-0 pointer-coarse:size-9" aria-label="More controls">
              <Icon name="MoreHorizontal" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem
              disabled={!live}
              onSelect={() => onStep({ kind: "button", name: "siri" })}
            >
              Siri
              {/* Held for ~300ms in the injector: a tap is ignored. */}
              <span className="ml-auto text-xs text-muted-foreground">holds 300ms</span>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!live} onSelect={() => onStep({ kind: "button", name: "lock" })}>
              Lock
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!live}
              onSelect={() => onStep({ kind: "button", name: "swipe_home" })}
            >
              Swipe home
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-destructive">Ends this session</DropdownMenuLabel>
            <DropdownMenuItem
              disabled={device === null}
              onSelect={() => {
                // Shutdown is confirmed whenever it would end something, and the
                // confirmation says what.
                if (shutdownEnds !== null) setConfirmingShutdown(true);
                else onShutdown();
              }}
            >
              Shut down
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={device === null}
              variant="destructive"
              onSelect={() => setErasing(true)}
            >
              Erase content and settings
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {device !== null ? (
        <>
          <EraseDialog
            open={erasing}
            deviceName={device.name}
            onOpenChange={setErasing}
            onConfirm={() => {
              setErasing(false);
              onErase();
            }}
          />
          <ConfirmDialog
            open={confirmingShutdown}
            title={`Shut down ${device.name}?`}
            body={shutdownEnds ?? ""}
            confirmLabel="Shut it down"
            onOpenChange={setConfirmingShutdown}
            onConfirm={() => {
              setConfirmingShutdown(false);
              onShutdown();
            }}
          />
        </>
      ) : null}
    </div>
  );
}

function Control({
  icon,
  label,
  hint,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  hint?: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="size-7 p-0 pointer-coarse:size-9"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          <Icon name={icon} className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{hint === undefined ? label : `${label} — ${hint}`}</TooltipContent>
    </Tooltip>
  );
}
