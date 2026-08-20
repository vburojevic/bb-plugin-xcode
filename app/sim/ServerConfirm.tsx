/** Host-owned confirmation for irreversible or disruptive server actions. */
import { Button } from "@/components/ui/button";

export interface ServerConfirmProps {
  interaction: { title?: string | null; payload: unknown };
  submit: (value: never) => void | Promise<void>;
  cancel: () => void | Promise<void>;
}

export function ServerConfirm({ interaction, submit, cancel }: ServerConfirmProps) {
  const payload = (interaction.payload ?? {}) as { facts?: string[]; confirmLabel?: string };
  const facts = Array.isArray(payload.facts) ? payload.facts : [];
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">{interaction.title ?? "Confirm this action?"}</p>
      <ul className="list-inside list-disc space-y-1.5 text-sm text-muted-foreground">
        {facts.map((fact) => (
          <li key={fact} className="text-balance">{fact}</li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void cancel()}>Cancel</Button>
        <Button variant="destructive" size="sm" onClick={() => void submit(true as never)}>
          {payload.confirmLabel ?? "Confirm"}
        </Button>
      </div>
    </div>
  );
}
