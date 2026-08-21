/**
 * Agent tools.
 *
 * Names are globally unique across plugins, so everything is `simulator_`
 * prefixed. Registered only when `allowAgentCapture` is on, and checked again
 * on every invocation so switching the setting off revokes already-registered
 * tools immediately rather than waiting for a plugin reload.
 *
 * ## The image budget
 *
 * The whole thesis is "let the model see whether it is centred", and a
 * 1206×2622 @3x PNG is 2–4 MB of base64 per call. The host turns an image block
 * into a data URL and caps nothing; the cost lands on the context window and on
 * provider image limits that differ per provider. So every image is downscaled
 * to a 1024px long edge at JPEG q80, the total payload per call is capped, and
 * **the text summary stands alone** — a provider may reject image content
 * entirely, and load-bearing information must never live only in a picture.
 *
 * ## The network boundary
 *
 * The capture host listens only on loopback. Remote viewing stays inside the
 * main bb panel; tools never create or return a simulator share.
 */
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileBounded } from "../bounded-file.js";
import type { Ctx } from "./context.js";
import { captureNow } from "./rpc.js";
import { AGENT_IMAGE_BUDGET_BYTES, AGENT_JPEG_QUALITY, AGENT_LONG_EDGE, downscale } from "./image.js";
import { frameAbsolutePath } from "./framestore.js";
import { getFrame, getLook } from "./frames.js";
import { fitToBudget } from "./image.js";
import { executeStep, MAX_STEPS, stepSchema, type ResolvePoint } from "./steps.js";
import { describeMiss, findByLabel, flatten } from "./ax.js";
import * as host from "./sim-host-client.js";

/**
 * MCP-style content parts, matching the host's own union exactly.
 *
 * A discriminated union rather than a loose bag: the host validates it, and a
 * text part carrying an accidental `data` field would be rejected at the call
 * rather than at the type.
 */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/** Raw JPEG bytes whose base64 representation still fits the tool budget. */
export const MAX_AGENT_IMAGE_FILE_BYTES = Math.floor(AGENT_IMAGE_BUDGET_BYTES * 3 / 4);

export const captureParameters = z.object({
  udid: z.string().optional().describe("Which simulator, if more than one is running."),
  label: z.string().max(120).optional().describe("A short name for this frame, e.g. 'recipe list empty'."),
  settleMs: z
    .number()
    .int()
    .min(0)
    .max(5000)
    .optional()
    .describe("Wait this long before capturing, so an animation can finish."),
});

export const CAPTURE_INSTRUCTIONS = [
  "Call this instead of describing the screen in prose. Never claim a screen 'looks correct' without a frame.",
  "The simulator is shared: if a call reports another thread is driving it, wait rather than retrying.",
].join(" ");

/**
 * Downscale a stored frame for a model, into a temporary file.
 *
 * Pixel-exact bytes stay on the HTTP route, where they belong. Returns `null`
 * when `sips` could not do it, and the caller falls back to text — an oversized
 * frame is worse than no frame, because it evicts the conversation that asked
 * for it.
 */
