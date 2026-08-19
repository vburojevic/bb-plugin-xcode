/**
 * The touch transport's two rules, proven: boundaries are never dropped or
 * reordered, and moves are latest-wins while a send is in flight.
 */
import { describe, expect, it } from "vitest";
import { TouchChannel, type TouchEvent, type TouchPhase } from "../../app/sim/touch-channel.js";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A send that resolves immediately and remembers everything. */
function immediate() {
  const sent: TouchEvent[] = [];
  const send = async (phase: TouchPhase, x: number, y: number): Promise<void> => {
    sent.push({ phase, x, y });
  };
  return { sent, send };
}

/** A send whose completions the test controls one at a time. */
class GatedTransport {
  sent: TouchEvent[] = [];
  private resolvers: Array<() => void> = [];
  send = (phase: TouchPhase, x: number, y: number): Promise<void> => {
    this.sent.push({ phase, x, y });
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
  it("delivers a tap as exactly begin then end", async () => {
    const { sent, send } = immediate();
    const channel = new TouchChannel(send);
    channel.push("begin", 0.2, 0.8);
    channel.push("end", 0.2, 0.8);
    await tick();
    await tick();
    expect(sent).toEqual([
      { phase: "begin", x: 0.2, y: 0.8 },
      { phase: "end", x: 0.2, y: 0.8 },
    ]);
  });

  it("collapses moves to the freshest while a send is in flight", async () => {
    const transport = new GatedTransport();
    const channel = new TouchChannel(transport.send);

    channel.push("begin", 0.5, 0.5);
    // The begin is in flight; these moves queue and collapse.
    channel.push("move", 0.5, 0.6);
    channel.push("move", 0.5, 0.7);
    channel.push("move", 0.5, 0.8);
    expect(channel.pending).toBe(1);

    await transport.drain();
    expect(transport.sent).toEqual([
      { phase: "begin", x: 0.5, y: 0.5 },
      { phase: "move", x: 0.5, y: 0.8 },
    ]);
  });

  it("never collapses an end into the move before it", async () => {
    const transport = new GatedTransport();
    const channel = new TouchChannel(transport.send);

    channel.push("begin", 0.5, 0.5);
    channel.push("move", 0.5, 0.6);
    channel.push("move", 0.5, 0.7);
    channel.push("end", 0.5, 0.7);

    await transport.drain();
    expect(transport.sent).toEqual([
      { phase: "begin", x: 0.5, y: 0.5 },
      { phase: "move", x: 0.5, y: 0.7 },
      { phase: "end", x: 0.5, y: 0.7 },
    ]);
  });

  it("sends immediately once the pipe is empty, and keeps order across drags", async () => {
    const transport = new GatedTransport();
    const channel = new TouchChannel(transport.send);

    channel.push("begin", 0.5, 0.5);
    channel.push("move", 0.1, 0.1);
    await transport.drain();

    // The queue is empty, so the next move starts its own send immediately —
    // latest-wins only collapses moves stuck *behind* an in-flight send.
    channel.push("move", 0.2, 0.2);
    channel.push("move", 0.3, 0.3);
    await transport.drain();

    expect(transport.sent).toEqual([
      { phase: "begin", x: 0.5, y: 0.5 },
      { phase: "move", x: 0.1, y: 0.1 },
      { phase: "move", x: 0.2, y: 0.2 },
      { phase: "move", x: 0.3, y: 0.3 },
    ]);
  });

  it("drops the rest of a gesture whose send fails, and recovers for the next", async () => {
    const errors: string[] = [];
    const sent: TouchEvent[] = [];
    let broken = true;
    const channel = new TouchChannel(
      async (phase, x, y) => {
        if (broken) throw new Error("socket dead");
        sent.push({ phase, x, y });
      },
      () => errors.push("failed"),
    );

    channel.push("begin", 0.5, 0.5);
    channel.push("move", 0.6, 0.6);
    channel.push("end", 0.7, 0.7);
    await tick();
    await tick();

    // The begin failed, so the move and end were meaningless and went nowhere.
    expect(sent).toEqual([]);
    expect(errors).toEqual(["failed"]);
    expect(channel.pending).toBe(0);

    // The channel is not poisoned: the next gesture works.
    broken = false;
    channel.push("begin", 0.1, 0.1);
    channel.push("end", 0.1, 0.1);
    await tick();
    await tick();
    expect(sent).toEqual([
      { phase: "begin", x: 0.1, y: 0.1 },
      { phase: "end", x: 0.1, y: 0.1 },
    ]);
  });
});
