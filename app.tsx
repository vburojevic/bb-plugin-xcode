/**
 * Xcode activity tracker — frontend entry.
 *
 * Two surfaces: the left-sidebar nav panel (machine-wide history and trends),
 * and the `::xcode{…}` message directive — a live status card agents drop
 * into chat, scoped to the enclosing thread's checkout. Per-thread chrome
 * (header chips, thread-panel tabs) stays deliberately absent: a chip on
 * every thread was noise, a card in the conversation that asked for it is
 * signal.
 */

import { definePluginApp } from "@bb/plugin-sdk/app";

import "./app.css";

import { XcodeChatCard } from "./app/ChatCard";
import { XcodePanel } from "./app/XcodePanel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "xcode",
    title: "Xcode",
    icon: "Toolbox",
    path: "xcode",
    component: XcodePanel,
  });
  app.slots.messageDirective({ id: "xcode", component: XcodeChatCard });
});
