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

import { definePluginApp } from "@bb/plugin-sdk/app";

import "./app.css";

import { XcodeActivityBanner } from "./app/ActivityBanner";
import { XcodePanel } from "./app/XcodePanel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "xcode",
    title: "Xcode",
    icon: "Toolbox",
    path: "xcode",
    component: XcodePanel,
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
