import { describe, expect, it } from "vitest";

import { checkoutHostMismatch } from "../src/build-security";

const HOSTS = [
  { id: "host_server", name: "Vedrans-MacBook-Pro" },
  { id: "host_other", name: "scw-mini" },
];

describe("checkoutHostMismatch", () => {
  it("allows a checkout on the machine running the plugin", () => {
    expect(checkoutHostMismatch({ hostId: "host_server" }, "host_server", HOSTS)).toBeNull();
  });

  it("refuses a checkout on another host and names that host", () => {
    const refusal = checkoutHostMismatch({ hostId: "host_other" }, "host_server", HOSTS);
    expect(refusal).toContain("scw-mini");
    // The point of the fix: an actionable sentence, never a bare ENOENT.
    expect(refusal).not.toContain("ENOENT");
  });

  it("falls back to a generic name when the host is not in the list", () => {
    const refusal = checkoutHostMismatch({ hostId: "host_ghost" }, "host_server", HOSTS);
    expect(refusal).toContain("another machine");
  });

  it("stays out of the way when either host is unknown", () => {
    // Never refuse a working single-machine setup just because identity is
    // unresolved — that would be a regression for every existing user.
    expect(checkoutHostMismatch({ hostId: null }, "host_server", HOSTS)).toBeNull();
    expect(checkoutHostMismatch({ hostId: "host_other" }, null, HOSTS)).toBeNull();
  });
});
