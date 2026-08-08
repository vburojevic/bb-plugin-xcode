# Xcode activity tracker — product context

## What it is

A bb plugin that answers one question at a glance: **what is Xcode doing, and did
the last thing I ran pass?** It watches every project on the machine with no
per-project setup, capturing builds from Xcode.app, `xcodebuild`, CI scripts and
wrapper tools alike.

## Register

**Product.** Design serves the task. This is a monitoring panel a developer
glances at mid-flow, often for under two seconds, while their real attention is
in an editor or a terminal. The tool should disappear into the task.

## Who uses it, where

One developer, on their own Mac, with a build running in another window. They
alt-tab in to check "is it done / did it break", and alt-tab out. Frequently
they are looking at it *while* the build runs, so the surface must be stable
under change — a layout that reflows or flickers as builds start and stop is
worse than no live view at all.

They also read it remotely through bb's web client on a second machine.

## The two failure modes that matter

1. **State churn.** A build that appears, disappears and reappears is worse than
   useless: it destroys trust in everything else on the panel. Live state must be
   hysteretic and monotonic — a run that starts stays visible until it resolves.
2. **Lying about outcomes.** Reporting "succeeded" for a run whose tests failed
   is the one unrecoverable error. When the outcome is not yet known, say
   "finishing" — never guess green.

## Design constraints

- Inherits the host bb theme; all color comes from bb's live CSS variables. The
  panel must look correct in any user palette, light or dark.
- Restrained color. The accent carries running state and selection only.
- Density is a virtue here — this is a log, not a landing page.
- No modals for detail: the user is comparing runs, so detail belongs beside the
  list, not on top of it.
- Motion conveys state only (something is running, something changed). Never
  decoration; the panel is often open for hours.

## Non-goals

- Not a CI dashboard: no multi-machine fleet view, no team aggregation.
- Not a build-performance profiler: per-file compile timings are out of scope.
- Not a replacement for Xcode's own issue navigator.
