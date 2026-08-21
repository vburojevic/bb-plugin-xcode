import { describe, expect, it } from "vitest";

import {
  runPhrase,
  runStatusLabel,
  statusIcon,
  statusLabel,
} from "../app/format";

describe("terminal process presentation", () => {
  /**
   * This state used to render as "Finished", chosen to avoid an "Unknown" that
   * read as the tracker malfunctioning. It solved that and created a worse
   * problem: finished *what*? Succeeded, failed, killed? Sitting one row above
   * a genuinely successful build labelled "Succeeded", "Finished" read as a
   * second word for the same thing.
   *
   * "No result" keeps the original intent — it does not accuse the tracker of
   * confusion — while stating the actual fact: the run started, it stopped, and
   * no verdict source ever said how it went.
   */
  it("admits it has no verdict rather than implying one", () => {
    expect(statusLabel("ended")).toBe("No result");
    expect(statusLabel("ended")).not.toBe("Finished");
    expect(statusIcon("ended")).toBe("CircleDashed");
  });

  /**
   * `finishing` stays in the model — it is the 45s window where the verdict
   * sources race — but showing the word made an already-stopped build look
   * like it was still working, for up to three quarters of a minute.
   */
  it("keeps showing the in-flight verb while a verdict is still landing", () => {
    expect(runStatusLabel({ status: "finishing", kind: "build" })).toBe("Building");
    expect(runStatusLabel({ status: "finishing", kind: "test" })).toBe("Testing");
    expect(runStatusLabel({ status: "running", kind: "test" })).toBe("Testing");
  });
});

describe("runPhrase", () => {
  const base = { scheme: "Packerly", container: null, root: null };

  it("leads with the verb while the work is happening", () => {
    expect(runPhrase({ ...base, status: "running", kind: "build" })).toEqual({
      name: "Packerly",
      verb: "Building",
      verbFirst: true,
    });
    expect(runPhrase({ ...base, status: "running", kind: "test" })).toEqual({
      name: "Packerly",
      verb: "Testing",
      verbFirst: true,
    });
  });

  it("trails the verb once the work is over, so it reads as a result", () => {
    for (const [status, verb] of [
      ["passed", "succeeded"],
      ["warnings", "succeeded"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ] as const) {
      expect(runPhrase({ ...base, status, kind: "build" })).toEqual({
        name: "Packerly",
        verb,
        verbFirst: false,
      });
    }
  });

  it("says outright when there is no outcome to report", () => {
    expect(runPhrase({ ...base, status: "ended", kind: "build" })).toEqual({
      name: "Packerly",
      verb: "— no result",
      verbFirst: false,
    });
  });

  // A build with warnings SUCCEEDED; the warning count carries the caveat.
  it("does not downgrade a warning build's headline", () => {
    expect(runPhrase({ ...base, status: "warnings", kind: "build" }).verb).toBe(
      "succeeded",
    );
  });
});
