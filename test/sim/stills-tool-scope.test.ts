import type { PluginAgentToolContext } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { Ctx, ThreadScope } from "../../src/sim/context.js";
import { makeStillsTool } from "../../src/sim/tools.js";

const caller: PluginAgentToolContext = {
  threadId: "thread-app",
  projectId: "project-app",
  signal: new AbortController().signal,
};
const scope: ThreadScope = {
  projectId: caller.projectId,
  checkoutElsewhere: null,
  scope: {
    scopeKey: "app", repoKey: "app", repoKeySource: "project", subPath: ".",
    checkoutPath: "/worktrees/calling-thread/App",
  },
};

function fixture() {
  const run = vi.fn(async () => ({
    lookId: null, status: "unchanged", sentence: "No changes.",
    rekey: null, truncation: null, rows: [],
  }));
  // Model the dangerous default: a null thread resolves to an unrelated project.
  const scopeForThread = vi.fn(async (threadId: string | null) =>
    threadId === caller.threadId ? scope :
      threadId === null ? { ...scope, projectId: "unrelated-project" } : null,
  );
  const settings = vi.fn(() => ({ allowAgentCapture: true }));
  const tool = makeStillsTool({ settings, scopeForThread, stills: { run } } as unknown as Ctx);
  return { tool, run, scopeForThread, settings };
}

describe("simulator_stills calling scope", () => {
  it("renders the calling thread checkout and forwards the device", async () => {
    const f = fixture();
    const result = await f.tool.execute({ device: "iPhone" }, caller);
    expect(result.isError).not.toBe(true);
    expect(f.scopeForThread).toHaveBeenCalledExactlyOnceWith(caller.threadId);
    expect(f.run).toHaveBeenCalledExactlyOnceWith(scope, "iPhone");
  });

  it.each([undefined, {}, { threadId: "", projectId: caller.projectId },
    { threadId: "  ", projectId: caller.projectId }, { threadId: caller.threadId }])(
    "refuses missing caller context without resolving a default: %j", async (context) => {
      const f = fixture();
      const result = await f.tool.execute({}, context as PluginAgentToolContext);
      expect(result.isError).toBe(true);
      expect(f.scopeForThread).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("refuses an unresolved thread without running previews", async () => {
    const f = fixture();
    expect((await f.tool.execute({}, { ...caller, threadId: "unknown" })).isError).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("refuses a scope belonging to another project", async () => {
    const f = fixture();
    expect((await f.tool.execute({}, { ...caller, projectId: "other" })).isError).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("reports resolution failure without running previews", async () => {
    const f = fixture();
    f.scopeForThread.mockRejectedValueOnce(new Error("Thread unavailable"));
    expect((await f.tool.execute({}, caller)).isError).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("honors revoked capture access before resolving the scope", async () => {
    const f = fixture();
    f.settings.mockReturnValue({ allowAgentCapture: false });
    expect((await f.tool.execute({}, caller)).isError).toBe(true);
    expect(f.scopeForThread).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
});
