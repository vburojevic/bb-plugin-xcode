/**
 * Every agent tool this plugin registers, checked against the host validator
 * that actually runs at startup.
 *
 * This file exists because of a real rejection. Up to v0.2.1 the six tools
 * carried `experimental_statusLabels`; SDK 0.4.16 folded that field into
 * `presentation.label` and — importantly — did not merely ignore the old name.
 * `rejectStaleAgentToolFields` *throws* on it, so `registerTool` failed during
 * startup and the whole plugin went to an error state on install. Type checking
 * did not catch it: the vendored `types/` declarations were pinned to whatever
 * SDK the locally installed bb happened to carry, which was still 0.4.8.
 *
 * So the assertions below deliberately do not restate the field names. They
 * import the genuine, executable validators out of the SDK package and run the
 * real registration objects through them, which means this test starts failing
 * the moment the pinned SDK renames a field again — the failure mode it was
 * written for.
 */

import { describe, expect, it } from "vitest";
import {
  parsePluginAgentToolPresentation,
  rejectStaleAgentToolFields,
} from "@get-bb/plugin-sdk/internal/host-policy";

import { createTools, type ToolDeps } from "../src/tools";
import {
  makeCaptureTool,
  makeDriveTool,
  makeStillsTool,
  makeStreamStatusTool,
} from "../src/sim/tools";
import type { Ctx } from "../src/sim/context";

/**
 * The factories only close over their dependencies — nothing is read while the
 * registration object is being built — so an unpopulated stub is enough to get
 * at the metadata, and is honest about the fact that none of it is consulted.
 */
const toolDeps = {} as ToolDeps;
const simCtx = {} as Ctx;

const tools = (() => {
  const { status, lastFailure, build } = createTools(toolDeps);
  return [
    status,
    lastFailure,
    build,
    makeCaptureTool(simCtx),
    makeDriveTool(simCtx),
    makeStillsTool(simCtx),
    makeStreamStatusTool(simCtx),
  ];
})();

describe("agent tool registrations against the host validator", () => {
  it("registers the seven tools the server wires up", () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      "xcode_status",
      "xcode_last_failure",
      "xcode_build",
      "simulator_capture",
      "simulator_drive",
      "simulator_stills",
      "simulator_stream_status",
    ]);
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))(
    "%s carries no field the current SDK rejects",
    (name, tool) => {
      // Throws on a renamed field (the v0.2.1 failure) and on any unknown
      // `experimental_*` key.
      expect(() => rejectStaleAgentToolFields(name, tool)).not.toThrow();
    },
  );

  it.each(tools.map((tool) => [tool.name, tool] as const))(
    "%s declares a presentation the host accepts",
    (name, tool) => {
      const presentation = parsePluginAgentToolPresentation(
        name,
        (tool as { presentation?: unknown }).presentation,
      );
      // Labels are the whole point of declaring one: a tool that silently lost
      // its presentation would still register, and the regression would only
      // show up as a generic `Ran xcode_build` row in the timeline.
      expect(presentation?.label?.pending).toBeTruthy();
      expect(presentation?.label?.completed).toBeTruthy();
    },
  );
});
