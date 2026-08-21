/**
 * The gear: quick toggles for what this plugin shows, without a trip to bb's
 * settings screen.
 *
 * The server owns the list — labels, order, values — through the `uiOptions`
 * allowlist, so this menu cannot grow a switch the security model would mind
 * (`src/sim/options.ts` says why `allowAgentCapture` can never appear here).
 * Toggling is optimistic: the row flips at once, and the server's answer —
 * or its refusal — is the state that stays.
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import type { rpcContract } from "../src/sim/wire";

interface UiOption {
  key: string;
  label: string;
  detail: string;
  value: boolean;
}

export function PanelOptionsMenu({ onOpenDoctor }: { onOpenDoctor?: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [options, setOptions] = useState<UiOption[] | null>(null);

  const load = useCallback(
    (open: boolean) => {
      if (!open) return;
      void rpc
        .call("uiOptions", null)
        .then((result) => setOptions((result as { options: UiOption[] }).options))
        .catch(() => {
          // The menu opens on stale rows, or none; the next open retries.
        });
    },
    [rpc],
  );

  const toggle = useCallback(
    (key: string, value: boolean) => {
      setOptions((current) =>
        current === null
          ? current
          : current.map((option) => (option.key === key ? { ...option, value } : option)),
      );
      void rpc
        .call("uiOptionSet", { key, value })
        .then((result) => setOptions((result as { options: UiOption[] }).options))
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error));
          // The server's truth beats the optimistic flip.
          void rpc
            .call("uiOptions", null)
            .then((result) => setOptions((result as { options: UiOption[] }).options))
            .catch(() => undefined);
        });
    },
    [rpc],
  );

  return (
    <DropdownMenu onOpenChange={load}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Panel options" className="pointer-coarse:size-9">
          <Icon name="Settings" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        {(options ?? []).map((option) => (
          <DropdownMenuCheckboxItem
            key={option.key}
            checked={option.value}
            // Keep the menu open: toggling three things should not cost three
            // trips through the trigger.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(next) => toggle(option.key, next === true)}
          >
            <span className="min-w-0">
              <span className="block truncate">{option.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{option.detail}</span>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        {options === null ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">Loading…</DropdownMenuLabel>
        ) : null}
        {onOpenDoctor === undefined ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onOpenDoctor} className="gap-1.5">
              <Icon name="ListTodo" className="size-3.5" />
              Doctor — every prerequisite and its fix
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
