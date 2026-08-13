/**
 * Project detection, cached and refreshed in the background.
 *
 * **Nothing blocks a handler.** `xcodebuild -list` on a project with package
 * dependencies takes tens of seconds — measured at 47s on a real project here,
 * inside an RPC handler the Stills panel calls on every mount and every
 * realtime signal. That is the whole reason this file exists.
 *
 * So a miss answers *immediately* with what it already knows and kicks the
 * detection into the background; when the answer lands, a realtime signal
 * brings the panel back for it. A hit answers from memory. Concurrent callers
 * share one in-flight detection rather than starting several `xcodebuild`
 * processes against the same project.
 */
import type { DetectedProject } from "./onboard.js";

/** Long enough that a panel session costs one detection; short enough to notice a new scheme. */
export const DETECT_TTL_MS = 5 * 60_000;

export interface DetectRequest {
  checkoutPath: string;
  relPath: string;
  scheme: string;
}

interface Entry {
  at: number;
  value: DetectedProject | null;
  inFlight: Promise<DetectedProject | null> | null;
}

export type DetectResult =
  | { status: "ready"; project: DetectedProject | null }
  /** Nothing known yet; a detection is running and will publish when it lands. */
  | { status: "detecting" };

export class DetectCache {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly detect: (request: DetectRequest) => Promise<DetectedProject>,
    private readonly onSettled: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  private keyOf(request: DetectRequest): string {
    return `${request.checkoutPath}|${request.relPath}|${request.scheme}`;
  }

  /**
   * Answer now.
   *
   * A stale-but-present value is returned rather than withheld: a scheme list
   * from four minutes ago is right far more often than a spinner is useful, and
   * the refresh is already running behind it.
   */
  get(request: DetectRequest): DetectResult {
    const key = this.keyOf(request);
    const entry = this.entries.get(key);
    const fresh = entry !== undefined && this.now() - entry.at < DETECT_TTL_MS;

    if (entry === undefined || !fresh) this.refresh(key, request);
    if (entry === undefined) return { status: "detecting" };
    return { status: "ready", project: entry.value };
  }

  /** Await a detection. Only the run path does this — it is about to spend minutes anyway. */
  async resolve(request: DetectRequest): Promise<DetectedProject | null> {
    const key = this.keyOf(request);
    const entry = this.entries.get(key);
    if (entry !== undefined && this.now() - entry.at < DETECT_TTL_MS) return entry.value;
    return this.refresh(key, request);
  }

  private refresh(key: string, request: DetectRequest): Promise<DetectedProject | null> {
    const existing = this.entries.get(key);
    if (existing?.inFlight != null) return existing.inFlight;

    const inFlight = this.detect(request)
      .then((project): DetectedProject | null => project)
      .catch((): DetectedProject | null => null)
      .then((value) => {
        this.entries.set(key, { at: this.now(), value, inFlight: null });
        try {
          this.onSettled();
        } catch {
          // The publisher is stale; the value is cached either way.
        }
        return value;
      });

    this.entries.set(key, {
      at: existing?.at ?? 0,
      value: existing?.value ?? null,
      inFlight,
    });
    return inFlight;
  }

  /** Drop everything, e.g. when the project path setting changes. */
  clear(): void {
    this.entries.clear();
  }
}
