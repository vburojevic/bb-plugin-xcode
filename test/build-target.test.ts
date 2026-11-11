/**
 * Which machine a thread's tracked build runs on.
 *
 * It used to be "this one, or a refusal": a checkout on another enrolled Mac
 * got a sentence telling the user to go and build there by hand. Now it is
 * routed to that Mac's host worker, and the failure mode that matters is the
 * opposite one — a single-machine setup must never be sent anywhere.
 */
import { describe, expect, it } from "vitest";

import { buildTargetFor } from "../src/launcher";

const HOSTS = [
  { id: "host_server", name: "MacMini" },
  { id: "host_other", name: "MacBook Pro" },
];

describe("buildTargetFor", () => {
  it("builds a checkout on the machine running bb right here", () => {
    expect(buildTargetFor({ hostId: "host_server" }, "host_server", HOSTS)).toEqual({
      kind: "local",
      machineName: "MacMini",
    });
  });

  it("routes a checkout on another Mac to that Mac, by name", () => {
    expect(buildTargetFor({ hostId: "host_other" }, "host_server", HOSTS)).toEqual({
      kind: "remote",
      hostId: "host_other",
      machineName: "MacBook Pro",
    });
  });

  it("still routes to a Mac bb has not named, under its id", () => {
    expect(buildTargetFor({ hostId: "host_ghost" }, "host_server", HOSTS)).toEqual({
      kind: "remote",
      hostId: "host_ghost",
      machineName: "host_ghost",
    });
  });

  it("stays local when either identity is unknown", () => {
    // The single-machine setup every existing user has must never be sent to
    // a worker because an identity failed to resolve.
    expect(buildTargetFor({ hostId: null }, "host_server", HOSTS).kind).toBe("local");
    expect(buildTargetFor({ hostId: "host_other" }, null, HOSTS).kind).toBe("local");
  });
});

describe("the Simulators half on a thread whose checkout is on another Mac", () => {
  it("still refuses Stills there, and says tracked builds do work", async () => {
    const { describeCheckoutLocation, locateCheckout } = await import("../src/sim/hostcheck");
    const sentence = describeCheckoutLocation(locateCheckout("host_server", "host_other", HOSTS));
    expect(sentence).toBe(
      "This thread's checkout lives on MacBook Pro, but Stills renders on the machine running bb. " +
        "Tracked builds (xcode_build, bb xcode run) do run on MacBook Pro.",
    );
    expect(describeCheckoutLocation(locateCheckout("host_server", "host_server", HOSTS))).toBeNull();
  });
});
