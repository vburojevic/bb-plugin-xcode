/**
 * The nav panel's route segment, in one place.
 *
 * `navPanel` owns `/plugins/<pluginId>/<path>/*`, and `toPluginPanel` takes the
 * same `<path>`. Two literals that must agree is one literal.
 *
 * One panel now carries both halves, so the subPath namespace is shared:
 *
 *   ""                              → Builds (the tracker's home)
 *   "<runId>"                       → Builds, with that run selected
 *   "live"                          → the live simulator
 *   "doctor"                        → every prerequisite and its fix
 *   "stills"                        → the latest Stills run
 *   "stills/<lookId>[/<identity>]"  → one run, or one preview's filmstrip
 *
 * Run ids are `r:`-prefixed opaque strings, so they can never collide with
 * the three literal segments — and anything unrecognised reads as Builds,
 * which is where an old or malformed deep link does the least harm.
 */
export const PANEL_PATH = "xcode";

export type Tab = "builds" | "live" | "stills";

/** `subPath` → which tab is showing. The doctor lives under Live's roof. */
export function tabOf(subPath: string): Tab {
  if (subPath.startsWith("stills")) return "stills";
  if (subPath === "live" || subPath === "doctor") return "live";
  return "builds";
}

export function subPathForTab(tab: Tab): string {
  switch (tab) {
    case "stills":
      return "stills";
    case "live":
      return "live";
    default:
      return "";
  }
}
