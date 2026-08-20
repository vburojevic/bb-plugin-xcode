/**
 * The RPC contract.
 *
 * Two rules, both load-bearing:
 *
 * 1. **Flat names only.** RPC method names must match `/^[a-zA-Z0-9_-]+$/`.
 *    A dotted name throws at registration, the factory throws, the plugin
 *    lands in `error`, and nothing loads. There is a test asserting every name
 *    in this file matches.
 * 2. **Outputs are nullable, never optional.** RPC results must be strict JSON
 *    values and `undefined` is rejected rather than coerced, so an absent field
 *    is `null` on the wire. Inputs may be optional; outputs may not.
 */
import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";
import { stepSchema } from "./steps.js";

export const probeSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    state: z.enum(["ok", "warn", "blocked", "unknown"]),
    detail: z.string(),
    value: z.string().nullable(),
  })
  .strict();

export const doctorSchema = z
  .object({
    probes: z.array(probeSchema),
    overall: z.enum(["ok", "warn", "blocked", "unknown"]),
    /** Bytes across every project, so the panel can say "using 1.4 GB across 6 projects". */
    diskBytes: z.number(),
    scopeCount: z.number(),
    /** Present when this thread's checkout is on another machine. */
    checkoutElsewhere: z.string().nullable(),
    checkedAt: z.number(),
  })
  .strict();

export const deviceSchema = z
  .object({
    udid: z.string(),
    name: z.string(),
    state: z.string(),
    osVersion: z.string(),
    platform: z.string(),
    isAvailable: z.boolean(),
  })
  .strict();

export const liveDeviceSchema = z
  .object({ udid: z.string(), name: z.string(), osVersion: z.string() })
  .strict();

export const devicesSchema = z
  .object({
    devices: z.array(deviceSchema),
    bootedUdids: z.array(z.string()),
    suggested: liveDeviceSchema.nullable(),
    hasDrivableRuntime: z.boolean(),
    installedPlatforms: z.array(z.string()),
    /** A failed `simctl list` is never "no devices exist". */
    error: z.string().nullable(),
  })
  .strict();

export const screenSchema = z
  .object({ width: z.number(), height: z.number(), orientation: z.string() })
  .strict();

export const liveStateSchema = z
  .object({
    kind: z.enum([
      "unsupported",
      "intel-blocked",
      "intel-failed",
      "no-runtimes",
      "simctl-failed",
      "idle",
      "booting",
      "boot-failed",
      "waiting-frame",
      "streaming",
      "stalled",
      "host-restarted",
      "erasing",
      "dead",
    ]),
    device: liveDeviceSchema.nullable(),
    screen: screenSchema.nullable(),
    foregroundBundleId: z.string().nullable(),
    reason: z.string().nullable(),
    crashes: z.number(),
    slowBoot: z.boolean(),
    /**
     * Where to point the `<img>`, or `null` when there is nothing to stream.
     * The plugin's own route rather than the capture host's loopback port: it
     * keeps the per-boot secret out of the DOM, and it is same-origin, so the
     * panel works identically whether bb is reached locally or over connect.
     */
    streamUrl: z.string().nullable(),
    /** Loopback, token-scoped, and only right for a viewer on this machine. */
    directStreamUrl: z.string().nullable(),
    /** Bumped whenever the stream must be re-opened, e.g. after a host restart. */
    generation: z.number(),
    showDeviceChrome: z.boolean(),
  })
  .strict();

/**
 * A frame, as the panel needs it.
 *
 * `url` and `thumbUrl` are the plugin's own image route rather than paths: RPC
 * results must be strict JSON and PNG bytes cannot ride that channel, and an
 * absolute path is exactly the field that breaks when a database is read on
 * another machine.
 */
export const frameSchema = z
  .object({
    id: z.string(),
    lookId: z.string(),
    identity: z.string(),
    source: z.enum(["preview", "capture"]),
    displayName: z.string(),
    groupName: z.string(),
    width: z.number(),
    height: z.number(),
    bytes: z.number(),
    foregroundBundleId: z.string().nullable(),
    capturedAt: z.number(),
    url: z.string(),
    thumbUrl: z.string().nullable(),
  })
  .strict();

