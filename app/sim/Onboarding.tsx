/**
 * The un-onboarded state, which is a first-class state rather than an absence.
 *
 * It renders the detector's finding **by name** — the project it found, the
 * scheme, the targets, which one is not hosted — followed by the two buttons.
 * "This project has no snapshot target" is a dead end; naming what was found is
 * a next step.
 *
 * `--dry-run` is the default everywhere: the full diff is on screen before
 * anything is written.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { OnboardPlan } from "./useStills";

export interface OnboardingProps {
  plan: OnboardPlan | null;
  onApply: () => void;
  onChoose: (relPath: string) => void;
  busy: boolean;
}

export function Onboarding({ plan, onApply, onChoose, busy }: OnboardingProps) {
  const [applied, setApplied] = useState<string[] | null>(null);

  if (plan === null) return <div className="bbxs-skeleton m-4 h-40" aria-hidden />;

  if (plan.checkoutElsewhere !== null) {
    return (
      <div className="p-4">
        <Alert>
          <AlertTitle>This checkout is on another machine</AlertTitle>
          <AlertDescription>{plan.checkoutElsewhere} Live is unaffected — it needs no checkout.</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (plan.candidates.length === 0) {
    return (
      <div className="bbxs-scroll h-full space-y-3 p-4">
        <p className="text-sm">
          No Xcode project under{" "}
          <code className="text-xs">{plan.searched ?? "this checkout"}</code>.
        </p>
        <p className="text-sm text-muted-foreground text-balance">
          Xcode Simulators looks two levels deep, so a project at{" "}
          <code className="text-xs">ios/App.xcworkspace</code> or{" "}
          <code className="text-xs">apps/ios-client/…</code> is found. If yours lives deeper, set the
          project path in this plugin&rsquo;s settings.
        </p>
      </div>
    );
  }

  return (
    <div className="bbxs-scroll h-full space-y-4 p-4">
      {plan.candidates.length > 1 ? (
        <section className="space-y-2">
          {/* Every candidate, never one picked silently: a monorepo legitimately
              has several, and rendering the wrong one and calling it your app is
              worse than asking. */}
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {plan.candidates.length} Xcode projects under this checkout
          </h3>
          <ul className="space-y-1">
            {plan.candidates.map((candidate) => (
              <li key={candidate.relPath} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate text-xs">{candidate.relPath}</code>
                <Button
                  size="sm"
                  variant={plan.detected?.relPath === candidate.relPath ? "secondary" : "outline"}
                  onClick={() => onChoose(candidate.relPath)}
                >
                  {plan.detected?.relPath === candidate.relPath ? "In use" : "Use this"}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {plan.detected !== null ? (
        <p className="text-sm text-balance">{plan.detected.summary}</p>
      ) : null}

      {plan.conflict !== null ? (
        <Alert variant="destructive">
          <AlertTitle>Versions disagree</AlertTitle>
          {/* SwiftPM's resolution failure is an error nobody would connect to
              this plugin, so nothing is edited. */}
          <AlertDescription>{plan.conflict}</AlertDescription>
        </Alert>
      ) : null}

      {plan.alreadyDone.length > 0 ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {plan.alreadyDone.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {plan.files.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Files it would write
          </h3>
          {plan.files.map((file) => (
            <Collapsible key={file.relPath}>
              <CollapsibleTrigger asChild>
                <Button variant="link" size="sm" className="h-auto p-0 font-mono text-xs">
                  {file.relPath}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="bbxs-scroll mt-1 max-h-64 rounded-md border bg-muted p-2 text-[11px] leading-relaxed">
                  {file.contents}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </section>
      ) : null}

      {plan.manualSteps.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Then, in Xcode
          </h3>
          {/* Every string here is substituted from the detector. A literal
              TEST_HOST is how every stranger whose target is not called "App"
              pastes a broken setting and gets a green run with zero previews. */}
          <ol className="list-inside list-decimal space-y-2 text-sm">
            {plan.manualSteps.map((step) => (
              <li key={step} className="text-balance">
                <span className="whitespace-pre-wrap">{step}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {applied !== null ? (
        <Alert>
          <AlertTitle>
            {applied.length === 0 ? "Nothing was written" : `Wrote ${applied.length} file(s)`}
          </AlertTitle>
          <AlertDescription>
            {applied.length === 0
              ? "Every file it would write is already there."
              : applied.join(", ")}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex gap-2 border-t pt-3">
        <Button
          disabled={busy || plan.conflict !== null || plan.files.length === 0}
          onClick={() => {
            void Promise.resolve(onApply()).then(() => setApplied([]));
          }}
        >
          Write the files it can
        </Button>
      </div>
    </div>
  );
}
