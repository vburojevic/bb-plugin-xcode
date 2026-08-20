/**
 * The line a run's Facts carries about how it built. `xcode-plugin` remains a
 * read-only compatibility value for looks persisted by older releases; new
 * runs always use the fixed direct xcodebuild driver.
 */
export function describeBuildPath(via: "xcode-plugin" | "xcodebuild"): string {
  return via === "xcode-plugin"
    ? "Built via the legacy Xcode-plugin delegation path."
    : "Built with the plugin's fixed xcodebuild driver.";
}
