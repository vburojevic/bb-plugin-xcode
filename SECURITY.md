# Security model

This plugin runs inside the long-lived bb server and can start Xcode and
simulator processes on the server host. Treat agent tool arguments, the
agent-facing `bb` CLI, Xcode projects, generated preview output, and every
same-user local caller as untrusted input.

The focused security regression suites are:

- `test/build-security.test.ts`
- `test/agent-scope-security.test.ts`
- `test/bounded-file.test.ts`
- `test/stream.test.ts`
- `test/sim/sim-host-security.test.ts`
- `test/sim/sim-host-client-security.test.ts`
- `test/sim/connection-limit.test.ts`
- `test/sim/private-stream-routes.test.ts`
- `test/sim/private-transport-source.test.ts`
- `test/sim/stills.test.ts`

## Tracked build boundary

`bb xcode run` and the `xcode_build` tool execute only
`/usr/bin/xcodebuild`. Their working directory and caller-selected input/output
paths are confined, through real paths and existing symlink ancestors, to the
invoking thread's checkout. Caller-provided result-stream and result-bundle
paths are replaced with plugin-owned temporary paths. Host-mutating Xcode
download, import, and provisioning modes are refused.

Children receive a small environment allowlist rather than the bb server's
provider, plugin, and tunnel credentials. Stream reads, individual streamed
lines, output buffers, and temporary files are bounded. Apple and system
helpers are resolved to fixed system paths rather than through `PATH`, and only
four tracked builds may run concurrently.

This is not an Xcode sandbox. A project build phase, compiler plugin, package
plugin, or test can execute with the bb server user's filesystem, keychain, and
network access. The current plugin SDK has no host execution primitive that
attaches a thread's filesystem or network permission sandbox. Do not use the
tracked runner for an untrusted checkout on a privileged host.

## Simulator capture host

`serve-sim` runs in a disposable child process on an ephemeral `127.0.0.1`
port. Its raw middleware includes shell-execution and token-disclosure routes,
so it is never mounted directly and its port is never declared as a shared bb
port.

The child wrapper:

- 404s everything except the exact device routes the plugin uses and always
  denies `/exec`, `/exec-ws`, and DevTools routes;
- accepts the master capability only in a private request header;
- gives image URLs a separate query token that opens only MJPEG/AVCC streams;
- bounds control bodies, JSON responses, headers, connections, frame sizes,
  and client-side reads;
- scrubs any `execToken` from forwarded JSON as a second line of defence;
- contains synchronous and asynchronous middleware failures inside the child;
- uses private temporary storage and a curated environment;
- exits on parent stdin EOF, SIGTERM, or SIGINT, with a supervisor SIGKILL
  fallback.

`serve-sim` is pinned exactly to `0.1.45`. Updating it requires re-running the
route-policy and response-scrubbing tests against the new middleware.

## Private simulator transport

The plugin has no standalone public simulator viewer, public capability URL,
public WebSocket listener, `bb connect` port declaration, exposure RPC,
exposure CLI verb, or exposure setting. Remote viewing is available only inside
the main bb UI through same-origin plugin HTTP and typed RPC routes. Official
remote bb access remains owner-session-gated by bb; the plugin routes themselves
reuse bb's server and do not open another listener or publish the capture host's
loopback port.

On the server host, a local HTTP bb panel may use the capture host directly via
its stream-only per-boot token. An HTTPS or remote bb panel cannot reach that
machine's loopback and automatically uses the same-origin `/stream` proxy. The
proxy validates the active UDID and carries backpressure
to the child. At most four proxy streams and four zero-byte presence responses
may be open at once; excess requests receive `503`. Disconnect, cancellation,
upstream error, device change, and failed-open paths all release their slot.

No plugin code calls `declareSharedPorts` or `ensureSharedPortTunnel`. Operators
must not manually tunnel the capture port: loopback limits network reachability
but is not a defence against another process running as the same OS user.

