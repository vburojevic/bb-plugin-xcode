# Private Simulator Transport Design

## Goal

Keep live simulator viewing and control available from local and remote bb panels while making it impossible for this plugin to create a simulator-specific internet endpoint.

## Security invariant

- The capture helper binds only to `127.0.0.1` on an ephemeral port.
- The plugin never calls `bb.hosts.ensureSharedPortTunnel` or `bb.hosts.declareSharedPorts`.
- The plugin never constructs, returns, logs, or displays a simulator share URL.
- Remote video travels through the plugin's same-origin `/stream` route with `auth: "local"`.
- Remote input travels through the plugin's schema-validated bb RPC methods.
- The plugin exposes no UI, RPC, CLI, setting, or agent-tool operation that can create or revoke a shared simulator port.

This removes the separate viewer origin and its public Connect hostname. It does not change bb's own authenticated remote-access transport.

## Architecture

`serve-sim` remains isolated in the disposable `sim-host.mjs` child. Both `sim-host.mjs` and its `sim-host-stream.mjs` sibling ship raw and unbundled; bundled server code has no runtime import path to `serve-sim/middleware`. The child continues to bind an ephemeral loopback TCP port because the server process needs streaming HTTP and WebSocket access to the native middleware. Its filtered route allowlist, split stream/control credentials, response limits, curated environment, parent-liveness pipe, and forced teardown remain unchanged.

The bb frontend already receives a same-origin `streamUrl` from `liveState`. A local HTTP panel may prefer the stream-scoped loopback URL for performance; a remote HTTPS panel rejects that candidate before opening it and uses `/api/v1/plugins/<id>/http/stream`. Touch, keyboard, device, and capture actions continue through typed plugin RPC. No simulator port is declared to bb Connect.

The child has one four-response gate for every external pixel request, whether direct or proxied and whether MJPEG or AVCC. The plugin proxy retains its independent four-connection gate. Acquisition happens only after request and device validation. Every exit path releases exactly once: request abort, response cancellation, upstream error/close, rejected upstream response, and failed upstream open. A fifth concurrent pixel response receives HTTP 503 without starting or retaining native work.

The DOM sees `HMAC-SHA256(perBootStreamKey, activeUdid)`, never the host-wide key. That capability is valid for both stream extensions of exactly one device and cannot reach configuration, accessibility, HID, control, or stream-status routes. The master secret remains header-only.

Authenticated external AVCC requests terminate in a child-owned fanout. Its first viewer opens one same-process loopback request through a random internal header accepted only on the exact allowlisted AVCC path; the key is absent from the environment, handshake, logs, and DOM. Every healthy viewer receives the same immutable v2 record Buffer, sequence, and PTS. A blocked response is skipped without blocking capture and waits for decoder sync.

Published `serve-sim` has no force-keyframe API, so a new viewer, drained slow viewer, invalid key tag, or configuration change coalesces an encoder restart. The old upstream closes before its replacement opens; the replacement creates a new native encoder and forced IDR. The fanout emits discontinuity, description, and a NAL-verified IDR under the new configuration generation before deltas resume. The last viewer destroys the upstream immediately. A master-header-only `/helper/<UDID>/stream-status` route reports viewer and encoder counts, generation, restart/drop counters, and last-packet age; only explicit capture and stream-status tool calls query it.

## Removed surface

The following are deleted rather than hidden behind a setting:

- the standalone viewer HTTP/WebSocket server;
- Connect discovery, tunnel identity, public URL construction, and shared-port declaration;
- exposure guard, TTL, path capability, and one-use link delivery;
- Expose/Unexpose RPC and CLI operations;
- Expose controls and consent renderer;
- exposure banner rows, demo fixtures, settings, copy, and documentation.

Keeping dormant exposure code would preserve the attack surface and make the invariant configuration-dependent. Deletion makes the guarantee structural.

## Limits and trust boundary

Plugin HTTP `auth: "local"` is bb's frontend Origin/CSRF boundary, not a caller-credential check, and it accepts originless requests. The current SDK does not provide a caller principal to plugin RPC or HTTP handlers, so the plugin cannot distinguish a signed-in panel from an originless same-user process with loopback access. That is a bb-core boundary and remains documented; the plugin must not invent a spoofable header and call it authentication.

## Verification

- Unit tests prove the connection gate refuses N+1 and releases idempotently.
- Plugin registration tests prove exposure RPC and CLI methods no longer exist and all HTTP routes remain `auth: "local"`.
- Stream-source tests prove remote HTTPS viewers receive only proxied candidates.
- Linux fake-upstream tests prove four AVCC viewers share one producer, isolate
  backpressure, coalesce recovery, verify IDR ordering, and tear down on the
  last close without importing the native dependency.
- Security tests prove deny-before-allow-before-auth ordering, device-bound
  capabilities, the exact internal AVCC branch, the global pixel cap, and the
  master-only status route.
- Source scans prove no production use of shared-port APIs and no wildcard/LAN listener.
- The full test suite, TypeScript build, plugin build, package audit, package-content audit, and security scans run before completion.
