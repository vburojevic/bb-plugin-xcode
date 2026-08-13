/**
 * Every sentence the Live surface can say, as a pure function of state.
 *
 * Split out from the components so the frontend tests can assert **the
 * sentence** — the sentence is the contract, not the class name — and so the
 * panel, `bb sims doctor` and the empty state cannot drift into three
 * vocabularies for one situation.
 */
import { joinWords } from "../../src/sim/format.js";
import type { DeviceList, LiveState } from "./useLive.js";

export type Tone = "neutral" | "live" | "stalled" | "dead" | "exposed";

export interface Action {
  label: string;
  kind: "boot" | "watch" | "refresh" | "retry" | "expose" | "doctor";
  /** The device this action would act on, when it names one. */
  udid?: string;
}

export interface Veil {
  /** `null` means "show the frame": there is nothing to say over it. */
  sentence: string | null;
  /** A second line, for a state that has a fix worth stating separately. */
  detail: string | null;
  tone: Tone;
  actions: Action[];
  /** True only at first mount, where a skeleton is the honest rendering. */
  skeleton: boolean;
}

const HOME_SCREEN_BUNDLES = new Set(["com.apple.springboard", "com.apple.springboard.home"]);

/**
 * The one place a bundle id becomes a word.
 *
 * A bundle id is the most machine-shaped string on the machine and does not
 * belong as the primary label under a live video. The last component,
 * title-cased, is a guess — so the full id is always in the tooltip beside it.
 */
