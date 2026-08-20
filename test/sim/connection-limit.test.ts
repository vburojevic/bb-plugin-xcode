import { describe, expect, it } from "vitest";
import {
  ConnectionLimit,
  MAX_PANEL_PRESENCES,
  MAX_PANEL_STREAMS,
} from "../../src/sim/connection-limit.js";

describe("private simulator connection ceilings", () => {
  it("allows four streams and refuses the fifth until one closes", () => {
    expect(MAX_PANEL_STREAMS).toBe(4);
    const limit = new ConnectionLimit(MAX_PANEL_STREAMS);
    const releases = Array.from({ length: MAX_PANEL_STREAMS }, () => limit.tryAcquire());

    expect(releases.every((release) => release !== null)).toBe(true);
    expect(limit.active).toBe(4);
    expect(limit.tryAcquire()).toBeNull();

    releases[0]?.();
    expect(limit.active).toBe(3);
    expect(limit.tryAcquire()).not.toBeNull();
  });

  it("uses an independent four-connection budget for presence", () => {
    expect(MAX_PANEL_PRESENCES).toBe(4);
    const streams = new ConnectionLimit(MAX_PANEL_STREAMS);
    const presence = new ConnectionLimit(MAX_PANEL_PRESENCES);

    for (let index = 0; index < 4; index += 1) expect(streams.tryAcquire()).not.toBeNull();
    expect(streams.tryAcquire()).toBeNull();
    expect(presence.tryAcquire()).not.toBeNull();
  });

  it("makes release idempotent so duplicate socket events cannot underflow", () => {
    const limit = new ConnectionLimit(1);
    const release = limit.tryAcquire();
    expect(release).not.toBeNull();

    release?.();
    release?.();
    expect(limit.active).toBe(0);
    expect(limit.tryAcquire()).not.toBeNull();
  });
});
