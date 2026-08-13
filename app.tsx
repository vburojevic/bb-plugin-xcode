/**
 * Xcode activity tracker — frontend entry.
 *
 * Two surfaces:
 *
 *  - the left-sidebar nav panel (machine-wide history and trends);
 *  - a composer banner showing this thread's *live* builds as compact rows,
 *    in bb's own activity-row language. The host mounts it, so a build shows
 *    up whether or not the agent ever mentions it — see ActivityBanner.tsx for
 *    why that matters.
 *
 * Nothing is ever rendered into the conversation. An earlier design asked the
 * agent to echo a `::xcode{…}` directive so a card would appear in the
 * transcript; that surface is gone, and with it the entire class of bugs it
 * created — cards that never appeared, appeared three times, or appeared for a
 * 0ms `xcodebuild -find` lookup. Build status is host-owned chrome now.
 *
 * Per-thread header chrome stays deliberately absent too: a chip on every
 * thread was noise. The banner is not that — it appears only while something
 * is actually building, and disappears the moment nothing is.
 */

import { definePluginApp, useBbNavigate } from "@bb/plugin-sdk/app";

import "./app.css";

import { XcodeActivityBanner } from "./app/ActivityBanner";
import { XcodePanel } from "./app/XcodePanel";

import { SimulatorsPanel } from "./app/sim/SimulatorsPanel";
import { StillsDirective } from "./app/sim/StillsDirective";
import { ActivityBanner as SimulatorBanner } from "./app/sim/ActivityBanner";
import { ExposeControl } from "./app/sim/ExposeControl";
import { ExposeConsent } from "./app/sim/ExposeConsent";
import { DeviceBar } from "./app/sim/DeviceBar";
import { ThreadSimulator } from "./app/sim/ThreadSimulator";
import { useLive } from "./app/sim/useLive";
import { PANEL_PATH, subPathForTab, tabOf } from "./app/sim/route";

/**
 * The Simulators panel's header accessory.
 *
 * It reads from the same module-level store as the panel body — the host
 * renders this inside its own title bar, a separate React tree, and a
 * per-instance fetch here would double every `simctl` call the panel makes.
 */
function SimulatorsHeader({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const live = useLive();
  return (
    <DeviceBar
      tab={tabOf(subPath)}
      onTab={(tab) => navigate.toPluginPanel(PANEL_PATH, { subPath: subPathForTab(tab) })}
      state={live.state}
      devices={live.devices}
      onPick={(udid) => void live.start(udid)}
      exposure={<ExposeControl />}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "xcode",
    title: "Xcode",
    icon: "Toolbox",
    path: "xcode",
    component: XcodePanel,
  });
  app.slots.navPanel({
    id: "simulators",
    title: "Simulators",
    icon: "Smartphone",
    path: PANEL_PATH,
    component: SimulatorsPanel,
    headerContent: SimulatorsHeader,
  });

  /**
   * A simulator in the thread's own side panel.
   *
   * The nav panel is machine-wide and one-at-a-time; this is per thread, opens
   * beside the conversation, and picks its device from what the thread has
   * actually been doing — see `pickSimulator` in `src/sim/pick.ts`. `flush`
   * because the frame manages its own layout and must not be wrapped in the
   * host's padded scroll container.
   */
  app.slots.threadPanelAction({
    id: "simulator",
    title: "Open simulator",
    icon: "Smartphone",
    layout: "flush",
    component: ThreadSimulator,
  });

  // `::xcode-simulators{look="lk_…"}` — a deliberate record with no dismiss
  // control, which is why it needs states for a subject that is gone.
  app.slots.messageDirective({ id: "xcode-simulators", component: StillsDirective });

  // What `bb xcode sim expose` blocks on. An agent can run that command; it
  // cannot answer this — which is what makes "there is no simulator_expose
  // tool" enforcement rather than a note.
  app.slots.pendingInteraction({ id: "expose-consent", component: ExposeConsent });

  app.composer.customize({
    id: "simulators",
    banners: [{ id: "sim-activity", component: SimulatorBanner, chrome: "bare" }],
  });

  app.composer.customize({
    id: "xcode-activity",
    scopes: ["thread"],
    // `bare`, and for one measured reason: the host's `chrome: "card"` gives
    // the right frame but mounts it under a `display: contents` wrapper, and
    // the stack spaces itself with `space-y-2` — a margin rule that a
    // contents box silently drops. The banner therefore owns its own frame
    // (`.bbx-stack-card`, a faithful copy of PromptStackCard driven by the
    // host's own CSS variables) so it can also own the 8px gap.
    banners: [
      { id: "live-runs", chrome: "bare", component: XcodeActivityBanner },
    ],
  });
});
