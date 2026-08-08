/**
 * Xcode activity tracker — frontend entry.
 *
 * One surface, deliberately: the left-sidebar nav panel. Per-thread chrome
 * (header chips, thread-panel tabs) was removed — build state is machine-wide,
 * not thread-scoped, and a chip on every thread was noise.
 */

import { definePluginApp } from "@bb/plugin-sdk/app";

import "./app.css";

import { XcodePanel } from "./app/XcodePanel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "xcode",
    title: "Xcode",
    icon: "Toolbox",
    path: "xcode",
    component: XcodePanel,
  });
});
