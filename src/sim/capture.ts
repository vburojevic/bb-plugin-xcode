/**
 * Taking one frame off the live stream and making it durable.
 *
 * A capture is its own look — one row, one frame. Cheaper models were
 * considered and both are worse: appending every capture to a session-long look
 * collides on `UNIQUE(look_id, identity)` the second time you press Capture
 * without changing the label, and a look per session loses the per-capture
 * commit and time that make the Frames strip readable.
 */
import { captureIdentity, captureSlug, deviceKey, newFrameId, newLookId } from "./model.js";
import { hashContent, insertFrame, insertLook, updateLook } from "./frames.js";
import { dimensions, downscale, THUMB_LONG_EDGE } from "./image.js";
import { FrameStore } from "./framestore.js";
import * as host from "./sim-host-client.js";
import type { Db } from "./store.js";
import type { LiveDevice } from "./live.js";

export interface CaptureInput {
  db: Db;
  store: FrameStore;
  address: host.SimHostAddress;
  device: LiveDevice;
  scopeKey: string;
  projectId: string;
  commitSha: string | null;
  branch: string | null;
  /** The frame's own scale, from the device's pushed dimensions. */
  screen: { width: number; height: number } | null;
  label: string | null;
  /** Milliseconds to wait before grabbing, so an animation can land. */
  settleMs?: number;
  now: () => number;
}

export interface CaptureResult {
  lookId: string;
  frameId: string;
  identity: string;
  relPath: string;
  width: number;
  height: number;
  bytes: number;
  foregroundBundleId: string | null;
  /** The sentence naming what was on screen. */
  summary: string;
}

/** A settle longer than this is a `wait` step, not a capture argument. */
export const MAX_SETTLE_MS = 5000;

export async function capture(input: CaptureInput): Promise<CaptureResult> {
  const settle = Math.min(MAX_SETTLE_MS, Math.max(0, input.settleMs ?? 0));
  if (settle > 0) await new Promise((resolve) => setTimeout(resolve, settle).unref?.());

  // Ask what is on screen *before* grabbing, so the label describes the frame
  // rather than whatever the device moved on to while we were writing it.
  const foreground = await host.foregroundApp(input.address, input.device.udid);
  const bytes = await host.grabFrame(input.address, input.device.udid);

  const size = dimensions(bytes);
  if (size === null) {
    throw new Error("The simulator sent something that is not an image.");
  }

  const at = input.now();
  const slug = captureSlug(input.label ?? "", at);
  const identity = captureIdentity(slug);
  const lookId = newLookId(at);
  const frameId = newFrameId(at);
  // JPEG, because that is what came off the stream. Re-encoding to PNG costs
  // time and disk to make a lossy image lossless, which is not a thing that
  // can be done.
  const relPath = `${slug}.jpg`;
  const thumbRelPath = `${slug}.thumb.jpg`;

  const scale = input.screen === null || input.screen.width === 0 ? null : size.width / input.screen.width;

  insertLook(input.db, {
    id: lookId,
    projectId: input.projectId,
    scopeKey: input.scopeKey,
    kind: "live",
    status: "running",
    commitSha: input.commitSha,
    branch: input.branch,
    deviceKey: deviceKey({
      name: input.device.name,
      osVersion: input.device.osVersion,
      scale: scale ?? 1,
      arch: process.arch,
    }),
    deviceUdid: input.device.udid,
    deviceName: input.device.name,
    osVersion: input.device.osVersion,
    scale,
    startedAt: at,
    expectedCount: 1,
    meta: foreground.bundleId === null ? {} : { foregroundBundleId: foreground.bundleId },
  });

  await input.store.ensureLookDir(input.scopeKey, lookId);
  const written = await input.store.write({ scopeKey: input.scopeKey, lookId, relPath }, bytes);

  // A missing thumbnail degrades the strip to full-size images — slow but
  // correct — so it is never allowed to fail the capture.
  const framePath = `${input.store.root}/${input.scopeKey}/${lookId}/${relPath}`;
  const thumbPath = `${input.store.root}/${input.scopeKey}/${lookId}/${thumbRelPath}`;
  const madeThumb = await downscale(framePath, thumbPath, THUMB_LONG_EDGE);

  insertFrame(input.db, {
    id: frameId,
    lookId,
    identity,
    source: "capture",
    displayName: input.label ?? "Capture",
    groupName: "",
    relPath,
    thumbRelPath: madeThumb ? thumbRelPath : null,
    width: size.width,
    height: size.height,
    contentHash: hashContent(bytes),
    bytes: written,
    diffThreshold: null,
    sidecarJson: null,
    foregroundBundleId: foreground.bundleId,
    capturedAt: at,
  });

  updateLook(input.db, lookId, {
    status: "ok",
    endedAt: input.now(),
    frameCount: 1,
    bytesTotal: written,
    manifestRan: false,
  });

  return {
    lookId,
    frameId,
    identity,
    relPath,
    width: size.width,
    height: size.height,
    bytes: written,
    foregroundBundleId: foreground.bundleId,
    summary: describeCapture(input.device.name, foreground.bundleId),
  };
}

const HOME_SCREEN = new Set(["com.apple.springboard", "com.apple.springboard.home"]);

/**
 * The one-line summary that goes back to a model.
 *
 * It names the app because "here is a screenshot" is not information — the
 * model needs to know whether it is looking at the thing it just changed or at
 * a home screen because the app crashed on launch.
 */
export function describeCapture(deviceName: string, bundleId: string | null): string {
  if (bundleId === null || HOME_SCREEN.has(bundleId.toLowerCase())) {
    return `${deviceName} is on the home screen.`;
  }
  return `${bundleId} is in the foreground on ${deviceName}.`;
}
