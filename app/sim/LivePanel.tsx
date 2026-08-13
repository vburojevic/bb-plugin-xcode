/**
 * Live: the device fills the panel, and there is no chrome above it.
 *
 * The frame is a focusable region with a visible ring. Every non-streaming
 * state is a centred sentence over a dimmed frame. Controls sit along the
 * bottom edge, deliberately — a destructive action should not be under your
 * cursor when a panel springs open.
 *
 * Tab order is frame → meta line → control bar → overflow, and every state
 * sentence lives in an `aria-live` region so *"iPhone 17 Pro shut down"* is
 * heard and not only seen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { liveVeil, metaLine, TONE_CLASS } from "./copy";
import type { Action } from "./copy";
import { contentRect, keyStep, pointerStep, toNormalized, wheelStep } from "./frame-input";
import { describeSource, streamSources, type StreamSource } from "./stream-sources";
import { canDecodeH264, useVideoStream } from "./useVideoStream";
import type { DeviceList, LiveState } from "./useLive";
import type { Step } from "../../src/sim/steps.js";

/**
 * How long a stream may go without delivering a frame before the panel reports
 * a stall.
 *
 * This is the only stall detector that works: an `<img>` whose multipart stream
 * wedges fires no event at all, so nothing server-side can tell it from a
 * device showing a static screen.
 */
const STALL_AFTER_MS = 12_000;

/** Wheel events arrive far faster than a gesture needs; one per frame is plenty. */
const WHEEL_THROTTLE_MS = 40;

export interface LivePanelProps {
  state: LiveState | null;
  devices: DeviceList | null;
  onStart: (device?: string) => void;
  onRefresh: () => void;
  onStall: () => void;
  onOpenDoctor: () => void;
  onStep: (step: Step) => void;
  /** Rendered under the meta line — the Frames strip, once captures exist. */
  belowMeta?: React.ReactNode;
  /** Rendered along the bottom edge. */
  controls?: React.ReactNode;
}

