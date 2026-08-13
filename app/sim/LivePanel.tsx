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
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { liveVeil, metaLine, TONE_CLASS } from "./copy";
import type { Action } from "./copy";
import { keyStep, pointerStep, toNormalized, wheelStep } from "./frame-input";
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
}

function LiveFrame({ state, veil, onAction, onStall, onStep, onStreamFailed }: LiveFrameProps) {
  const streamUrl = state?.streamUrl ?? null;
  const screen = state?.screen ?? null;
  // A dynamic aspect ratio is an inline style, because a build-time Tailwind
  // utility cannot be computed at runtime anyway.
  const aspect =
    screen !== null && screen.width > 0 && screen.height > 0
      ? { aspectRatio: `${screen.width} / ${screen.height}` }
      : undefined;

  const visible = useDocumentVisible();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [crosshair, setCrosshair] = useState<{ x: number; y: number } | null>(null);

  const interactive = state?.kind === "streaming";

  // MJPEG is unbounded. The stream is opened only while mounted and visible,
  // and `src` is cleared on hide, which closes the connection — which is also
  // the server's viewer-presence signal.
  const active = streamUrl !== null && visible && !failed;

  useEffect(() => setFailed(false), [streamUrl]);

  useEffect(() => {
    const element = imgRef.current;
    if (element === null) return;
    // Assigning "" is what actually drops the connection; removing the
    // attribute leaves the request in flight in some browsers.
    element.src = active && streamUrl !== null ? streamUrl : "";
  }, [active, streamUrl]);

  useStallWatchdog(active && state?.kind === "streaming", imgRef, onStall);

  const gesture = useRef<{ x: number; y: number; at: number; id: number } | null>(null);
  const lastWheel = useRef(0);

  const rectOf = useCallback((): DOMRect | null => imgRef.current?.getBoundingClientRect() ?? null, []);

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
      ) : (
        <img
          ref={imgRef}
          alt=""
          draggable={false}
          className="bbxs-frame-img h-full w-full"
          style={aspect}
          onError={() => {
            // Both, and they are different facts: `failed` stops this element
            // re-requesting a stream that just refused, `onStreamFailed`
            // gets a sentence on screen in place of the broken-image glyph.
            setFailed(true);
            onStreamFailed();
          }}
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
  }, [enabled, ref, onStall]);
}
