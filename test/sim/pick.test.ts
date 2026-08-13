/**
 * Which simulator a thread means.
 *
 * Pure, so the ranking is provable without a Mac, a thread, or a build. The
 * cases that matter are the ones where two rungs disagree — that is the whole
 * reason the rungs are ordered.
 */
import { describe, expect, it } from "vitest";
import { pickSimulator, udidFromDestination, type PickCandidate } from "../../src/sim/pick.js";

const UDID = {
  a: "11111111-2222-3333-4444-555555555555",
  b: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  c: "99999999-8888-7777-6666-555555555555",
};

const device = (udid: string, over: Partial<PickCandidate> = {}): PickCandidate => ({
  udid,
  name: `Device ${udid.slice(0, 4)}`,
  osVersion: "26.5",
  booted: false,
  isAvailable: true,
  ...over,
});

/** Stands in for `pickDefaultDevice`: first by name, deterministically. */
const rank = (pool: readonly PickCandidate[]): PickCandidate | null =>
  [...pool].sort((a, b) => a.udid.localeCompare(b.udid))[0] ?? null;

const base = {
  runs: [],
  threadId: null,
  projectId: null,
  mirroring: null,
  rank,
} as const;

describe("udidFromDestination", () => {
  it("takes only a well-formed id, and never a device name", () => {
    expect(udidFromDestination(`platform=iOS Simulator,id=${UDID.a}`)).toBe(UDID.a);
    expect(udidFromDestination(`id=${UDID.a.toLowerCase()}`)).toBe(UDID.a);
    // A name can be shared by several simulators, and picking the wrong
    // "iPhone 17 Pro" is worse than falling through to a rung that cannot be
    // wrong about identity.
    expect(udidFromDestination("platform=iOS Simulator,name=iPhone 17 Pro")).toBeNull();
    // A physical device id is not a simulator UDID and must never resolve.
    expect(udidFromDestination("id=00008120-000A4D8E0A88401E")).toBeNull();
    expect(udidFromDestination("generic/platform=iOS Simulator")).toBeNull();
    expect(udidFromDestination(null)).toBeNull();
  });
});

describe("pickSimulator", () => {
  it("has nothing to say when there is nothing drivable", () => {
    expect(pickSimulator({ ...base, candidates: [] })).toBeNull();
    expect(
      pickSimulator({ ...base, candidates: [device(UDID.a, { isAvailable: false })] }),
    ).toBeNull();
  });

  it("prefers this thread's own last build over everything else", () => {
    const picked = pickSimulator({
      ...base,
      candidates: [device(UDID.a, { booted: true }), device(UDID.b)],
      // The booted one, the mirrored one and the best one all say A. The
      // thread built for B two minutes ago, so B wins.
      mirroring: UDID.a,
      threadId: "thr_1",
      runs: [
        { destination: `id=${UDID.b}`, startedAt: 2_000, threadId: "thr_1", projectId: "p1" },
        { destination: `id=${UDID.a}`, startedAt: 3_000, threadId: "thr_2", projectId: "p1" },
      ],
    });
    expect(picked?.device.udid).toBe(UDID.b);
    expect(picked?.reason).toBe("thread-build");
    expect(picked?.because).toBe("the device this thread last built for");
  });

  it("takes the newest build within a thread, not merely the first match", () => {
    const picked = pickSimulator({
      ...base,
      candidates: [device(UDID.a), device(UDID.b)],
      threadId: "thr_1",
      runs: [
        { destination: `id=${UDID.a}`, startedAt: 1_000, threadId: "thr_1", projectId: null },
        { destination: `id=${UDID.b}`, startedAt: 9_000, threadId: "thr_1", projectId: null },
      ],
    });
    expect(picked?.device.udid).toBe(UDID.b);
  });

  it("falls to the project when the thread has never built", () => {
    const picked = pickSimulator({
      ...base,
      candidates: [device(UDID.a), device(UDID.b)],
      threadId: "thr_new",
      projectId: "p1",
      runs: [{ destination: `id=${UDID.b}`, startedAt: 1, threadId: "thr_other", projectId: "p1" }],
    });
    expect(picked?.reason).toBe("project-build");
    expect(picked?.device.udid).toBe(UDID.b);
  });

  it("ignores a build whose simulator has since been deleted", () => {
    const picked = pickSimulator({
      ...base,
      candidates: [device(UDID.a, { booted: true })],
      threadId: "thr_1",
      runs: [{ destination: `id=${UDID.c}`, startedAt: 1, threadId: "thr_1", projectId: null }],
    });
    // Not "thread-build" against a device that is not there any more.
    expect(picked?.reason).toBe("only-booted");
    expect(picked?.device.udid).toBe(UDID.a);
  });

  it("does not open a second surface onto a different device than the one on screen", () => {
    const picked = pickSimulator({
      ...base,
      candidates: [device(UDID.a), device(UDID.b, { booted: true })],
      mirroring: UDID.a,
    });
    expect(picked?.reason).toBe("mirrored");
    expect(picked?.device.udid).toBe(UDID.a);
  });

  it("calls one booted simulator unambiguous, and several a ranking", () => {
    const one = pickSimulator({
      ...base,
      candidates: [device(UDID.b, { booted: true }), device(UDID.a)],
    });
    expect(one?.reason).toBe("only-booted");
    expect(one?.device.udid).toBe(UDID.b);

    const several = pickSimulator({
      ...base,
      candidates: [device(UDID.b, { booted: true }), device(UDID.a, { booted: true })],
    });
    expect(several?.reason).toBe("best-booted");
    expect(several?.device.udid).toBe(UDID.a);
  });

  it("offers a shut-down simulator last, and says so", () => {
    const picked = pickSimulator({ ...base, candidates: [device(UDID.a), device(UDID.b)] });
    expect(picked?.reason).toBe("best-available");
    expect(picked?.device.booted).toBe(false);
    expect(picked?.because).toBe("the newest simulator available");
  });
});
