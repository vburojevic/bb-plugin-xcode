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
 *
 * There is exactly one render stack: a single canvas fed by `useStream`,
 * whichever codec and route won the ladder. The `<img>` stack it replaced
 * could not count frames, could not time them, and fired its `load` event per
 * part only in the browsers that felt like it — which is how "The stream
 * stopped" ended up over a video that was playing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { liveVeil, metaLine, TONE_CLASS } from "./copy";
import type { Action } from "./copy";
import { contentRect, keyStep, toNormalized, wheelStep } from "./frame-input";
import { canDecodeH264, currentViewerCanReachLoopback } from "./stream-core";
import { describeSource, streamSources, type StreamSource } from "./stream-sources";
import type { TouchPhase } from "./touch-channel";
import { useStream } from "./useStream";
import type { DeviceList, LiveState } from "./useLive";
import type { Step } from "../../src/sim/steps.js";

/**
 * How long a stream may go without delivering a frame before the panel reports
 * a stall.
 *
 * This works because the panel now counts painted frames itself — the only
 * stall detector that ever works. It is also self-clearing: the next painted
 * frame after a stall takes the sentence back, where a server-side guess used
 * to leave it up forever.
 */
const STALL_AFTER_MS = 12_000;

export interface LivePanelProps {
  state: LiveState | null;
  devices: DeviceList | null;
  onStart: (device?: string) => void;
  onRefresh: () => void;
  onStall: () => void;
  /** Frames resumed after a stall; the server can take the sentence back. */
  onAlive: () => void;
  onOpenDoctor: () => void;
  onStep: (step: Step) => void;
  /** Live touch frames from the pointer — the device does the recognising. */
  onTouch: (phase: TouchPhase, x: number, y: number) => void;
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
  onAlive,
  onOpenDoctor,
  onStep,
  onTouch,
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
  const [fps, setFps] = useState<number | null>(null);
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

  const onStreamStats = useCallback((next: StreamSource | null, nextFps: number | null) => {
    setSource(next);
    setFps(nextFps);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LiveFrame
        state={state}
        veil={veil}
        onAction={runAction}
        onStall={onStall}
        onAlive={onAlive}
        onStep={onStep}
        onTouch={onTouch}
        onStreamFailed={() => setStreamFailed(true)}
        onStats={onStreamStats}
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
                  <span className="ml-2 text-xs opacity-60">
                    {describeSource(source)}
                    {fps === null ? "" : ` · ${fps} fps`}
                  </span>
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
  onAlive: () => void;
  onStep: (step: Step) => void;
  onTouch: (phase: TouchPhase, x: number, y: number) => void;
  onStreamFailed: () => void;
  /** Reports the rung in use and its pace, for the meta line. */
  onStats: (source: StreamSource | null, fps: number | null) => void;
}

function LiveFrame({
  state,
  veil,
  onAction,
  onStall,
  onAlive,
  onStep,
  onTouch,
  onStreamFailed,
  onStats,
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
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [crosshair, setCrosshair] = useState<{ x: number; y: number } | null>(null);

  /**
   * The source ladder: best codec first, best route second — with the routes
   * this page can actually use. `currentViewerCanReachLoopback` answers the
   * remote/mixed-content question from the page's own origin, so a viewer
   * over `bb connect` no longer burns two doomed rungs finding out.
   *
   * Codec outranks route because the measurement says so: 24.9 fps at
   * 200 KB/s over H.264 against 14.3 fps at 3.55 MB/s over MJPEG, on the same
   * device under the same motion.
   */
  const sources = useMemo(
    () =>
      streamSources({ direct: directUrl, proxied: proxiedUrl }, canDecodeH264(), {
        directViable: currentViewerCanReachLoopback(),
      }),
    [directUrl, proxiedUrl],
  );
  const [rung, setRung] = useState(0);
  const source = sources[rung] ?? null;
  /** Every rung failed; the veil has to say so. */
  const exhausted = rung >= sources.length;

  const interactive = state?.kind === "streaming";

  // The stream is unbounded, so it is opened only while mounted and visible;
  // hiding drops the connection.
  const active = source !== null && visible && !exhausted;

  // A new stream is a fresh start at the top of the ladder: a capture host
  // restart rotates the token and the port, and whatever made a rung fail last
  // time may have gone with it.
  useEffect(() => {
    setRung(0);
  }, [proxiedUrl, directUrl]);

  const video = useStream(source, canvasRef, active);

  /**
   * One rung down, or out of rungs and the veil has to say so.
   *
   * An effect, not a state updater: side effects inside an updater run twice
   * under StrictMode's double invocation, and "the stream failed" arriving
   * twice is how one failure used to report two.
   */
  useEffect(() => {
    if (!video.failed) return;
    if (rung + 1 < sources.length) setRung(rung + 1);
  }, [video.failed, rung, sources.length]);

  useEffect(() => {
    if (video.failed && rung + 1 >= sources.length) onStreamFailed();
  }, [video.failed, rung, sources.length, onStreamFailed]);

  useEffect(() => onStats(active ? source : null, video.fps), [active, source, video.fps, onStats]);

  /**
   * Presence, only while streaming directly.
   *
   * Bytes now bypass the bb server, and the viewer-presence signal used to be a
   * side effect of them passing through it. Without this the device session is
   * torn down 60 seconds into being watched. Zero bytes; the open connection is
   * the entire message.
   */
  const streamingDirectly = source?.route === "direct";
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

  useFrameWatchdog(active && state?.kind === "streaming", video.frames, onStall, onAlive);

  /**
   * Pointer events become touch frames, verbatim.
   *
   * There is no gesture classification here on purpose: the panel used to
   * decide "that was a tap" or "that was a swipe", replay the gesture
   * server-side, and get it subtly wrong (a tap's `end` even went out at
   * screen centre). Streaming begin/move/end as they happen lets iOS do all
   * of the recognising — tap, double-tap, long-press, drag — at the full
   * fidelity of a finger on glass, and the frame above it responds *while*
   * you drag, not after you let go.
   */
  const dragging = useRef<{ pointerId: number } | null>(null);
  /** Freshest unsent move; coalesced to one per animation frame. */
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  const moveFrame = useRef(0);

  const rectOf = useCallback((): DOMRect | null => {
    const box = canvasRef.current?.getBoundingClientRect() ?? null;
    if (box === null) return null;
    return contentRect(box, screen) as DOMRect;
  }, [screen]);

  const flushMove = useCallback((): void => {
    moveFrame.current = 0;
    const move = pendingMove.current;
    pendingMove.current = null;
    if (move === null || dragging.current === null) return;
    onTouch("move", move.x, move.y);
  }, [onTouch]);

  // No rAF may outlive the frame: a flush after unmount is a move for a drag
  // that no longer exists.
  useEffect(
    () => () => {
      if (moveFrame.current !== 0) cancelAnimationFrame(moveFrame.current);
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!interactive || event.button !== 0) return;
      const rect = rectOf();
      if (rect === null) return;
      // Capture so a drag that leaves the frame still ends here — otherwise the
      // gesture never completes and the finger stays down on the device.
      event.currentTarget.setPointerCapture(event.pointerId);
      dragging.current = { pointerId: event.pointerId };
      const point = toNormalized(rect, event.clientX, event.clientY);
      onTouch("begin", point.x, point.y);
    },
    [interactive, rectOf, onTouch],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragging.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const rect = rectOf();
      if (rect === null) return;
      pendingMove.current = toNormalized(rect, event.clientX, event.clientY);
      if (moveFrame.current === 0) moveFrame.current = requestAnimationFrame(flushMove);
    },
    [rectOf, flushMove],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragging.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      dragging.current = null;
      if (moveFrame.current !== 0) {
        cancelAnimationFrame(moveFrame.current);
        moveFrame.current = 0;
      }
      pendingMove.current = null;
      const rect = rectOf();
      if (rect === null) return;
      const point = toNormalized(rect, event.clientX, event.clientY);
      onTouch("end", point.x, point.y);
    },
    [rectOf, onTouch],
  );

