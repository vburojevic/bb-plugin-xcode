/**
 * The transport's rules, proven: one batch in flight, everything accumulates
 * behind it in order, no sample loses its timestamp, and a failed send drops
 * the gesture — with a recovery lift — rather than delivering half of one.
 */
import { describe, expect, it } from "vitest";
import { MAX_BACKLOG, MAX_BATCH, TouchChannel, type StreamEvent } from "../../app/sim/touch-channel.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const touch = (phase: "begin" | "move" | "end", x: number, y: number, t = 0): StreamEvent => ({
  kind: "touch",
  phase,
  x,
  y,
  t,
});

/** A send that resolves immediately and remembers every batch. */
function immediate() {
  const batches: StreamEvent[][] = [];
  const send = async (events: StreamEvent[]): Promise<void> => {
    batches.push(events);
  };
  return { batches, send };
}

/** A send whose completions the test controls one at a time. */
class GatedTransport {
  batches: StreamEvent[][] = [];
  private resolvers: Array<() => void> = [];
  send = (events: StreamEvent[]): Promise<void> => {
    this.batches.push(events);
    return new Promise((resolve) => this.resolvers.push(resolve));
  };
  /** Resolve every in-flight send, then let the pump run. */
  async drain(): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      for (const resolve of this.resolvers.splice(0)) resolve();
      await tick();
    }
  }
}

describe("the touch channel", () => {
  it("delivers a tap as begin then end, in order", async () => {
    const { batches, send } = immediate();
    const channel = new TouchChannel(send);
    channel.push(touch("begin", 0.2, 0.8, 100));
    channel.push(touch("end", 0.2, 0.8, 180));
    await tick();
    await tick();
    expect(batches.flat()).toEqual([touch("begin", 0.2, 0.8, 100), touch("end", 0.2, 0.8, 180)]);
  });

  it("accumulates everything behind the in-flight batch, losing no sample", async () => {
    const transport = new GatedTransport();
    const channel = new TouchChannel(transport.send);

    channel.push(touch("begin", 0.5, 0.5, 0));
    // The begin is in flight; the whole trail queues behind it. The old
    // channel collapsed these to the freshest — and iOS computes flick
    // momentum from exactly the samples that collapse threw away.
    channel.push(touch("move", 0.5, 0.6, 8));
    channel.push(touch("move", 0.5, 0.7, 16));
    channel.push(touch("move", 0.5, 0.8, 24));
    expect(channel.pending).toBe(3);

    await transport.drain();
    expect(transport.batches).toEqual([
      [touch("begin", 0.5, 0.5, 0)],
      [touch("move", 0.5, 0.6, 8), touch("move", 0.5, 0.7, 16), touch("move", 0.5, 0.8, 24)],
    ]);
  });

  it("keeps exactly one batch in flight — order needs no transport guarantee", async () => {
    const transport = new GatedTransport();
    const channel = new TouchChannel(transport.send);

    channel.push(touch("begin", 0.5, 0.5, 0));
    channel.push(touch("move", 0.1, 0.1, 8));
    channel.push(touch("end", 0.1, 0.1, 16));
    // Only the first send has gone out; the rest wait for it.
    expect(transport.batches).toHaveLength(1);

    await transport.drain();
    expect(transport.batches).toHaveLength(2);
    expect(transport.batches.flat().map((event) => (event as { phase: string }).phase)).toEqual([
      "begin",
      "move",
      "end",
    ]);
  });

  it("splits an oversized backlog at the contract's cap", async () => {
    const transport = new GatedTransport();
    const channel = new TouchChannel(transport.send);
    channel.push(touch("begin", 0.5, 0.5, 0));
    for (let i = 0; i < MAX_BATCH + 10; i += 1) {
      channel.push(touch("move", 0.5, 0.5, i));
    }
    await transport.drain();
    for (const batch of transport.batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_BATCH);
    }
  });

  it("thins moves — never boundaries — when the backlog says the link is dead", async () => {
    const transport = new GatedTransport();
    const channel = new TouchChannel(transport.send);
    channel.push(touch("begin", 0.5, 0.5, 0));
    for (let i = 0; i < MAX_BACKLOG + 40; i += 1) {
      channel.push(touch("move", 0.5, 0.5, i));
    }
    channel.push(touch("end", 0.5, 0.5, 9999));
    expect(channel.pending).toBeLessThanOrEqual(MAX_BACKLOG + 2);

    await transport.drain();
    const flat = transport.batches.flat() as Array<{ phase: string }>;
    expect(flat[0]!.phase).toBe("begin");
    expect(flat.at(-1)!.phase).toBe("end");
  });

  it("drops the rest of a failed gesture, lifts the finger, and recovers on the next begin", async () => {
    const errors: string[] = [];
    const batches: StreamEvent[][] = [];
    let broken = true;
    const channel = new TouchChannel(
      async (events) => {
        if (broken) throw new Error("socket dead");
        batches.push(events);
      },
      () => errors.push("failed"),
    );

    channel.push(touch("begin", 0.5, 0.5, 0));
    channel.push(touch("move", 0.6, 0.6, 8));
    await tick();
    await tick();

    // The begin failed. The gesture is dead, the panel was told once, and a
    // recovery lift went out in case the batch was delivered but the response
    // lost — an orphan end is dropped server-side, a missing one is five
    // seconds of dead input.
    expect(errors).toEqual(["failed"]);
    expect(channel.pending).toBe(0);

    // Moves and ends of the broken gesture go nowhere.
    channel.push(touch("move", 0.7, 0.7, 16));
    channel.push(touch("end", 0.7, 0.7, 24));
    await tick();
    expect(batches).toEqual([]);

    // The channel is not poisoned: the next gesture works.
    broken = false;
    channel.push(touch("begin", 0.1, 0.1, 40));
    channel.push(touch("end", 0.1, 0.1, 90));
    await tick();
    await tick();
    expect(batches.flat()).toEqual([touch("begin", 0.1, 0.1, 40), touch("end", 0.1, 0.1, 90)]);
  });

  it("sends the recovery lift for the gesture that was actually down", async () => {
    const sent: StreamEvent[][] = [];
    let fail = false;
    const channel = new TouchChannel(async (events) => {
      if (fail) {
        fail = false;
        throw new Error("gone");
      }
      sent.push(events);
    });

    channel.push({ kind: "multi", phase: "begin", x1: 0.4, y1: 0.4, x2: 0.6, y2: 0.6, t: 0 });
    await tick();
    fail = true;
    channel.push({ kind: "multi", phase: "move", x1: 0.3, y1: 0.3, x2: 0.7, y2: 0.7, t: 8 });
    await tick();
    await tick();

    // The lift is a multi end — a single-finger end would leave the second
    // finger on the glass.
    const last = sent.flat().at(-1) as { kind: string; phase: string };
    expect(last.kind).toBe("multi");
    expect(last.phase).toBe("end");
  });

  it("lets scrolls flow while a broken gesture is being dropped", async () => {
    const batches: StreamEvent[][] = [];
    let broken = true;
    const channel = new TouchChannel(async (events) => {
      if (broken) throw new Error("dead");
      batches.push(events);
    });

    channel.push(touch("begin", 0.5, 0.5, 0));
    await tick();
    await tick();
    broken = false;

    // Scrolls are stateless: nothing about the dead drag makes them wrong.
    channel.push({ kind: "scroll", dx: 0, dy: 0.2, t: 20 });
    await tick();
    await tick();
    expect(batches.flat()).toEqual([{ kind: "scroll", dx: 0, dy: 0.2, t: 20 }]);
  });
});
