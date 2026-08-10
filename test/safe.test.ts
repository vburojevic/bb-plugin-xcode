/**
 * The plugin must never take the bb server down.
 *
 * It did once, measurably: a wrapped build's stream tail called
 * `bb.realtime.publish` after a reload, the stale handle threw
 * PluginContextStaleError from a detached continuation, and Node raised it as
 * an uncaughtException — killing the server, not just this plugin
 * (`process-server-uncaughtException-2026-08-10T07-11-28`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detach, safely } from "../src/safe";

const stale = (): never => {
  throw Object.assign(new Error("stale handle"), {
    name: "PluginContextStaleError",
  });
};

describe("safely", () => {
  it("passes arguments through while live", () => {
    const seen: unknown[] = [];
    const call = safely(
      () => false,
      (value: string) => {
        seen.push(value);
      },
    );
    call("published");
    expect(seen).toEqual(["published"]);
  });

  it("is a no-op once disposed, without calling through", () => {
    let calls = 0;
    let disposed = false;
    const call = safely(
      () => disposed,
      () => {
        calls += 1;
      },
    );
    call();
    disposed = true;
    call();
    expect(calls).toBe(1);
  });

  it("swallows a handle that goes stale between the check and the call", () => {
    // The real race: still live at the guard, torn down by the time the host
    // validates the handle. This is the exact throw that killed the server.
    const call = safely(() => false, stale);
    expect(() => call()).not.toThrow();
  });
});

describe("detach", () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };

  beforeEach(() => {
    rejections.length = 0;
    process.on("unhandledRejection", onRejection);
  });
  afterEach(() => {
    process.off("unhandledRejection", onRejection);
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it("contains a rejection from detached work", async () => {
    detach(async () => {
      throw new Error("build fold failed");
    });
    await settle();
    expect(rejections).toEqual([]);
  });

  it("reports the error to the handler", async () => {
    const seen: unknown[] = [];
    detach(
      async () => {
        throw new Error("boom");
      },
      (error) => seen.push(error),
    );
    await settle();
    expect(seen).toHaveLength(1);
  });

  it("survives a reporter that itself throws — the fatal shape", async () => {
    // A stale `bb.log.warn` inside the catch is what turns a handled failure
    // into an uncaught exception.
    detach(async () => {
      throw new Error("boom");
    }, stale);
    await settle();
    expect(rejections).toEqual([]);
  });

  it("contains a synchronous throw in the work factory", async () => {
    detach(() => {
      throw new Error("threw before returning a promise");
    });
    await settle();
    expect(rejections).toEqual([]);
  });
});
