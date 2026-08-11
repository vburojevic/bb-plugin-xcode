import { describe, expect, it } from "vitest";

import { dominantPhase, primarySourceFile } from "../src/proc";
import type { BuildPhase } from "../src/types";

const set = (...phases: BuildPhase[]) => new Set<BuildPhase>(phases);

describe("dominantPhase", () => {
  it("reports nothing when no worker is running", () => {
    expect(dominantPhase(set())).toBeNull();
  });

  it("reports the single phase in flight", () => {
    expect(dominantPhase(set("compiling"))).toBe("compiling");
    expect(dominantPhase(set("testing"))).toBe("testing");
  });

  /**
   * Targets finish at different times, so a build routinely has compilers and
   * a linker alive at once. Reporting "compiling" then understates how far
   * along it is — the frontier is the truer answer.
   */
  it("takes the latest phase when several overlap", () => {
    expect(dominantPhase(set("compiling", "linking"))).toBe("linking");
    expect(dominantPhase(set("compiling", "assets", "signing"))).toBe("signing");
    expect(dominantPhase(set("linking", "compiling"))).toBe("linking");
  });
});

describe("primarySourceFile", () => {
  it("reads swift-frontend's explicit primary file", () => {
    expect(
      primarySourceFile(
        "/usr/bin/swift-frontend -frontend -c -primary-file /a/b/LocationCard.swift -module-name Otto",
      ),
    ).toBe("LocationCard.swift");
  });

  it("reads clang's single source argument", () => {
    expect(
      primarySourceFile("/usr/bin/clang -x objective-c -c /a/b/Bridge.m -o /t/Bridge.o"),
    ).toBe("Bridge.m");
  });

  /**
   * A wrong filename in the row is worse than none — it would name a file the
   * build is not on. Anything ambiguous returns null.
   */
  it("declines to guess", () => {
    // Several sources in one invocation: no single answer.
    expect(primarySourceFile("/usr/bin/clang -c /a/One.m /a/Two.m")).toBeNull();
    // Not a compiler at all.
    expect(primarySourceFile("/usr/bin/ld -o /t/App /t/One.o")).toBeNull();
    expect(primarySourceFile("/bin/sh ./scripts/build_app.sh build")).toBeNull();
    expect(primarySourceFile("")).toBeNull();
  });
});
