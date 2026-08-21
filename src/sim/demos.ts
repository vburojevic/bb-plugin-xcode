/**
 * Fixtures that need no hardware.
 *
 * `bb xcode sim demos` and `bb xcode sim demo-banner <state>` render these in the real
 * composer location for five minutes. That is the design-review loop, working
 * with no simulator and no project — which matters more than it sounds, because
 * the states worth reviewing are the failure states, and those are exactly the
 * ones you cannot produce on demand.
 */
import type { BannerRow } from "./banner.js";

export const DEMO_BANNER_STATES = [
  "changed",
  "one-changed",
  "running",
  "running-unknown",
  "failed-build",
  "failed-no-target",
  "off",
] as const;

export type DemoBannerState = (typeof DEMO_BANNER_STATES)[number];

export function isDemoBannerState(value: string): value is DemoBannerState {
  return (DEMO_BANNER_STATES as readonly string[]).includes(value);
}

/**
 * One demo banner row set.
 *
 * These are the sentences the real code produces, written out rather than
 * generated, so a change to the copy that forgets to update the demo shows up
 * as a difference on screen instead of quietly agreeing with itself.
 */
export function demoBanner(state: DemoBannerState): BannerRow[] {
  switch (state) {
    case "changed":
      return [
        {
          id: "demo-run",
          kind: "run",
          sentence: "12 previews moved since `a1b2c3d`",
          tone: "neutral",
          dismissible: true,
          lookId: "lk_demo",
          watermark: "demo",
        },
      ];
    case "one-changed":
      return [
        {
          id: "demo-run",
          kind: "run",
          sentence: "1 preview moved since `a1b2c3d`",
          tone: "neutral",
          dismissible: true,
          lookId: "lk_demo",
          watermark: "demo",
        },
      ];
    case "running":
      return [
        {
          id: "demo-run",
          kind: "run",
          sentence: "Rendering previews — 41/148",
          tone: "neutral",
          dismissible: false,
          lookId: "lk_demo",
          watermark: null,
        },
      ];
    case "running-unknown":
      return [
        {
          id: "demo-run",
          kind: "run",
          sentence: "Rendering previews…",
          tone: "neutral",
          dismissible: false,
          lookId: "lk_demo",
          watermark: null,
        },
      ];
    case "failed-build":
      return [
        {
          id: "demo-failure",
          kind: "failure",
          sentence: "Preview render failed — the build did not compile.",
          tone: "dead",
          dismissible: true,
          lookId: "lk_demo",
          watermark: "failed:lk_demo",
        },
      ];
    case "failed-no-target":
      return [
        {
          id: "demo-failure",
          kind: "failure",
          sentence: "Preview render failed — this project has no snapshot target.",
          tone: "dead",
          dismissible: true,
          lookId: "lk_demo",
          watermark: "failed:lk_demo",
        },
      ];
    case "off":
      return [];
  }
}

/** How long a demo banner stays up before it stops being a demo and becomes litter. */
export const DEMO_TTL_MS = 5 * 60_000;

export interface DemoState {
  state: DemoBannerState;
  until: number;
}
