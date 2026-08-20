# Private Simulator Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every simulator-specific public exposure path while preserving remote simulator use inside the main bb panel and bounding the remaining long-lived HTTP connections.

**Architecture:** Delete the standalone viewer and bb Connect shared-port integration. Keep the filtered capture child on loopback, send remote video through the existing same-origin plugin proxy, and use a small reusable permit gate for `/stream` and `/presence`.

**Tech Stack:** TypeScript, React, Node HTTP streams, bb Plugin SDK, Zod 4, Vitest.

## Global Constraints

- No production call to `ensureSharedPortTunnel` or `declareSharedPorts`.
- No simulator exposure URL, RPC, CLI command, setting, or frontend control remains.
- Every plugin HTTP route uses `auth: "local"`.
- `sim-host.mjs` continues to bind exactly `127.0.0.1`.
- `/stream` and `/presence` allow at most four concurrent connections each.
- Preserve all unrelated security-audit changes already present in the dirty worktree.
- Leave changes uncommitted; the user did not request a commit or push.

---

### Task 1: Make private-only registration the executable contract

**Files:**
- Modify: `test/sim/server.test.ts`
- Modify: `test/sim/banner.test.ts`
- Modify: `test/sim/format.test.ts`
- Modify: `test/sim/prune.test.ts`
- Modify: `test/sim/fake-plugin-host.ts`

**Interfaces:**
- Consumes: `rpcContract`, `CLI_COMMANDS`, `SETTINGS_DESCRIPTORS`, and fake-host registration snapshots.
- Produces: failing tests requiring no exposure methods, verbs, settings, banners, or shared-port SDK use.

- [x] **Step 1: Write the failing registration tests**

```ts
expect(harness.registrations.rpcMethods).not.toEqual(
  expect.arrayContaining(["exposeState", "exposeStart", "exposeClaim", "exposeStop"]),
);
expect(SIM_VERBS.map((command) => command.name)).not.toEqual(
  expect.arrayContaining(["expose", "unexpose"]),
);
expect(SETTINGS_DESCRIPTORS).not.toHaveProperty("exposeTtlMinutes");
expect(harness.sdkCalls).not.toEqual(
  expect.arrayContaining(["hosts.ensureSharedPortTunnel", "hosts.declareSharedPorts"]),
);
```

- [x] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run test/sim/server.test.ts test/sim/banner.test.ts test/sim/format.test.ts test/sim/prune.test.ts`

Expected: failures naming the still-registered exposure RPCs, CLI verbs, setting, and banner/demo states.

- [x] **Step 3: Keep the failing assertions unchanged for Task 2**

The failures are the acceptance contract; production edits begin only after they fail for the intended exposure surface.

### Task 2: Delete the standalone exposure feature

**Files:**
- Delete: `src/sim/connect.ts`
- Delete: `src/sim/viewer.ts`
- Delete: `src/sim/guard.ts`
- Delete: `src/sim/exposure-delivery.ts`
- Delete: `app/sim/ExposeControl.tsx`
- Delete: `app/sim/ExposeConsent.tsx`
- Delete: `app/sim/exposure-delivery.ts`
- Delete: `test/sim/exposure-delivery.test.ts`
- Modify: `src/sim/wire.ts`
- Modify: `src/sim/rpc.ts`
- Modify: `src/sim/contract.ts`
- Modify: `src/sim/context.ts`
- Modify: `src/sim/cli.ts`
- Modify: `src/sim/settings.ts`
- Modify: `src/sim/banner.ts`
- Modify: `src/sim/demos.ts`
- Modify: `app.tsx`
- Modify: `app/sim/DeviceBar.tsx`
- Modify: `app/sim/ActivityBanner.tsx`

**Interfaces:**
- Consumes: the failing private-only assertions from Task 1.
- Produces: an RPC contract, CLI surface, UI, and runtime with no exposure concept or shared-port call.

- [x] **Step 1: Remove exposure from the public contracts**

Delete `Ctx.exposure`, the four `expose*` RPC schemas and handlers, the `expose`/`unexpose` CLI entries and dispatch branches, `exposeTtlMinutes`, and exposure banner inputs. The banner contract becomes:

```ts
export type BannerTone = "neutral" | "dead";
export interface BannerRow {
  id: string;
  kind: "failure" | "run";
  sentence: string;
  tone: BannerTone;
  dismissible: boolean;
  lookId: string | null;
  watermark: string | null;
}
```

- [x] **Step 2: Remove the runtime and frontend entry points**

Delete the exposure block in `installSimulators`, its imports, disposal hooks, Connect peer calls, viewer lifecycle, and `publish("exposure")`. Remove `ExposeControl` from `SimulatorsHeader` and the `expose-consent` pending interaction registration.

- [x] **Step 3: Delete exposure-only modules and tests**

Remove the eight exposure-only files listed above. Keep `ws` because `src/sim/hid.ts` still uses it for the loopback HID connection.

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npx vitest run test/sim/server.test.ts test/sim/banner.test.ts test/sim/format.test.ts test/sim/prune.test.ts`