export const verdictStatusSchema = z.enum([
  "unchanged",
  "changed",
  "layout-changed",
  "added",
  "removed",
  "missing",
  "errored",
]);

export const verdictRowSchema = z
  .object({
    identity: z.string(),
    displayName: z.string(),
    groupName: z.string(),
    status: verdictStatusSchema,
    diffRatio: z.number().nullable(),
    flaky: z.boolean(),
    flakyDetail: z.string().nullable(),
    frame: frameSchema.nullable(),
    /** The diff mask, painted over the head frame at 40%. */
    maskUrl: z.string().nullable(),
    /** The base frame, shown on press-and-hold and side by side for layout. */
    baseUrl: z.string().nullable(),
    baseWidth: z.number().nullable(),
    baseHeight: z.number().nullable(),
  })
  .strict();

export const lookSummarySchema = z
  .object({
    lookId: z.string().nullable(),
    status: z.enum(["running", "ok", "failed", "cancelled", "none"]),
    sentence: z.string(),
    rekey: z.object({ changed: z.number(), total: z.number(), realCount: z.number(), sentence: z.string(), primaryLabel: z.string() }).nullable(),
    truncation: z.object({ stoppedAfter: z.string(), neverReached: z.number(), sentence: z.string() }).nullable(),
    rows: z.array(verdictRowSchema),
    counts: z.record(verdictStatusSchema, z.number()),
    missingOverflow: z.number(),
    undiffed: z.boolean(),
    isBaseline: z.boolean(),
    /** Everything the Facts section shows, already worded. */
    facts: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
    /** Determinate only when the manifest gave a denominator. */
    progress: z.object({ done: z.number(), total: z.number().nullable() }).nullable(),
    startedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
  })
  .strict();

