import { describe, expect, it } from "vitest";

import { statusHint, statusIcon, statusLabel } from "../app/format";

describe("terminal process presentation", () => {
  it("presents a verdict-less ended run as finished without unknown treatment", () => {
    expect(statusLabel("ended")).toBe("Finished");
    expect(statusHint("ended")).toBeNull();
    expect(statusIcon("ended")).toBe("CircleDashed");
  });
});