  /**
   * The wheel, accumulated per frame rather than throttled per event.
   *
   * The old 40ms throttle *dropped* every delta that arrived inside the
   * window — that lost distance is exactly the "scroll is slow" a trackpad
   * user feels. Accumulating preserves every pixel and still sends at most
   * one scroll step per animation frame, anchored under the cursor so the
   * list being pointed at is the list that scrolls.
   */
  const wheel = useRef({ dx: 0, dy: 0, clientX: 0, clientY: 0, frame: 0 });

  const onWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (!interactive) return;
      const acc = wheel.current;
      acc.dx += event.deltaX;
      acc.dy += event.deltaY;
      acc.clientX = event.clientX;
      acc.clientY = event.clientY;
      if (acc.frame !== 0) return;
      acc.frame = requestAnimationFrame(() => {
        acc.frame = 0;
        const rect = rectOf();
        if (rect === null) {
          acc.dx = 0;
          acc.dy = 0;
          return;
        }
        const step = wheelStep(rect, acc.dx, acc.dy, toNormalized(rect, acc.clientX, acc.clientY));
        acc.dx = 0;
        acc.dy = 0;
        if (step !== null) onStep(step);
      });
    },
    [interactive, onStep, rectOf],
  );

  useEffect(
    () => () => {
      if (wheel.current.frame !== 0) cancelAnimationFrame(wheel.current.frame);
    },
    [],
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
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onBlur={() => setCrosshair(null)}
    >
      {veil.skeleton ? (
        <div className="bbxs-skeleton h-full w-full" aria-hidden />
      ) : (
        <canvas
          ref={canvasRef}
          aria-hidden
          className="bbxs-frame-img h-full w-full"
          style={aspect}
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
 * Report a stall when painted frames stop, and take it back when they resume.
 *
 * One interval per mount — the frame count lives in a ref, so the timer is
 * not torn down and rebuilt twenty-five times a second. A stall is reported
 * once per episode, and the *next painted frame* clears it: the panel is the
 * only place frames can be counted, so it is the only place a stall can
 * honestly be declared or rescinded.
 */
function useFrameWatchdog(
  enabled: boolean,
  frames: number,
  onStall: () => void,
  onAlive: () => void,
): void {
  const framesRef = useRef(frames);
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);

  const callbacksRef = useRef({ onStall, onAlive });
  useEffect(() => {
    callbacksRef.current = { onStall, onAlive };
  }, [onStall, onAlive]);

  useEffect(() => {
    if (!enabled) return;
    let lastSeen = framesRef.current;
    let lastAdvance = Date.now();
    let reported = false;

    const timer = setInterval(() => {
      if (framesRef.current !== lastSeen) {
        lastSeen = framesRef.current;
        lastAdvance = Date.now();
        if (reported) {
          reported = false;
          callbacksRef.current.onAlive();
        }
        return;
      }
      if (!reported && Date.now() - lastAdvance >= STALL_AFTER_MS) {
        reported = true;
        callbacksRef.current.onStall();
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [enabled]);
}
