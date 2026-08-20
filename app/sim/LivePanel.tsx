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
import {
  contentRect,
  keyStep,
  PINCH_IDLE_END_MS,
  PINCH_INITIAL_SPREAD,
  pinchFingers,
  pinchSpread,
  toNormalized,
  wheelStep,
} from "./frame-input";
import { canDecodeH264, currentViewerCanReachLoopback } from "./stream-core";
import { describeSource, streamSources, type StreamSource } from "./stream-sources";
import type { StreamEvent } from "./touch-channel";
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
  /** Live input frames from the pointer — the device does the recognising. */
  onInput: (event: StreamEvent) => void;
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
  onInput,
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
        onInput={onInput}
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
  onInput: (event: StreamEvent) => void;
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
  onInput,
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
  const frameRef = useRef<HTMLDivElement | null>(null);
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
   * Pointer events become touch frames, verbatim and fully sampled.
   *
   * There is no gesture classification here on purpose: the panel used to
   * decide "that was a tap" or "that was a swipe", replay the gesture
   * server-side, and get it subtly wrong (a tap's `end` even went out at
   * screen centre). Streaming begin/move/end as they happen lets iOS do all
   * of the recognising — tap, double-tap, long-press, drag — at the full
   * fidelity of a finger on glass.
   *
   * Moves go out with `getCoalescedEvents()` — the full 120 Hz trail, each
   * sample with its own timestamp — because the transport batches and the
   * server replays at those timestamps' spacing. The per-frame latest-wins
   * coalescing that used to live here threw the trail away, and iOS computes
   * flick momentum from exactly the samples it discarded.
   */
  const dragging = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const rectOf = useCallback((): DOMRect | null => {
    const box = canvasRef.current?.getBoundingClientRect() ?? null;
    if (box === null) return null;
    return contentRect(box, screen) as DOMRect;
  }, [screen]);

  // The wheel listener attaches once; these refs keep it reading fresh facts.
  const rectOfRef = useRef(rectOf);
  useEffect(() => {
    rectOfRef.current = rectOf;
  }, [rectOf]);
  const onInputRef = useRef(onInput);
  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  /**
   * The trackpad pinch, as two live fingers.
   *
   * macOS delivers a pinch as wheel events with `ctrlKey` set. Each one moves
   * a pair of synthetic fingers on a diagonal around the cursor, and a beat
   * with no event ends the gesture — so a map or a photo zooms *while* the
   * fingers spread, exactly like the glass.
   */
  const pinch = useRef<{ spread: number; x: number; y: number; timer: number } | null>(null);

  const endPinch = useCallback((): void => {
    const active = pinch.current;
    if (active === null) return;
    pinch.current = null;
    window.clearTimeout(active.timer);
    onInputRef.current({
      kind: "multi",
      phase: "end",
      ...pinchFingers({ x: active.x, y: active.y }, active.spread),
      t: performance.now(),
    });
  }, []);
  const endPinchRef = useRef(endPinch);
  useEffect(() => {
    endPinchRef.current = endPinch;
  }, [endPinch]);

  /**
   * Lift the finger wherever the drag is abandoned: unmount, tab hidden,
   * capture lost.
   *
   * Without this, closing the panel mid-drag left the finger on the device
   * until the five-second stuck-finger watchdog noticed — five seconds of the
   * simulator ignoring input, with no error anywhere.
   */
  const abandonDrag = useCallback((): void => {
    endPinch();
    const drag = dragging.current;
    if (drag === null) return;
    dragging.current = null;
    // The freshest position is the honest lift point.
    onInput({ kind: "touch", phase: "end", x: drag.x, y: drag.y, t: performance.now() });
  }, [onInput, endPinch]);

  // Returned as the cleanup: unmounting mid-drag lifts the finger too.
  useEffect(() => abandonDrag, [abandonDrag]);
  useEffect(() => {
    if (!visible) abandonDrag();
  }, [visible, abandonDrag]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!interactive || event.button !== 0) return;
      const rect = rectOf();
      if (rect === null) return;
      // A real finger replaces the synthetic pinch pair.
      endPinch();
      // Capture so a drag that leaves the frame still ends here — otherwise the
      // gesture never completes and the finger stays down on the device.
      event.currentTarget.setPointerCapture(event.pointerId);
      // Focus, explicitly: paste and the keyboard map belong to a frame that
      // was just clicked, and not every browser focuses a tabIndex div itself.
      event.currentTarget.focus();
      const point = toNormalized(rect, event.clientX, event.clientY);
      dragging.current = { pointerId: event.pointerId, x: point.x, y: point.y };
      onInput({ kind: "touch", phase: "begin", x: point.x, y: point.y, t: event.timeStamp });
    },
    [interactive, rectOf, onInput, endPinch],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragging.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      const rect = rectOf();
      if (rect === null) return;
      // The coalesced samples are the full-rate trail this event summarizes;
      // browsers without the API get the summary sample alone.
      const native = event.nativeEvent;
      const trail =
        typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
      for (const sample of trail.length > 0 ? trail : [native]) {
        const point = toNormalized(rect, sample.clientX, sample.clientY);
        drag.x = point.x;
        drag.y = point.y;
        onInput({ kind: "touch", phase: "move", x: point.x, y: point.y, t: sample.timeStamp });
      }
    },
    [rectOf, onInput],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragging.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      dragging.current = null;
      const rect = rectOf();
      const point =
        rect === null
          ? { x: drag.x, y: drag.y }
          : toNormalized(rect, event.clientX, event.clientY);
      onInput({ kind: "touch", phase: "end", x: point.x, y: point.y, t: event.timeStamp });
    },
    [rectOf, onInput],
  );

  /**
   * The wheel, native and non-passive.
   *
   * React attaches wheel listeners passively, and a passive listener cannot
   * `preventDefault()` — so a trackpad pinch also zoomed the whole bb window,
   * and a scroll bled into the page behind the panel. One native listener
   * owns both: `ctrlKey` wheels are the macOS pinch, everything else
   * accumulates per animation frame into a scroll anchored under the cursor.
   * Accumulating preserves every pixel of delta; the old 40ms throttle
   * dropped them, which is exactly the "scroll is slow" a trackpad user felt.
   */
  const wheel = useRef({ dx: 0, dy: 0, clientX: 0, clientY: 0, deltaMode: 0, frame: 0 });

  useEffect(() => {
    const node = frameRef.current;
    if (node === null || !interactive) return;
    const acc = wheel.current;

    const flush = (): void => {
      acc.frame = 0;
      const rect = rectOfRef.current();
      if (rect === null) {
        acc.dx = 0;
        acc.dy = 0;
        return;
      }
      const step = wheelStep(
        rect,
        acc.dx,
        acc.dy,
        toNormalized(rect, acc.clientX, acc.clientY),
        acc.deltaMode,
      );
      acc.dx = 0;
      acc.dy = 0;
      if (step !== null && step.kind === "scroll") {
        // `at` is always coordinates here — `wheelStep` anchors under the
        // cursor — but the step schema also admits an element reference.
        const at = step.at !== undefined && "x" in step.at ? step.at : undefined;
        onInputRef.current({
          kind: "scroll",
          dx: step.dx,
          dy: step.dy,
          ...(at === undefined ? {} : { x: at.x, y: at.y }),
          t: performance.now(),
        });
      }
    };

    const onNativeWheel = (event: WheelEvent): void => {
      event.preventDefault();
      if (event.ctrlKey) {
        const rect = rectOfRef.current();
        if (rect === null) return;
        const at = toNormalized(rect, event.clientX, event.clientY);
        let active = pinch.current;
        if (active === null) {
          active = { spread: PINCH_INITIAL_SPREAD, x: at.x, y: at.y, timer: 0 };
          pinch.current = active;
          onInputRef.current({
            kind: "multi",
            phase: "begin",
            ...pinchFingers(at, active.spread),
            t: event.timeStamp,
          });
        }
        active.x = at.x;
        active.y = at.y;
        active.spread = pinchSpread(active.spread, event.deltaY);
        onInputRef.current({
          kind: "multi",
          phase: "move",
          ...pinchFingers(at, active.spread),
          t: event.timeStamp,
        });
        window.clearTimeout(active.timer);
        active.timer = window.setTimeout(() => endPinchRef.current(), PINCH_IDLE_END_MS);
        return;
      }
      acc.dx += event.deltaX;
      acc.dy += event.deltaY;
      acc.clientX = event.clientX;
      acc.clientY = event.clientY;
      acc.deltaMode = event.deltaMode;
      if (acc.frame === 0) acc.frame = requestAnimationFrame(flush);
    };

    node.addEventListener("wheel", onNativeWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onNativeWheel);
      if (acc.frame !== 0) {
        cancelAnimationFrame(acc.frame);
        acc.frame = 0;
      }
      endPinchRef.current();
    };
  }, [interactive]);

  /**
   * ⌘V, pasted into the device.
   *
   * The frame holds focus after a click, so the paste lands here rather than
   * in the composer — and a `type` step is the whole implementation: the
   * server types what it can and routes the rest through the device
   * pasteboard.
   */
  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (!interactive) return;
      const text = event.clipboardData.getData("text/plain");
      if (text === "") return;
      event.preventDefault();
      onStep({ kind: "type", text: text.slice(0, 2000) });
    },
    [interactive, onStep],
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
      ref={frameRef}
      className="bbxs-frame min-h-0 flex-1 overflow-hidden"
      tabIndex={0}
      role="region"
      aria-label={
        state?.device == null
          ? "Simulator"
          : `Simulator: ${state.device.name}. Arrow keys move a crosshair, Return taps, Escape leaves.`
      }
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
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