Expected: all focused tests pass with no unknown imports or stale exposure assertions.

### Task 3: Bound same-origin stream and presence connections

**Files:**
- Create: `src/sim/connection-limit.ts`
- Create: `src/sim/private-stream-routes.ts`
- Create: `test/sim/connection-limit.test.ts`
- Create: `test/sim/private-stream-routes.test.ts`
- Modify: `src/sim/wire.ts`

**Interfaces:**
- Consumes: route abort/cancel/close signals already present in `wire.ts`.
- Produces: `ConnectionLimit` with `tryAcquire(): (() => void) | null`, plus `MAX_PANEL_STREAMS = 4` and `MAX_PANEL_PRESENCES = 4`.

- [x] **Step 1: Write the failing permit tests**

```ts
it("refuses the connection after its capacity is exhausted", () => {
  const limit = new ConnectionLimit(2);
  expect(limit.tryAcquire()).not.toBeNull();
  expect(limit.tryAcquire()).not.toBeNull();
  expect(limit.tryAcquire()).toBeNull();
});

it("releases a permit exactly once", () => {
  const limit = new ConnectionLimit(1);
  const release = limit.tryAcquire();
  expect(release).not.toBeNull();
  release?.();
  release?.();
  expect(limit.tryAcquire()).not.toBeNull();
});
```

- [x] **Step 2: Run the unit test and verify RED**

Run: `npx vitest run test/sim/connection-limit.test.ts`

Expected: module resolution fails because `connection-limit.ts` does not exist.

- [x] **Step 3: Implement the minimal permit gate**

```ts
export class ConnectionLimit {
  private active = 0;

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error("maximum must be a positive integer");
  }

  tryAcquire(): (() => void) | null {
    if (this.active >= this.maximum) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}
```

- [x] **Step 4: Gate both routes and preserve teardown accounting**

Create one limiter per route during plugin installation. Acquire after device validation. Return `context.text("Too many simulator viewers.", 503)` on refusal. Fold the permit release into each route's existing idempotent `release()` so open failures, aborts, stream cancellation, upstream errors, and normal closes all free capacity.

- [x] **Step 5: Run the unit and server tests and verify GREEN**

Run: `npx vitest run test/sim/connection-limit.test.ts test/sim/server.test.ts`

Expected: both files pass.

### Task 4: Update the security record and verify the package

**Files:**
- Modify: `SECURITY.md`
- Modify: `README.md`
- Modify: comments in `sim-host.mjs`, `src/sim/rpc.ts`, `src/sim/tools.ts`, `app/sim/stream-core.ts`, and `app/sim/stream-sources.ts`

**Interfaces:**
- Consumes: the private-only runtime from Tasks 2-3.
- Produces: documentation and package output that make the no-public-endpoint guarantee auditable.

- [x] **Step 1: Replace public-exposure documentation with the private transport invariant**

Document that remote panels use the main bb origin, the helper remains loopback-only, the two long-lived routes are capped, and same-user originless callers remain a bb-core trust boundary.

- [x] **Step 2: Run stale-surface scans**

Run:

```sh
rg -n "ensureSharedPortTunnel|declareSharedPorts|publicUrl|exposeStart|exposeClaim|ExposeControl|startViewer" --glob '!docs/superpowers/**' .
rg -n "listen\\([^\\n]*(0\\.0\\.0\\.0|::)" --glob '!node_modules/**' .
```

Expected: both commands return no production matches; test/docs matches must be intentional assertions only.

- [x] **Step 3: Run complete verification**

Run:

```sh
npm run check
bb plugin build .
npm audit --omit=dev
npm pack --dry-run --json
```

Expected: typecheck and all tests pass, the plugin build exits 0, production audit reports zero vulnerabilities, and package contents contain no test fixtures, simulator captures, or local audit artifacts.

- [x] **Step 4: Re-run independent security and networking review**

The reviewers must inspect the final diff, listener bindings, route release paths, and package contents. Any finding returns to a new RED/GREEN cycle before completion is claimed.