export function appLabel(bundleId: string | null): string | null {
  if (bundleId === null || bundleId === "") return null;
  if (HOME_SCREEN_BUNDLES.has(bundleId.toLowerCase())) return null;
  const last = bundleId.split(".").filter((part) => part !== "").pop();
  if (last === undefined) return null;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

/** The sentence under the frame: *"Almanac on iPhone 17 Pro, iOS 26.5"*. */
export function metaLine(state: LiveState): string | null {
  const device = state.device;
  if (device === null) return null;
  const app = appLabel(state.foregroundBundleId);
  const where = `${device.name}, iOS ${device.osVersion}`;
  return app === null ? `Home screen on ${where}` : `${app} on ${where}`;
}

function bootAction(devices: DeviceList | null): Action[] {
  const suggested = devices?.suggested ?? null;
  if (suggested === null) return [];
  const alreadyBooted = devices?.bootedUdids.includes(suggested.udid) ?? false;
  // A button that tells you its consequence is one you can press without
  // opening a dropdown.
  return [
    {
      label: alreadyBooted ? `Watch ${suggested.name}` : `Boot ${suggested.name}`,
      kind: alreadyBooted ? "watch" : "boot",
      udid: suggested.udid,
    },
  ];
}

/**
 * What to render over the frame.
 *
 * Every non-streaming state is a centred sentence over a dimmed frame, never a
 * bare spinner. The one honest exception is first mount, where there is no
 * previous verdict to keep and *"No simulator is running"* would be a guess.
 */
export function liveVeil(
  state: LiveState | null,
  devices: DeviceList | null,
  /**
   * The browser could not load the stream.
   *
   * This is the only failure the server cannot see. The panel opens
   * `/stream?udid=…` in an `<img>`, and when that answers 409 — the simulator
   * shut down since the last poll — the element renders the browser's own
   * broken-image glyph and nothing else. The server still believes it is
   * `streaming`, so every server-derived veil stays silent, and the user is
   * left looking at a torn-page icon in a panel with no text on it.
   *
   * Reported at all is the fix. It outranks the server's opinion because it is
   * strictly newer: the request that failed happened after the poll that said
   * everything was fine.
   */
  streamFailed = false,
): Veil {
  const neutral = (sentence: string | null, actions: Action[] = [], detail: string | null = null): Veil => ({
    sentence,
    detail,
    tone: "neutral",
    actions,
    skeleton: false,
  });

  if (state === null) {
    return { sentence: null, detail: null, tone: "neutral", actions: [], skeleton: true };
  }

  if (streamFailed) {
    const name = state.device?.name ?? "The simulator";
    return {
      sentence: `${name} stopped sending frames.`,
      detail: "It has usually been shut down or erased by something else on this Mac.",
      tone: "dead",
      actions: [
        { label: "Check again", kind: "refresh" },
        ...(state.device === null
          ? []
          : [{ label: `Boot ${state.device.name}`, kind: "boot" as const, udid: state.device.udid }]),
      ],
      skeleton: false,
    };
  }

  const name = state.device?.name ?? "the simulator";

  switch (state.kind) {
    case "unsupported":
      return neutral(
        "Xcode Simulators drives Xcode and the iOS simulator, so it only works when the bb server itself runs on macOS.",
      );

    case "intel-blocked":
      return neutral(
        "Live mirroring has only ever been exercised on Apple silicon. The capture addon is a universal binary and will load on Intel, but its IOSurface path is untested there.",
        [{ label: "Open the doctor", kind: "doctor" }],
        "Stills work here — they only need xcodebuild. To try Live anyway, turn on allowIntelLive.",
      );

    case "intel-failed":
      return neutral(
        "Live could not start on this Intel Mac — the capture addon loaded but produced no frames. Stills still work.",
        [{ label: "Try again", kind: "retry" }],
      );

    case "simctl-failed":
      return neutral(
        "Xcode Simulators could not ask about simulators — `xcrun simctl list` failed.",
        [{ label: "Refresh", kind: "refresh" }],
        state.reason,
      );

    case "no-runtimes":
      return neutral(
        "No simulator runtimes are installed. Open Xcode → Settings → Components, download an iOS runtime, then press Refresh.",
        [{ label: "Refresh", kind: "refresh" }],
      );

    case "idle": {
      if (devices !== null && devices.error !== null) {
        return neutral(devices.error, [{ label: "Refresh", kind: "refresh" }]);
      }
      if (devices !== null && !devices.hasDrivableRuntime) {
        if (devices.installedPlatforms.length === 0) {
          return neutral(
            "No simulator runtimes are installed. Open Xcode → Settings → Components, download an iOS runtime, then press Refresh.",
            [{ label: "Refresh", kind: "refresh" }],
          );
        }
        // Naming what *is* installed is the difference between a dead end and a
        // fixable situation.
        return neutral(
          `Xcode Simulators's Live mode drives iOS, iPadOS and tvOS simulators. The only runtime installed here is ${joinWords(devices.installedPlatforms)}.`,
          [{ label: "Refresh", kind: "refresh" }],
        );
      }

      const booted = (devices?.devices ?? []).filter((device) =>
        devices?.bootedUdids.includes(device.udid),
      );
      if (booted.length > 0) {
        return neutral(
          `${joinWords(booted.map((device) => device.name))} ${booted.length === 1 ? "is" : "are"} already running.`,
          bootAction(devices),
        );
      }
      return neutral("No simulator is running.", bootAction(devices));
    }

    case "booting":
      // A promise the copy cannot keep reads as a hang, so it ages.
      return neutral(
        state.slowBoot
          ? "Still booting — a first boot after an Xcode update can take a few minutes."
          : `Booting ${name} — about twenty seconds the first time.`,
      );

    case "boot-failed":
      return {
        sentence: state.reason ?? `${name} did not boot.`,
        detail: null,
        tone: "dead",
        actions: [{ label: "Try again", kind: "retry", udid: state.device?.udid }],
        skeleton: false,
      };

    case "waiting-frame":
      // A real state, not a loading state: `/config` reports 0×0 until the first
      // MJPEG callback, and a spinner here reads as broken.
      return neutral("Waiting for the first frame.");

    case "streaming":
      return { sentence: null, detail: null, tone: "live", actions: [], skeleton: false };

    case "stalled":
      return {
        sentence: "The stream stopped. Checking the simulator.",
        detail: null,
        tone: "stalled",
        actions: [],
        skeleton: false,
      };

    case "host-restarted":
      // Without its own state this falls through to "the stream stopped,
      // checking the simulator", which blames a healthy device and sends the
      // user to shut it down and re-boot it.
      return state.crashes >= 2
        ? {
            sentence: "The capture process has crashed twice.",
            detail: "`bb plugin logs xcode-simulators` has the reason.",
            tone: "dead",
            actions: [{ label: "Try again", kind: "retry", udid: state.device?.udid }],
            skeleton: false,
          }
        : {
            sentence: `Xcode Simulators's capture process restarted. Reconnecting to ${name}.`,
            detail: null,
            tone: "stalled",
            actions: [],
            skeleton: false,
          };

    case "erasing":
      // Erase shuts the device down, so without its own state the panel says
      // "iPhone 17 Pro shut down" seconds after you asked it to erase, which
      // reads as a crash.
      return neutral(`Erasing ${name} — it will come back in a moment.`);

    case "dead":
      return {
        sentence: `${name} shut down.`,
        detail: null,
        tone: "dead",
        actions: [{ label: "Boot it again", kind: "boot", udid: state.device?.udid }],
        skeleton: false,
      };
  }
}

export const TONE_CLASS: Record<Tone, string> = {
  neutral: "bbxs-tone",
  live: "bbxs-tone bbxs-tone-live",
  stalled: "bbxs-tone bbxs-tone-stalled",
  dead: "bbxs-tone bbxs-tone-dead",
  exposed: "bbxs-tone bbxs-tone-exposed",
};
