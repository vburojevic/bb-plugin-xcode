import { describe, expect, it } from "vitest";

import { isNoiseRun } from "../src/model";

describe("isNoiseRun", () => {
  const build = { kind: "build" as const, scheme: "App", root: "/dd" };

  /**
   * `xcodebuild -find node` / `-version`: real processes, tracked correctly,
   * but nothing anyone waits on. They resolve neither a scheme nor a
   * derived-data root, which is what separates them from a build.
   *
   * This rule used to live only in the banner component, and the split caused
   * a real bug: the server picked the newest settled run without it, a `-find`
   * lookup took that slot, and the component then filtered it out — so the
   * genuine result it was standing in front of never rendered at all.
   */
  it("recognises a toolchain lookup", () => {
    expect(isNoiseRun({ kind: "unknown", scheme: null, root: null })).toBe(true);
  });

  it("keeps anything that resolved a scheme or a derived-data root", () => {
    expect(isNoiseRun(build)).toBe(false);
    expect(isNoiseRun({ kind: "unknown", scheme: "App", root: null })).toBe(false);
    expect(isNoiseRun({ kind: "unknown", scheme: null, root: "/dd" })).toBe(false);
  });

  it("treats package resolution and indexing as noise", () => {
    expect(isNoiseRun({ ...build, kind: "package" })).toBe(true);
    expect(isNoiseRun({ ...build, kind: "index" })).toBe(true);
  });
});