export async function encodeForModel(
  ctx: Ctx,
  frameId: string,
): Promise<{ data: string; mimeType: string; bytes: number } | null> {
  const frame = getFrame(ctx.db, frameId);
  if (frame === null) return null;
  const look = getLook(ctx.db, frame.lookId);
  if (look === null) return null;

  const source = frameAbsolutePath(ctx.framesRoot, {
    scopeKey: look.scopeKey,
    lookId: frame.lookId,
    relPath: frame.relPath,
  });
  if (source === null) return null;

  const scratch = await mkdtemp(join(tmpdir(), "xcsim-agent-"));
  const target = join(scratch, "frame.jpg");
  try {
    const ok = await downscale(source, target, AGENT_LONG_EDGE, AGENT_JPEG_QUALITY);
    if (!ok) return null;
    const bytes = await readFileBounded(target, MAX_AGENT_IMAGE_FILE_BYTES, { noFollow: true });
    return { data: bytes.toString("base64"), mimeType: "image/jpeg", bytes: bytes.byteLength };
  } catch {
    return null;
  } finally {
    // Private, unpredictable scratch avoids following an attacker-controlled
    // symlink in a shared temp directory. Cleanup remains best effort.
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function makeCaptureTool(ctx: Ctx) {
  return {
    name: "simulator_capture",
    description:
      "Take a screenshot of the running iOS simulator and look at it. Returns the frame as an image plus a line naming the app that was on screen.",
    instructions: CAPTURE_INSTRUCTIONS,
    experimental_statusLabels: {
      pending: "Looking at the simulator",
      completed: "Looked at the simulator",
    },
    parameters: captureParameters,
    async execute(
      args: z.infer<typeof captureParameters>,
      context: { threadId: string },
    ): Promise<ToolResult> {
      if (!ctx.settings().allowAgentCapture) {
        return textError("Simulator agent access is disabled in Xcode plugin settings.");
      }
      const lease = ctx.leases.acquire(context.threadId);
      if (!lease.ok) return textError(lease.reason);

      try {
        const result = await captureNow(ctx, args.label ?? null, args.settleMs);
        const image = await encodeForModel(ctx, result.frameId);
        // The text stands alone. If the image had to be dropped, the caller
        // still learns what happened and where to look.
        const text =
          image === null
            ? `${result.summary} The frame was saved but could not be downscaled for this reply — open the Xcode panel to see it.`
            : result.summary;
        const content: ToolContent[] = [{ type: "text", text }];
        if (image !== null) {
          content.push({ type: "image", data: image.data, mimeType: image.mimeType });
        }
        return { content };
      } catch (error) {
        return textError(error instanceof Error ? error.message : String(error));
      } finally {
        lease.release();
      }
    },
  };
}

export function textError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Instructions contributed to every thread, not only to threads that use these
 * tools.
 *
 * Simulator input also arrives via `simctl`, AXe and xcodebuildmcp, so the
 * contract has to reach threads that never touch this plugin. The text is
 * negative on purpose: it exists to suppress duplication, not to advertise.
 */
export const GLOBAL_INSTRUCTIONS = [
  "When you have changed SwiftUI and want to show the result, call simulator_capture or simulator_drive instead of describing the screen in prose; never claim a screen \"looks correct\" without a frame.",
  "Preview renders report themselves in the panel and in the prompt stack above the composer, so never paste a list of changed previews into chat — the user is already looking at it.",
  "The simulator is shared: if a call reports another thread is driving it, wait rather than retrying.",
  "The simulator capture port is loopback-only. Never share or tunnel it; remote viewing belongs inside the main bb panel.",
].join(" ");

export const driveParameters = z.object({
  steps: z
    .array(stepSchema)
    .min(1)
    .max(MAX_STEPS)
    .describe(
      "Up to 24 steps, run in order. Coordinates are fractions of the screen from 0 to 1; a step may instead name an on-screen element.",
    ),
  label: z.string().max(120).optional().describe("A short name for the frame this ends on."),
});

/**
 * Resolve element labels against the device's accessibility tree.
 *
 * Fetched **once per drive** rather than per step: the tree costs a round trip
 * and a screen rarely changes between two steps that both name elements — and
 * when it does, the second lookup would be against a screen the first step
 * already left. Steps that move the screen invalidate it explicitly.
 */
export function makeResolver(ctx: Ctx, udid: string): ResolvePoint & { invalidate(): void } {
  let snapshot: ReturnType<typeof flatten> | null = null;
  const resolve = (async (point) => {
    if ("x" in point) return { x: point.x, y: point.y };
    const address = ctx.live.address();
    if (address === null) throw new Error("The capture host is not running.");
    if (snapshot === null) {
      try {
        snapshot = flatten(await host.accessibility(address, udid));
      } catch (error) {
        throw new Error(
          `Could not read the screen's accessibility tree, so "${point.element.label}" cannot be found: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const match = findByLabel(snapshot, point.element.label);
    if (match === null) throw new Error(describeMiss(snapshot, point.element.label));
    return match.point;
  }) as ResolvePoint & { invalidate(): void };
  resolve.invalidate = () => {
    snapshot = null;
  };
  return resolve;
}

/** A step that changes what is on screen makes a cached tree a lie. */
export function movesTheScreen(kind: string): boolean {
  return kind !== "wait" && kind !== "keyboard";
}

export function makeDriveTool(ctx: Ctx) {
  return {
    name: "simulator_drive",
    description:
      "Run a short sequence of gestures on the running iOS simulator and look at the result. Returns a per-step log plus the final frame as an image.",
    instructions: [
      "Use this to demonstrate a flow rather than to assert one. Prefer naming an on-screen element over guessing coordinates.",
      "The simulator is shared: if a call reports another thread is driving it, wait rather than retrying.",
    ].join(" "),
    experimental_statusLabels: {
      pending: "Driving the simulator",
      completed: "Drove the simulator",
    },
    parameters: driveParameters,
    async execute(
      args: z.infer<typeof driveParameters>,
      context: { threadId: string },
    ): Promise<ToolResult> {
      if (!ctx.settings().allowAgentCapture) {
        return textError("Simulator agent access is disabled in Xcode plugin settings.");
      }
      const device = ctx.live.currentDevice();
      if (device === null) return textError("No simulator is running.");

      const lease = ctx.leases.acquire(context.threadId);
      if (!lease.ok) return textError(lease.reason);

      const resolver = makeResolver(ctx, device.udid);
      const log: string[] = [];
      try {
        const socket = ctx.live.requireSocket();
        for (const [index, step] of args.steps.entries()) {
          try {
            const result = await executeStep(socket, step, resolver, {
              pasteText: (text) => ctx.live.pasteText(text),
            });
            log.push(`${index + 1}. ${result.log}`);
          } catch (error) {
            // Stop at the first failure and say where. A drive that carried on
            // past a missed tap would report success for a flow that never
            // happened.
            log.push(`${index + 1}. ${step.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
            return {
              content: [
                { type: "text", text: `Stopped at step ${index + 1} of ${args.steps.length}.\n${log.join("\n")}` },
              ],
              isError: true,
            };
          }
          if (movesTheScreen(step.kind)) resolver.invalidate();
        }

        const result = await captureNow(ctx, args.label ?? null);
        const image = await encodeForModel(ctx, result.frameId);
        const text = [log.join("\n"), "", result.summary].join("\n");
        const content: ToolContent[] = [{ type: "text", text }];
        if (image !== null) {
          content.push({ type: "image", data: image.data, mimeType: image.mimeType });
        }
        return { content };
      } catch (error) {
        return textError(error instanceof Error ? error.message : String(error));
      } finally {
        lease.release();
      }
    },
  };
}

export const stillsParameters = z.object({
  scope: z
    .enum(["changed", "all"])
    .optional()
    .describe("changed returns only what moved; all returns every preview. Defaults to changed."),
  device: z.string().optional().describe("Which simulator to render on."),
});

/** How many changed frames a tool reply carries before the text has to do the rest. */
export const MAX_TOOL_FRAMES = 4;

export function makeStillsTool(ctx: Ctx) {
  return {
    name: "simulator_stills",
    description:
      "Render every SwiftUI preview in this project and report what changed since the last run. Blocking and bounded.",
    instructions:
      "Preview renders report themselves in the panel and in the prompt stack above the composer, so never paste a list of changed previews into chat — the user is already looking at it.",
    experimental_statusLabels: {
      pending: "Rendering previews",
      completed: "Rendered previews",
    },
    parameters: stillsParameters,
    async execute(args: z.infer<typeof stillsParameters>): Promise<ToolResult> {
      if (!ctx.settings().allowAgentCapture) {
        return textError("Simulator agent access is disabled in Xcode plugin settings.");
      }
      let summary;
      try {
        const scope = await ctx.scopeForThread(null);
        if (scope === null) {
          return textError("Xcode Simulators could not work out which project this is.");
        }
        summary = await ctx.stills.run(scope, args.device ?? null);
      } catch (error) {
        // On an un-onboarded project this is a tool **error** whose message is
        // the onboarding text, so the model can offer to run `bb sims onboard`
        // instead of inventing a reason.
        return textError(error instanceof Error ? error.message : String(error));
      }
      if (summary === null) return textError("The render did not finish.");

      const changed = summary.rows.filter(
        (row) => row.status === "changed" || row.status === "layout-changed",
      );
      const missing = summary.rows.filter(
        (row) => row.status === "missing" || row.status === "errored",
      );

      const lines = [summary.sentence];
      if (summary.truncation !== null) lines.push(summary.truncation.sentence);
      if (summary.rekey !== null) lines.push(summary.rekey.sentence);
      // Missing first, because a preview that produced nothing is the most
      // alarming thing this can report.
      for (const row of missing.slice(0, 10)) {
        lines.push(`did not render: ${row.groupName === "" ? row.displayName : `${row.groupName} / ${row.displayName}`}`);
      }
      for (const row of changed.slice(0, 20)) {
        lines.push(`changed: ${row.groupName === "" ? row.displayName : `${row.groupName} / ${row.displayName}`}`);
      }

      const wanted = args.scope === "all" ? summary.rows : changed;
      const encodable = wanted.filter((row) => row.frame !== null).slice(0, MAX_TOOL_FRAMES);
      const content: ToolContent[] = [];
      let omitted = wanted.length - encodable.length;

      const encoded: Array<{ data: string; mimeType: string; bytes: number }> = [];
      for (const row of encodable) {
        const image = await encodeForModel(ctx, row.frame!.id);
        if (image !== null) encoded.push(image);
      }
      const { included, omitted: overBudget } = fitToBudget(encoded);
      omitted += overBudget;

      // The text goes first and stands alone: a provider may reject image
      // content entirely, and load-bearing information must never live only in
      // a picture.
      if (omitted > 0) lines.push(`(${omitted} more changed; open the panel)`);
      content.push({ type: "text", text: lines.join("\n") });
      for (const image of included) {
        content.push({ type: "image", data: image.data, mimeType: image.mimeType });
      }
      return { content };
    },
  };
}
