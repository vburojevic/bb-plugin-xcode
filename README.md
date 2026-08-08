# bb-plugin-xcode

Tracks Xcode builds, tests and every other Xcode process across all your
projects — live, with **no per-project configuration**.

```
bb plugin install ~/Git/bb-plugin-xcode
```

## Why it needs no configuration

DerivedData is not knowable in advance. It may be the shared
`~/Library/Developer/Xcode/DerivedData`, a project-local `.build-sim` nested
inside an SPM subpackage, or anything handed to `-derivedDataPath`. So the
plugin never asks where to look — it **learns roots from the running builds**.

Every compiler invocation embeds its DerivedData root in its own arguments:

```
<ROOT>/Build/Intermediates.noindex/App.build/Debug/App.build/Objects-normal/…
```

Matching `^(.*?)/Build/(Intermediates\.noindex|Products)/` recovers `<ROOT>`
from any build — Xcode.app, `xcodebuild`, `xcodebuildmcp`, CI scripts, anything.
Discovered roots are persisted and watched from then on.

## The capture ladder

Each tier works alone and degrades gracefully.

| Tier | Source | Gives you | Needs |
|---|---|---|---|
| 0 | `ps` + `lsof -d cwd` | what is running now, scheme, action, destination, cwd, duration | nothing |
| 1 | `LogStoreManifest.plist` | completed runs, status, error/warning counts | nothing |
| 2 | `.xcresult` via `xcresulttool` | pass/fail, issues with file:line, per-test results | a result bundle |
| 3 | `-resultStreamPath` | live per-section progress, issues as they occur | `bb xcode run` |

## Getting real pass/fail: `bb xcode shim`

**Xcode writes no Build-domain log entry for command-line builds.** Measured
here: every DerivedData root on the machine had *zero* Build entries — only
`Package` ("Resolve Packages") entries. So Tier 1, which is how Spotify's
XCMetrics collects builds, yields nothing for a `xcodebuild`-driven workflow.
A run's outcome is only recoverable from a `.xcresult`, and only when one was
requested.

Without help the tracker can therefore time a build precisely but must report
its outcome as **Finished** rather than guessing green. To fix that everywhere:

```sh
bb xcode shim install     # then add the printed line to your shell profile
```

The shim is a ~30-line POSIX `sh` script that adds `-resultBundlePath` to
build/test invocations lacking one and `exec`s the real `/usr/bin/xcodebuild`.
Queries (`-version`, `-list`, `-showBuildSettings`) pass through untouched, as
does anything that already sets a bundle path. It has no dependency on bb, node,
or the network, and any unexpected condition falls through to the real tool —
it must never be the reason a build fails. `bb xcode shim uninstall` removes it.

## Usage

```sh
bb xcode status                 # what is running now
bb xcode runs [--failed] [--kind test] [--all] [--limit N]
bb xcode show <run-id>          # issues + failed tests with file:line
bb xcode roots                  # discovered DerivedData roots
bb xcode rescan                 # force discovery + manifest sweep

# Live progress + guaranteed result capture:
bb xcode run -- xcodebuild -scheme App -destination 'platform=macOS' test
```

The **Xcode** nav panel shows the live strip, history and trends. Agents get
`xcode_status` and `xcode_last_failure` tools, so they can ask whether a build
passed instead of grepping build output.

## Things Xcode does that this had to work around

Each of these was confirmed by experiment on Xcode 26.6, not from docs.

- **Two different epochs.** `LogStoreManifest.plist` stores Apple reference-date
  seconds (2001-01-01); `xcresulttool` emits Unix-epoch seconds. Confusing them
  shifts timestamps by ~31 years. A test asserts both converters agree on the
  same build.
- **Test manifests stay empty for CLI runs.** `xcodebuild test` writes *nothing*
  to `Logs/Test/LogStoreManifest.plist`. Per-test results exist only in the
  `.xcresult`, which is why Tier 2 is the sole source for them.
- **A test run's build phase writes a *Build* log entry.** Letting its status
  land on the run would report "succeeded" for a run whose tests failed, so that
  entry contributes counts only.
- **Durations are locale-formatted strings.** `get test-results tests` renders
  `"0,55s"` under a European locale; `parseFloat` silently returns 0.
- **Issue line numbers are 0-based** in the `sourceURL` fragment.
- **`-resultStreamPath` requires `-resultBundlePath`**, and the stream file must
  already exist, or xcodebuild exits 64.
- **`ps` cannot report `lstart` and `args` together** unambiguously — both
  contain spaces. `pid,ppid,etime,args` is the combination that parses.
- **`etime` has whole-second resolution**, so a start time derived from it
  drifts between ticks. Process identity is the pid alone; a composite key
  duplicated runs mid-build.
- **The unified log is a dead end.** `log stream` filtered to Xcode processes
  produced 821 lines during one build, essentially all MobileAsset/XPC noise and
  no build semantics.
- **`XCBBuildService` is a resident daemon**, not a per-build process. Treating
  its existence as a build pinned a permanent phantom entry to the panel from
  the moment Xcode opened. It counts only while it has compiler children.
- **A "Resolve Packages" log overlaps the build it belongs to**, sharing its
  DerivedData root and start time. It won correlation against the real build and
  reported a 5s build as 1.5s, so log domains are now gated against run kinds.
- **Hysteresis must not be billed to the build.** Ending a run at "now" after a
  3-tick grace period reported a 5s build as 10.6s; runs end at the moment they
  were last *seen*.

## Known limits

- **Live process observation is server-host-local.** The plugin SDK has no
  general remote-exec primitive, so Tiers 0 and 3 cover the machine running the
  bb server. Tiers 1–2 are file-based and can read other hosts via
  `bb.sdk.files`.
- **Xcode.app (IDE) builds are not fully validated.** Everything here was
  verified against `xcodebuild`; IDE attribution is designed to flow through
  child compiler args → DerivedData root → project, but was not exercised
  against a live Xcode.app session.
- Builds shorter than the scan interval are missed by the probe, then picked up
  by the manifest sweep — they appear in history but never in the live strip.

## Development

```sh
npm install
npm test          # 64 unit tests over the pure parsing/correlation logic
npm run typecheck
bb plugin dev     # rebuild + reload on save
```

Architecture (v2): **one run, one identity, monotonic enrichment.** A run is
born from a process observation; every other source (log store, result bundle)
may only *enrich* it, carrying a confidence rank (observed < logged < verified)
that can never go backward. The lifecycle is explicit — running → finishing →
passed/warnings/failed/cancelled, or a timeout to the honest terminal `ended`.
`src/model.ts` states the rules, `src/engine.ts` is the single writer that
applies them, `src/collector.ts` owns all I/O, `server.ts` is wiring. The
engine is tested against a real in-memory SQLite (`test/engine.test.ts`).
