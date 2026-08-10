import { describe, expect, it } from "vitest";

import { backgroundCommandOutcomes } from "../src/thread-outcome";

function command(seq: number, id: string, text: string) {
  return {
    id: `evt_${seq}`,
    seq,
    createdAt: 1_000_000 + seq,
    type: "item/started",
    data: {
      item: {
        type: "commandExecution",
        id,
        command: text,
        cwd: "/tmp/proj",
        status: "pending",
      },
    },
  };
}

function completed(
  seq: number,
  parentToolCallId: string,
  summary: string | undefined,
  status: "completed" | "failed" | "interrupted" = "completed",
  taskStatus: "completed" | "failed" | "killed" | "stopped" = "completed",
) {
  return {
    id: `evt_${seq}`,
    seq,
    createdAt: 1_100_000 + seq,
    type: "item/backgroundTask/completed",
    data: {
      item: {
        type: "backgroundTask",
        id: `task_${seq}`,
        status,
        taskStatus,
        summary,
        parentToolCallId,
      },
    },
  };
}

describe("backgroundCommandOutcomes", () => {
  it("links a background task to its command and parses an explicit success", () => {
    const outcomes = backgroundCommandOutcomes([
      command(1, "tool_1", "xcodebuildmcp simulator build"),
      completed(2, "tool_1", 'Background command "Build" completed (exit code 0)'),
    ]);

    expect(outcomes).toEqual([
      expect.objectContaining({
        taskId: "task_2",
        command: "xcodebuildmcp simulator build",
        exitCode: 0,
        interrupted: false,
      }),
    ]);
  });

  it("parses nonzero and interrupted outcomes without treating launcher exit 0 as success", () => {
    const outcomes = backgroundCommandOutcomes([
      command(1, "tool_fail", "./scripts/build_app.sh build"),
      completed(2, "tool_fail", "completed (exit code 65)", "failed", "failed"),
      command(3, "tool_stop", "xcodebuild -scheme App build"),
      completed(4, "tool_stop", undefined, "interrupted", "killed"),
    ]);

    expect(outcomes.map(({ exitCode, interrupted }) => ({ exitCode, interrupted }))).toEqual([
      { exitCode: 65, interrupted: false },
      { exitCode: null, interrupted: true },
    ]);
  });

  it("ignores completed tasks without an explicit exit code", () => {
    expect(
      backgroundCommandOutcomes([
        command(1, "tool_1", "xcodebuild -scheme App build"),
        completed(2, "tool_1", "Background command completed"),
      ]),
    ).toEqual([]);
  });
});