## Human and agent surfaces

Simulator model tools and every CLI surface that can reveal or control live or
stored simulator content are disabled by default and require the
`allowAgentCapture` setting. Tools re-check it on every invocation, so turning
it off revokes an already-registered tool immediately. Erase, shutdown, purge,
and Stills test-target execution are enforced server-side through host-owned
confirmations; a raw RPC caller cannot bypass the frontend dialog.

Agent-facing simulator CLI actions that cross a checkout or host-state boundary
also require host confirmation: writing a capture, running a Stills test target,
applying onboarding files, and changing a baseline. The confirmation names the
resolved checkout or destination before the action proceeds.

Agent status and failure tools are always confined to the invoking thread's
checkout and expose no machine-wide override. Agent-facing CLI history, detail,
wait, stop, and DerivedData-root commands apply the same scope and fail closed
when it cannot be resolved. The caller's thread and project hints must agree
with the invoking working directory; missing or inconsistent CLI context does
not widen access. Explicit simulator look, baseline, history, diff, and card ids
are checked against that same resolved scope. Machine-wide history and rescans
are panel-only. Shim mutation, CLI-started host builds, and stopping host builds
require a host-owned confirmation rendered in the invoking thread.

Plugin RPC and HTTP routes use bb's `auth: "local"` Origin/CSRF boundary. It
accepts originless requests and is not a caller-credential check. The SDK does
not expose caller identity or a trusted browser Origin to plugin handlers, so a
same-user process with loopback access is part of the core trusted boundary and
can call non-destructive simulator RPC and stream routes. Distinguishing that
process from the signed-in panel requires a core bb
capability, not a plugin-side header the same caller could invent. Stills
execution and destructive erase or purge still cross a host-owned confirmation
boundary.

## Files and generated output

`bb sims shot --out` requires a thread checkout, rejects absolute and escaping
paths before capture, supplies the checkout as the daemon-enforced write root,
and uses atomic create-only writes with mode `0600`.

Stills imports only non-symlink regular files, with limits on manifest bytes and
entries, image count, individual PNG and sidecar size, declared dimensions,
pixel count, and total bytes. Files are opened with `O_NOFOLLOW` and read to
their checked size. The actual cumulative bytes are rechecked after opening to
close grow-after-stat races. Disk pruning and budget enforcement run before
imported bytes are persisted.

Automatic Xcode log-manifest reads, Git pointers, project manifests, stored
frames, and model-bound images use bounded regular-file reads. A file that is
too large, changes while open, or is a disallowed symlink is refused before it
can become an unbounded server-heap allocation. The model image budget is a
hard base64-size ceiling, including for the first image. Stills result bundles
and exports live only in the private per-run scratch directory and are removed
in `finally`; maintenance removes the unbounded legacy result caches.

Published packages exclude local simulator screenshots, browser probe scripts,
test fixtures, CI metadata, and local design-audit caches. Runtime source,
plugin metadata, and the vendored SDK declarations remain in the package.

## Audit record

The 2026-08-20 audit remediated arbitrary host executable invocation, arbitrary
host-file overwrite, cross-thread Xcode history and control, caller-selected
scope confusion, stale agent-capture permission, unbounded result-stream and
JSON buffers, malformed MJPEG allocation, unbounded Stills import, unbounded
manifest and image reads, child orphaning, server-environment inheritance,
predictable temporary paths, shell quoting, `PATH` executable substitution,
middleware exception escape, and unintended package contents.

The original public simulator exposure design additionally had capability
delivery, device-retargeting, restart-race, HID-smuggling, socket-flood,
backpressure, and lifecycle hazards. Rather than maintaining a second remote
authentication and transport surface, the feature and all of its public
listeners, URLs, RPCs, CLI verbs, and UI controls were removed. Remote simulator
viewing now stays inside bb's main UI, with bounded proxy and
presence concurrency.
