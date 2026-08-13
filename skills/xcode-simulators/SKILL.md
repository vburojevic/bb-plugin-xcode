---
name: xcode-simulators
description: Look at, touch and diff an iOS simulator. Use when you have changed SwiftUI and want to show the result rather than describe it, when you need to demonstrate a flow on a real device, or when you want to know whether a change moved any other preview. Also covers `bb sims` commands.
---

# Xcode Simulators

You can see the simulator. Use that.

## Show, do not describe

When you have changed SwiftUI and want to report the result, call
`simulator_capture` or `simulator_drive`. Never claim a screen "looks correct"
without a frame — the build verdict proves the code compiles and the test
verdict proves your assertions still hold, and neither has looked at a pixel.

`simulator_capture` takes one frame and names the app that was on screen.
`simulator_drive` runs up to 24 gestures and ends in one frame, which is what a
person does when they demonstrate something: a five-tap flow as five separate
calls is five turns of latency and five screenshots to reconcile.

Prefer naming an element over guessing coordinates:

```json
{ "steps": [{ "kind": "tap", "at": { "element": { "label": "Sign in" } } }] }
```

`tap "Sign in"` survives a layout change. `tap 0.5,0.87` breaks on the next
padding tweak. Coordinates are fractions of the screen from 0 to 1 — pixels are
rejected, because they would land silently in the top-left corner.

## The simulator is shared

Captures and drives take a short lease. If a call reports that another thread is
driving the device, **wait rather than retrying** — three agent threads tapping
one simulator interleave gestures, and each gets back a frame of a screen
another agent navigated to, which is worse than having no eyes at all.

## Preview renders report themselves

`simulator_stills` renders every SwiftUI preview and reports what moved. It
blocks, and it is bounded.

Do **not** paste a list of changed previews into chat. The run reports itself in
the Simulators panel and in the prompt stack above the composer; the user is
already looking at it. Say what you changed and why, and let the panel show the
pixels.

On a project with no snapshot target, `simulator_stills` returns an error whose
message is the onboarding text. Offer to run `bb sims onboard` — which prints
the exact changes and writes nothing — rather than inventing a reason.

## Never expose the simulator

Do not run `bb connect expose` on any port this plugin uses, and do not ask the
user to expose the simulator remotely. That control is theirs and it lives in
the panel. `bb sims expose` exists, and it will stop and ask a human in the
composer before doing anything — do not try to route around that.

## The commands

```
bb sims doctor              every prerequisite, its state, and the fix
bb sims devices             simulators, marking booted and which is live
bb sims live [<device>]     start watching one
bb sims shot [--label <s>]  capture one frame
bb sims drive "<script>"    tap 0.5,0.9; type hello; swipe up; rotate landscape-left
bb sims stills              render every preview and diff it
bb sims look [<lookId>]     one run's verdict
bb sims history <identity>  one preview's frames over time, with commits
bb sims baseline            show, set or clear what runs compare against
bb sims onboard [--apply]   what Stills needs from this repo
bb sims card <lookId>       the directive for a run — never hand-write one
bb sims purge [--dry-run]   report, then remove, every stored frame
```

`bb sims doctor` is the first thing to run when something does not work. Every
line it prints has the fix in it.

## Things that will surprise you

**A green preview run with zero previews means the test target is not hosted.**
An unhosted logic test never loads the app binary, so the preview scan finds
nothing and the run passes. The verdict says so rather than claiming agreement.

**`missing` and `removed` are opposite facts.** `missing` means a preview was in
the manifest and produced no PNG — it crashed, or the runner died before
reaching it. `removed` means someone deleted it. Never treat one as the other.

**Home relaunches SpringBoard.** Xcode 26+ silently drops the Indigo HID home
button, so serve-sim relaunches SpringBoard instead. It is not instant and not
animated the way a real home press is.

**Preview renders have a pinned clock.** `gettimeofday` is hooked to
2024-08-13 07:00 UTC, but `time()`, `mach_absolute_time()` and some `Date()`
paths are not — so a view mixing both produces inconsistent timestamps between
runs. That is a flaky preview, not a regression, and the panel labels it.

**Async content is never awaited.** `.task`, `.onAppear` and URLSession results
are simply not present in a preview render. A preview that fetches will render
its loading state, nondeterministically.
