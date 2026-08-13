/**
 * The consent form, rendered in place of the composer.
 *
 * This is what `bb sims expose` waits on. An agent can run that command; it
 * cannot answer this. That is the whole enforcement, and the reason the rule
 * "there is no `simulator_expose` tool" is more than a note in a README.
 *
 * The sensitive value — the URL, and the token inside it — never comes near
 * this component. It goes back to whoever ran the command, once.
 */
import { Button } from "@/components/ui/button";

export interface ExposeConsentProps {
  interaction: { title?: string | null; payload: unknown };
  submit: (value: never) => void | Promise<void>;
  cancel: () => void | Promise<void>;
}

export function ExposeConsent({ interaction, submit, cancel }: ExposeConsentProps) {
  const payload = (interaction.payload ?? {}) as { facts?: string[]; confirmLabel?: string };
  const facts = Array.isArray(payload.facts) ? payload.facts : [];

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-sm font-medium">{interaction.title ?? "Expose this simulator?"}</p>
      <ul className="list-inside list-disc space-y-1.5 text-sm text-muted-foreground">
        {facts.map((fact) => (
          <li key={fact} className="text-balance">
            {fact}
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => void cancel()}>
          Cancel
        </Button>
        {/* Reads `Expose for 30 minutes`, never `OK`. */}
        <Button size="sm" onClick={() => void submit(true as never)}>
          {payload.confirmLabel ?? "Expose"}
        </Button>
      </div>
    </div>
  );
}
