/**
 * The nav panel's route segment, in one place.
 *
 * `navPanel` owns `/plugins/<pluginId>/<path>/*`, and `toPluginPanel` takes the
 * same `<path>`. Two literals that must agree is one literal.
 */
export const PANEL_PATH = "simulators";

export type Tab = "live" | "stills";

/** `subPath` → which tab is showing. */
export function tabOf(subPath: string): Tab {
  return subPath.startsWith("stills") ? "stills" : "live";
}

export function subPathForTab(tab: Tab): string {
  return tab === "stills" ? "stills" : "";
}