export const onboardPlanSchema = z
  .object({
    /** Every candidate, not one: a monorepo legitimately has several. */
    candidates: z.array(z.object({ shape: z.string(), relPath: z.string() }).strict()),
    detected: z
      .object({
        shape: z.string(),
        relPath: z.string(),
        schemes: z.array(z.string()),
        targets: z.array(z.string()),
        scheme: z.string().nullable(),
        appTarget: z.string().nullable(),
        snapshotTestTarget: z.string().nullable(),
        summary: z.string(),
      })
      .strict()
      .nullable(),
    files: z.array(z.object({ relPath: z.string(), contents: z.string() }).strict()),
    manualSteps: z.array(z.string()),
    conflict: z.string().nullable(),
    alreadyDone: z.array(z.string()),
    /** Set when this thread's checkout is on another machine. */
    checkoutElsewhere: z.string().nullable(),
    /**
     * The directory that was searched.
     *
     * "No Xcode project under this checkout" is only actionable if you can see
     * which checkout it means — and on a machine with several projects, the
     * answer is often "not the one you were standing in".
     */
    searched: z.string().nullable(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  doctor: {
    input: z.object({ refresh: z.boolean().optional() }).strict(),
    output: doctorSchema,
  },
  devices: {
    input: z.null(),
    output: devicesSchema,
  },
  /**
   * Which simulator this thread means, and why.
   *
   * `because` is not decoration: the thread panel picks a device without
   * asking, and a guess whose reason is on screen is a dropdown away from
   * right, where a silent one reads as a broken panel.
   */
  simPick: {
    input: z.object({ threadId: z.string().nullable() }).strict(),
    output: z
      .object({
        device: liveDeviceSchema.nullable(),
        booted: z.boolean(),
        reason: z.string().nullable(),
        because: z.string().nullable(),
        /** Every drivable simulator, so the panel can offer a different one. */
        alternatives: z.array(liveDeviceSchema),
      })
      .strict(),
  },
  liveState: {
    /** `reportStall` is the panel's watchdog telling the server its stream died. */
    /** `stallCleared` is the same watchdog reporting that frames resumed. */
    input: z
      .object({ reportStall: z.boolean().optional(), stallCleared: z.boolean().optional() })
      .strict(),
    output: liveStateSchema,
  },
  liveStart: {
    input: z.object({ device: z.string().optional() }).strict(),
    output: liveStateSchema,
  },
  liveStop: {
    input: z.object({ erase: z.string().optional(), shutdown: z.string().optional() }).strict(),
    output: liveStateSchema,
  },
  /** Take one frame off the stream and make it durable. */
  liveCapture: {
    input: z
      .object({
        label: z.string().max(120).optional(),
        settleMs: z.number().int().min(0).max(5000).optional(),
      })
      .strict(),
    output: z.object({ frame: frameSchema, summary: z.string() }).strict(),
  },
  /** The Frames strip: the last captures from this device, newest first. */
  liveFrames: {
    input: z.object({ limit: z.number().int().min(1).max(48).optional() }).strict(),
    output: z.object({ frames: z.array(frameSchema) }).strict(),
  },
  /** Enqueue a render. Returns immediately with the look id. */
  stillsRun: {
    input: z
      .object({
        scope: z.enum(["changed", "all"]).optional(),
        device: z.string().optional(),
      })
      .strict(),
    output: z.object({ lookId: z.string().nullable(), queued: z.number(), error: z.string().nullable() }).strict(),
  },
  /** The latest run for this scope, or the nothing-has-run-yet state. */
  stillsLatest: {
    input: z.object({ lookId: z.string().optional() }).strict(),
    output: lookSummarySchema,
  },
  /** One preview's frames over time, newest first. */
  stillsIdentityHistory: {
    input: z.object({ identity: z.string(), limit: z.number().int().min(1).max(60).optional() }).strict(),
    output: z
      .object({
        identity: z.string(),
        entries: z.array(
          z
            .object({
              frame: frameSchema,
              lookId: z.string(),
              commitSha: z.string().nullable(),
              capturedAt: z.number(),
              status: verdictStatusSchema.nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /** Accept one identity's new truth without accepting the other 147. */
  stillsAcceptIdentity: {
    input: z.object({ lookId: z.string(), identity: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  baselineShow: {
    input: z.null(),
    output: z
      .object({
        lookId: z.string().nullable(),
        setAt: z.number().nullable(),
        setBy: z.string().nullable(),
        commitSha: z.string().nullable(),
        identityCount: z.number(),
      })
      .strict(),
  },
  baselineSet: {
    input: z.object({ lookId: z.string() }).strict(),
    output: z.object({ ok: z.boolean(), replaced: z.string().nullable() }).strict(),
  },
  baselineClear: {
    input: z.null(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  onboardPlan: {
    /**
     * `wait` is for a foreground caller — someone who typed `bb sims onboard`
     * and is looking at a terminal. The panel never sets it: a mount must not
     * hold a handler open for the tens of seconds `xcodebuild -list` takes.
     */
    input: z.object({ project: z.string().optional(), wait: z.boolean().optional() }).strict(),
    output: onboardPlanSchema,
  },
  onboardApply: {
    input: z.object({ project: z.string().optional() }).strict(),
    output: z.object({ written: z.array(z.string()), manualSteps: z.array(z.string()), error: z.string().nullable() }).strict(),
  },
  /**
   * The composer banner for one thread.
   *
   * A failed thread-link read renders **no banner** and logs. That is
   * deliberate: the banner is an offer, and the panel is the surface that must
   * never lie.
   */
  bannerState: {
    input: z.object({ threadId: z.string().nullable() }).strict(),
    output: z
      .object({
        rows: z.array(
          z
            .object({
              id: z.string(),
              kind: z.enum(["failure", "run", "exposure"]),
              sentence: z.string(),
              tone: z.enum(["neutral", "dead", "exposed"]),
              dismissible: z.boolean(),
              lookId: z.string().nullable(),
              watermark: z.string().nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  bannerDismiss: {
    input: z.object({ threadId: z.string(), lookId: z.string(), watermark: z.string() }).strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  exposeState: {
    input: z.null(),
    output: z
      .object({
        available: z.boolean(),
        /** The sentence a disabled control shows. */
        reason: z.string().nullable(),
        /** Present only while exposed, and only to the surface that asked. */
        url: z.string().nullable(),
        msLeft: z.number().nullable(),
        deviceName: z.string().nullable(),
        /** The consent dialog's three facts, worded by the server. */
        consent: z
          .object({
            title: z.string(),
            facts: z.array(z.string()),
            confirmLabel: z.string(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  },
  exposeStart: {
    input: z.null(),
    output: z.object({ url: z.string().nullable(), error: z.string().nullable() }).strict(),
  },
  exposeStop: {
    input: z.null(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  purgePreview: {
    input: z.null(),
    output: z
      .object({
        looks: z.number(),
        bytes: z.number(),
        scopes: z.number(),
        sentence: z.string(),
      })
      .strict(),
  },
  purgeApply: {
    input: z.null(),
    output: z.object({ looks: z.number(), bytes: z.number() }).strict(),
  },
  /**
   * One scripted input step against the live device.
   *
   * The socket is server-owned and the frontend sends input over RPC. A direct
   * browser WebSocket to loopback would shave a millisecond or two, but it lets
   * two bb windows race for one device, needs a loopback origin the page may not
   * have, and dies entirely under `https:`. Local RPC costs one to three
   * milliseconds and works identically in every deployment — and an atomic
   * gesture survives a slow one, which a begin/end pair would not.
   */
  liveInput: {
    input: z.object({ step: stepSchema }).strict(),
    output: z
      .object({
        log: z.string(),
        /** Characters that could not be typed, rather than approximated. */
        dropped: z.array(z.string()),
      })
      .strict(),
  },
  /**
   * One live touch frame: the panel's pointer events, streamed as-is.
   *
   * Kept for a panel bundle from before `liveStream`: a window open across a
   * plugin reload keeps its old frontend against the new server, and its taps
   * must keep landing.
   */
  liveTouch: {
    input: z
      .object({
        phase: z.enum(["begin", "move", "end"]),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
  /**
   * A batch of live input events, in order, each stamped with the pointer
   * event's own timestamp.
   *
   * This is deliberately separate from `liveInput`'s gesture vocabulary. A
   * scripted gesture is atomic — "swipe from here to here over 250ms" — and
   * survives a high-latency link intact. A live drag is a stream of positions
   * the device must see *at their own cadence*, because iOS is doing the
   * gesture recognition — flick momentum is computed from the spacing of the
   * last few samples before the lift.
   *
   * Batched because RPC is plain HTTP with no ordering between concurrent
   * calls: the panel keeps exactly one batch in flight and accumulates the
   * rest, and the server replays each batch at the timestamps' spacing. On a
   * loopback link a batch is one or two events; over `bb connect` it is a
   * whole stretch of the drag, delivered smooth instead of as teleports.
   */
  liveStream: {
    input: z
      .object({
        events: z
          .array(
            z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("touch"),
                  phase: z.enum(["begin", "move", "end"]),
                  x: z.number().min(0).max(1),
                  y: z.number().min(0).max(1),
                  t: z.number().min(0),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("multi"),
                  phase: z.enum(["begin", "move", "end"]),
                  x1: z.number().min(0).max(1),
                  y1: z.number().min(0).max(1),
                  x2: z.number().min(0).max(1),
                  y2: z.number().min(0).max(1),
                  t: z.number().min(0),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("scroll"),
                  dx: z.number().min(-1).max(1),
                  dy: z.number().min(-1).max(1),
                  x: z.number().min(0).max(1).optional(),
                  y: z.number().min(0).max(1).optional(),
                  t: z.number().min(0),
                })
                .strict(),
            ]),
          )
          .min(1)
          .max(128),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }).strict(),
  },
});

export type RpcContract = typeof rpcContract;