export function LivePanel({
  state,
  devices,
  onStart,
  onRefresh,
  onStall,
  onOpenDoctor,
  onStep,
  belowMeta,
  controls,
}: LivePanelProps) {
  const [streamFailed, setStreamFailed] = useState(false);
  /**
   * Which stream is actually feeding the frame.
   *
   * Shown next to the meta line because the fallback is deliberately silent —
   * and a silent fallback is why "it is slow" took three rounds of measuring to
   * explain. If someone is on MJPEG, the first thing they should see is that
   * they are on MJPEG.
   */
  const [source, setSource] = useState<StreamSource | null>(null);
  // A new device, or a new stream, is a fresh chance for it to work.
  useEffect(() => setStreamFailed(false), [state?.streamUrl]);

  const veil = liveVeil(state, devices, streamFailed);
  const meta = state === null ? null : metaLine(state);

  const runAction = useCallback(
    (action: Action) => {
      switch (action.kind) {
        case "boot":
        case "watch":
        case "retry":
          onStart(action.udid);
          return;
        case "refresh":
          onRefresh();
          return;
        case "doctor":
          onOpenDoctor();
          return;
        case "expose":
          return;
      }
    },
    [onStart, onRefresh, onOpenDoctor],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LiveFrame
        state={state}
        veil={veil}
        onAction={runAction}
        onStall={onStall}
        onStep={onStep}
        onStreamFailed={() => setStreamFailed(true)}
        onSource={setSource}
      />

      {meta !== null ? (
        <div className="flex items-center gap-2 border-t px-3 py-2">
          {veil.tone === "live" ? <span className={`${TONE_CLASS.live} bbxs-dot`} aria-hidden /> : null}
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A bundle id is the most machine-shaped string on the machine
                  and does not belong as the primary label under a live video. */}
              <p tabIndex={0} className="truncate text-sm text-muted-foreground">
                {meta}
                {describeSource(source) === null ? null : (
                  <span className="ml-2 text-xs opacity-60">{describeSource(source)}</span>
                )}
              </p>
            </TooltipTrigger>
            <TooltipContent>
              {state?.foregroundBundleId ?? "Nothing is in the foreground yet."}
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      {belowMeta}

      <div aria-live="polite" className="sr-only">
        {veil.sentence ?? meta ?? ""}
      </div>

      {controls}
    </div>
  );
}

interface LiveFrameProps {
  state: LiveState | null;
  veil: ReturnType<typeof liveVeil>;
  onAction: (action: Action) => void;
  onStall: () => void;
  onStep: (step: Step) => void;
  onStreamFailed: () => void;
  /** Reports the rung in use, for the meta line. */
  onSource: (source: StreamSource | null) => void;
}

function LiveFrame({
  state,
  veil,
  onAction,
  onStall,
  onStep,
  onStreamFailed,
  onSource,
}: LiveFrameProps) {
  const proxiedUrl = state?.streamUrl ?? null;
  const directUrl = state?.directStreamUrl ?? null;
  const screen = state?.screen ?? null;
  // A dynamic aspect ratio is an inline style, because a build-time Tailwind
  // utility cannot be computed at runtime anyway.
  const aspect =
    screen !== null && screen.width > 0 && screen.height > 0
      ? { aspectRatio: `${screen.width} / ${screen.height}` }
      : undefined;

  const visible = useDocumentVisible();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [crosshair, setCrosshair] = useState<{ x: number; y: number } | null>(null);

  /**
   * The source ladder: best codec first, best route second.
   *
   * Neither question can be answered in advance. H.264 needs WebCodecs and a
   * host whose hardware can encode it; direct needs the viewer to be on this
   * machine, which the server cannot know about its own panel and which a
   * `bb connect` tunnel additionally forbids as mixed content. So the panel
   * tries, and a failure advances it one rung — no probe, no configuration.
   *
   * `streamSources` puts codec above route because the measurement does:
   * 24.9 fps at 200 KB/s over H.264 against 14.3 fps at 3.55 MB/s over MJPEG,
   * on the same device under the same motion.
   */
  const sources = useMemo(
    () => streamSources({ direct: directUrl, proxied: proxiedUrl }, canDecodeH264()),
    [directUrl, proxiedUrl],
  );
  const [rung, setRung] = useState(0);
  const source = sources[rung] ?? null;
  const streamUrl = source?.url ?? null;
  const streamingDirectly = source?.route === "direct";
  const decoding = source?.codec === "h264";

  const interactive = state?.kind === "streaming";

  // Either stream is unbounded, so both are opened only while mounted and
  // visible; hiding drops the connection.
  const active = streamUrl !== null && visible && !failed;

  // A new stream is a fresh start at the top of the ladder: a capture host
  // restart rotates the token and the port, and whatever made a rung fail last
  // time may have gone with it.
  useEffect(() => {
    setFailed(false);
    setRung(0);
  }, [proxiedUrl, directUrl]);

  /** One rung down, or out of rungs and the veil has to say so. */
  const advance = useCallback(() => {
    setRung((current) => {
      if (current + 1 < sources.length) return current + 1;
      setFailed(true);
      onStreamFailed();
      return current;
    });
  }, [sources.length, onStreamFailed]);

  useEffect(() => onSource(active ? source : null), [active, source, onSource]);

  const video = useVideoStream(decoding ? streamUrl : null, canvasRef, active);
  useEffect(() => {
    if (video.failed) advance();
  }, [video.failed, advance]);

  useEffect(() => {
    const element = imgRef.current;
    if (element === null) return;
    // Assigning "" is what actually drops the connection; removing the
    // attribute leaves the request in flight in some browsers.
    element.src = !decoding && active && streamUrl !== null ? streamUrl : "";
  }, [decoding, active, streamUrl]);

  /**
   * Presence, only while streaming directly.
   *
   * Bytes now bypass the bb server, and the viewer-presence signal used to be a
   * side effect of them passing through it. Without this the device session is
   * torn down 60 seconds into being watched. Zero bytes; the open connection is
   * the entire message.
   */
  useEffect(() => {
    // Derived from the proxied URL rather than composed from a plugin id: the
    // server already told us where its own routes live, and one source for
    // that string is one string that cannot drift.
    const presenceUrl = proxiedUrl?.replace("/http/stream?", "/http/presence?") ?? null;
    if (!streamingDirectly || !active || presenceUrl === null) return;
    const abort = new AbortController();
    void fetch(presenceUrl, { signal: abort.signal }).catch(() => {
      // Losing presence is not worth a sentence: the frame is still on screen,
      // and the worst case is the idle teardown this was holding off.
    });
    return () => abort.abort();
  }, [streamingDirectly, active, proxiedUrl]);

  useStallWatchdog(
    active && state?.kind === "streaming",
    imgRef,
    onStall,
    decoding ? video.frames : null,
  );

  const gesture = useRef<{ x: number; y: number; at: number; id: number } | null>(null);
  const lastWheel = useRef(0);

  /**
   * The picture's rectangle, not the element's.
   *
   * Whichever element is mounted — a canvas measures identically to an image —
   * narrowed to the area the frame actually covers. Both are
   * `object-fit: contain`, so a panel wider than the device letterboxes the
   * picture and every coordinate taken from the element box is wrong.
   */
  const rectOf = useCallback((): DOMRect | null => {
    const box = (canvasRef.current ?? imgRef.current)?.getBoundingClientRect() ?? null;
    if (box === null) return null;
    return contentRect(box, screen) as DOMRect;
  }, [screen]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!interactive) return;
      const rect = rectOf();
      if (rect === null) return;
      // Capture so a drag that leaves the frame still ends here — otherwise the
      // gesture never completes and the finger stays down on the device.
      event.currentTarget.setPointerCapture(event.pointerId);
      const point = toNormalized(rect, event.clientX, event.clientY);
      gesture.current = { ...point, at: Date.now(), id: event.pointerId };
    },
    [interactive, rectOf],
  );

  const endGesture = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const start = gesture.current;
      gesture.current = null;
      if (start === null || start.id !== event.pointerId) return;
      const rect = rectOf();
      if (rect === null) return;
      const end = toNormalized(rect, event.clientX, event.clientY);
      onStep(pointerStep(start, end, Date.now() - start.at));
    },
    [onStep, rectOf],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!interactive) return;
      const now = Date.now();
      if (now - lastWheel.current < WHEEL_THROTTLE_MS) return;
      lastWheel.current = now;
      const rect = rectOf();
      if (rect === null) return;
      const step = wheelStep(rect, event.deltaX, event.deltaY);
      if (step !== null) onStep(step);
    },
    [interactive, onStep, rectOf],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!interactive) return;
      const outcome = keyStep(event, crosshair !== null);
      if (outcome.kind === "ignore") return;
      event.preventDefault();
      switch (outcome.kind) {
        case "move":
          setCrosshair((current) => ({
            x: clamp01((current?.x ?? 0.5) + outcome.dx),
            y: clamp01((current?.y ?? 0.5) + outcome.dy),
          }));
          return;
        case "tap-crosshair":
          if (crosshair !== null) onStep({ kind: "tap", at: crosshair });
          return;
        case "release":
          setCrosshair(null);
          event.currentTarget.blur();
          return;
        case "step":
          onStep(outcome.step);
          return;
      }
    },
    [crosshair, interactive, onStep],
  );

  return (
    <div
      className="bbxs-frame min-h-0 flex-1 overflow-hidden"
      tabIndex={0}
      role="region"
      aria-label={
        state?.device == null
          ? "Simulator"
          : `Simulator: ${state.device.name}. Arrow keys move a crosshair, Return taps, Escape leaves.`
      }
      onPointerDown={onPointerDown}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onBlur={() => setCrosshair(null)}
    >
      {veil.skeleton ? (
        <div className="bbxs-skeleton h-full w-full" aria-hidden />
      ) : decoding ? (
        // H.264 is decoded here and painted, so the element is a canvas. It
        // carries the same class and aspect ratio as the image, and pointer
        // maths reads `getBoundingClientRect` either way, so nothing else in
        // this file has to know which one is on screen.
        <canvas
          ref={canvasRef}
          aria-hidden
          className="bbxs-frame-img h-full w-full"
          style={aspect}
        />
      ) : (
        <img
          ref={imgRef}
          alt=""
          draggable={false}
          className="bbxs-frame-img h-full w-full"
          style={aspect}
          // Advancing is silent until the ladder runs out, at which point
          // `advance` sets the sentence. A rung failing is ordinary — it is how
          // a viewer that is not on this machine discovers that.
          onError={advance}
        />
      )}

      {crosshair !== null ? (
        <span
          aria-hidden
          className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary"
          style={{ left: `${crosshair.x * 100}%`, top: `${crosshair.y * 100}%` }}
        />
      ) : null}

      {veil.sentence !== null ? (
        <div className={`bbxs-veil ${TONE_CLASS[veil.tone]}`}>
          <p className="max-w-prose text-balance text-sm font-medium">{veil.sentence}</p>
          {veil.detail !== null ? (
            <p className="max-w-prose text-balance text-xs text-muted-foreground">{veil.detail}</p>
          ) : null}
          {veil.actions.length > 0 ? (
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              {veil.actions.map((action) => (
                <Button key={action.kind + action.label} size="sm" onClick={() => onAction(action)}>
                  {action.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** `document.visibilityState`, as a hook, so a hidden tab holds no stream. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onChange = (): void => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * Report a stall when the image stops updating.
 *
 * A multipart stream mutates the image in place, and browsers fire `load` per
 * part — so "no load event for twelve seconds" is the signal. A device
 * genuinely showing a static screen is re-confirmed by one `simctl` call
 * server-side, which is cheap and correct; guessing here is not.
 */
function useStallWatchdog(
  enabled: boolean,
  ref: React.RefObject<HTMLImageElement | null>,
  onStall: () => void,
  /**
   * Decoded-frame count when H.264 is in use; `null` on the MJPEG path.
   *
   * A canvas fires no `load` events, so the decoder's own counter is the
   * signal. It is also the better one: it says a frame was *decoded and
   * painted*, where `load` only ever said bytes arrived.
   */
  decodedFrames: number | null,
): void {
  useEffect(() => {
    if (!enabled) return;
    let lastSeen = Date.now();
    let reported = false;

    const element = ref.current;
    const onLoad = (): void => {
      lastSeen = Date.now();
      reported = false;
    };
    element?.addEventListener("load", onLoad);

    const timer = setInterval(() => {
      if (reported) return;
      if (Date.now() - lastSeen < STALL_AFTER_MS) return;
      reported = true;
      onStall();
    }, 2000);

    return () => {
      clearInterval(timer);
      element?.removeEventListener("load", onLoad);
    };
  }, [enabled, ref, onStall, decodedFrames]);
}
