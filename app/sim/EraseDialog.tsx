/**
 * Erase requires typing the device name.
 *
 * Not because typing is a security boundary — it is not — but because it is the
 * only confirmation that survives someone clicking through a dialog they have
 * seen forty times. Erasing a simulator throws away every app, every login and
 * every bit of state on it, and there is no undo.
 */
import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface EraseDialogProps {
  open: boolean;
  deviceName: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function EraseDialog({ open, deviceName, onOpenChange, onConfirm }: EraseDialogProps) {
  const [typed, setTyped] = useState("");

  // Re-opening must not inherit the last attempt's confirmation.
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);

  const matches = typed.trim() === deviceName;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Erase {deviceName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Every app, login and setting on this simulator is deleted. It cannot be undone, and the
            device shuts down while it happens.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-2">
          <Label htmlFor="xcsim-erase-confirm">
            Type <span className="font-medium text-foreground">{deviceName}</span> to confirm
          </Label>
          <Input
            id="xcsim-erase-confirm"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={!matches} onClick={onConfirm}>
            Erase it
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
