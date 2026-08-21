/**
 * `bb xcode sim …`
 *
 * Three rules this file exists to respect.
 *
 * **Output fits `PLUGIN_CLI_OUTPUT_MAX_BYTES`.** The host rejects an oversize
 * result atomically rather than clipping it, so a command that grew past the
 * limit would return nothing at all. Image bytes never go to stdout — only
 * paths.
 *
 * **`run` executes on the server**, so a path argument names a file on the
 * *invoking* machine. Anything that writes a user-supplied path resolves the
 * invoking host and goes through `bb.sdk.files`, never `node:fs` against a
 * `ctx.cwd`-relative path.
 *
 * **Remote viewing stays in bb.** The CLI never opens, shares, or returns a
 * simulator network endpoint. The main bb panel owns that surface.
 */
import { PLUGIN_CLI_OUTPUT_MAX_BYTES } from "@bb/plugin-sdk";
import { isAbsolute, relative, resolve } from "node:path";
import type { Ctx } from "./context.js";
import { overallState } from "./preflight.js";
import { SimctlError } from "./devices.js";
import { getLook, listFrames, scopeCount, totalBytes } from "./frames.js";
import { LOOK_ID_PATTERN } from "./model.js";
import { formatBytes } from "./format.js";
import { DEMO_BANNER_STATES, isDemoBannerState } from "./demos.js";
import { captureNow, makeRpcHandlers } from "./rpc.js";
import { DriveScriptError, parseDriveScript } from "./drive-script.js";
import { executeStep } from "./steps.js";
import { makeResolver, movesTheScreen } from "./tools.js";

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface CliContext {
  cwd?: string;
  threadId?: string;
  projectId?: string;
}

/** Never hand the host more than it will accept; it refuses the whole result. */
export function fit(text: string): string {
  const budget = PLUGIN_CLI_OUTPUT_MAX_BYTES - 1024;
  if (Buffer.byteLength(text, "utf8") <= budget) return text;
  const buffer = Buffer.from(text, "utf8").subarray(0, budget);
  return `${buffer.toString("utf8")}\n… truncated; use --json and page, or open the panel.`;
}

function json(value: unknown): CliResult {
  return { exitCode: 0, stdout: fit(`${JSON.stringify(value, null, 2)}\n`) };
}

function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

/** `--flag value` and `--flag=value`, both. */
export function flagValue(argv: readonly string[], name: string): string | null {
  const long = `--${name}`;
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i]!;
    if (entry === long) return argv[i + 1] ?? null;
    if (entry.startsWith(`${long}=`)) return entry.slice(long.length + 1);
  }
  return null;
}

export function positionals(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i += 1) {
    const entry = argv[i]!;
    if (entry.startsWith("--")) {
      // `--flag value` consumes the next token unless it is itself a flag.
      if (!entry.includes("=") && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) i += 1;
      continue;
    }
    out.push(entry);
  }
  return out;
}

export const CLI_COMMANDS = [
  { name: "doctor", summary: "Every prerequisite, its state, and the fix", usage: "bb xcode sim doctor [--json]" },
  { name: "status", summary: "Live device and current state", usage: "bb xcode sim status [--json]" },
  {
    name: "devices",
    summary: "Simulators, marking booted and which is live",
    usage: "bb xcode sim devices [--json]",
  },
  { name: "live", summary: "Start or stop the live surface", usage: "bb xcode sim live [<device>] [--stop]" },
  {
    name: "shot",
    summary: "Capture one frame",
    usage: "bb xcode sim shot [--out <path>] [--label <s>] [--json]",
  },
  {
    name: "stills",
    summary: "Render every SwiftUI preview and diff it against the last run",
    // No `--set-baseline` here: the flag was advertised for months while the
    // handler read only `--device`, silently ignoring the promise. Baselines
    // are set on a finished run, where the look id exists to name.
    usage: "bb xcode sim stills [--device <d>]  (then: baseline set <lookId>)",
  },
  {
    name: "onboard",
    summary: "Show the exact changes Stills needs — changes nothing without --apply",
    usage: "bb xcode sim onboard [--apply] [--project <path>] [--json]",
  },
  {
    name: "look",
    summary: "One run's verdict",
    usage: "bb xcode sim look [<lookId>] [--json]",
  },
  {
    name: "history",
    summary: "One preview's frames over time, with commits",
    usage: "bb xcode sim history <identity> [--json]",
  },
  {
    name: "baseline",
    summary: "Show, set or clear the baseline",
    usage: "bb xcode sim baseline [show | set <lookId> | clear]",
  },
  {
    name: "demos",
    summary: "List the demo states this plugin can render with no hardware",
    usage: "bb xcode sim demos",
  },
  {
    name: "demo-banner",
    summary: "Render one demo banner in this thread's composer for five minutes",
    usage: "bb xcode sim demo-banner <state|off>",
  },
  {
    name: "purge",
    summary: "Report and then remove every frame this plugin has stored",
    usage: "bb xcode sim purge [--dry-run]",
  },
  {
    name: "card",
    summary: "Print the canonical directive for a run",
    usage: "bb xcode sim card <lookId>",
  },
  {
    name: "diff",
    summary: "Compare two runs",
    usage: "bb xcode sim diff <lookA> <lookB> [--json]",
  },
  {
    name: "drive",
    summary: "Run a short sequence of gestures",
    usage: 'bb xcode sim drive "tap 0.5,0.9; type hello; swipe up; rotate landscape-left"',
  },
];

const AGENT_CAPTURE_COMMANDS = new Set([
  "status",
  "devices",
  "live",
  "shot",
  "drive",
  "stills",
  "look",
  "history",
  "baseline",
  "card",
  "diff",
]);

/**
 * A context whose project scope comes from the invocation rather than from
 * "whichever project bb lists first".
 *
 * `run` executes on the server with no thread when someone types into a
 * terminal, so `cwd` is the only thing that says which repository they meant.
 */
export function forInvocation(ctx: Ctx, cliCtx: CliContext): Ctx {
  const hints = {
    ...(cliCtx.threadId === undefined ? {} : { threadId: cliCtx.threadId }),
    ...(cliCtx.projectId === undefined ? {} : { projectId: cliCtx.projectId }),
    ...(cliCtx.cwd === undefined ? {} : { cwd: cliCtx.cwd }),
  };
  // `cwd` is supplied by the invoking bb CLI itself. A bare thread/project id
  // is caller-selectable routing data and cannot authorize reading that
  // checkout's stored images or verdicts.
  const hasInvocationCheckout = cliCtx.cwd !== undefined;
  return {
    ...ctx,
    // An empty CLI context is not the panel's trusted "current project"
    // request. It carries no authority to inherit the first project in bb.
    scopeForThread: () =>
      hasInvocationCheckout ? ctx.scopeForInvocation(hints) : Promise.resolve(null),
    // Handlers built on this ctx re-resolve scope from their own hints; fold
    // the invocation `cwd` in so a bare-terminal `stills` resolves the repo
    // the caller is standing in, never "whichever project bb lists first".
    // `cwd` is the weakest rung in `resolveScopeFor`, so a thread or project
    // hint still wins when one exists.
    scopeForInvocation: (handlerHints) =>
      ctx.scopeForInvocation({
        ...handlerHints,
        ...(cliCtx.cwd === undefined ? {} : { cwd: cliCtx.cwd }),
      }),
  };
}

async function scopedLook(ctx: Ctx, lookId: string): Promise<ReturnType<typeof getLook>> {
  const scope = await ctx.scopeForThread(null);
  if (scope === null) return null;
  const look = getLook(ctx.db, lookId);
  return look?.scopeKey === scope.scope.scopeKey ? look : null;
}

const NO_INVOCATION_SCOPE =
  "Run this command from the bb thread checkout whose simulator data you want to access.\n";

export function makeCli(base: Ctx) {
  return async function run(argv: string[], cliCtx: CliContext): Promise<CliResult> {
    const ctx = forInvocation(base, cliCtx);
    const command = argv[0] ?? "";
    if (!ctx.settings().allowAgentCapture && AGENT_CAPTURE_COMMANDS.has(command)) {
      return {
        exitCode: 1,
        stderr:
          "Simulator agent access is disabled in Xcode plugin settings (allowAgentCapture). Use the human-owned panel instead.\n",
      };
    }
    switch (command) {
      case "doctor":
        return doctor(ctx, argv);
      case "status":
        return status(ctx, argv);
      case "devices":
        return devices(ctx, argv);
      case "live":
        return live(ctx, argv);
      case "shot":
        return shot(ctx, argv, cliCtx);
      case "drive":
        return drive(ctx, argv, cliCtx);
      case "stills":
        return stills(ctx, argv, cliCtx);
      case "onboard":
        return onboard(ctx, argv, cliCtx);
      case "look":
        return look(ctx, argv);
      case "history":
        return history(ctx, argv);
      case "baseline":
        return baseline(ctx, argv, cliCtx);
      case "purge":
        return purge(ctx, argv, cliCtx);
      case "demos":
        return {
          exitCode: 0,
          stdout: `${DEMO_BANNER_STATES.join("\n")}\n\nbb xcode sim demo-banner <state>\n`,
        };
      case "demo-banner":
        return demoBannerCommand(ctx, argv);
      case "card":
        return card(ctx, argv);
      case "diff":
        return diffRuns(ctx, argv);
      case "":
      case "--help":
      case "-h":
        return { exitCode: 0, stdout: usage() };
      default:
        return { exitCode: 2, stderr: `Unknown command "${command}".\n\n${usage()}` };
    }
  };
}

function usage(): string {
  const width = Math.max(...CLI_COMMANDS.map((entry) => entry.usage.length));
  const lines = CLI_COMMANDS.map((entry) => `  ${entry.usage.padEnd(width)}  ${entry.summary}`);
  return `Look at, and touch, an iOS simulator.\n\n${lines.join("\n")}\n`;
}

async function doctor(ctx: Ctx, argv: string[]): Promise<CliResult> {
  const preflight = await ctx.refreshPreflight();
  const overall = overallState(preflight.probes);
  if (wantsJson(argv)) {
    return json({
      overall,
      probes: preflight.probes,
      // The real number, matching the panel and `purge --dry-run` — a script
      // reading a hardcoded 0 here was being told nothing is stored.
      diskBytes: totalBytes(ctx.db),
      scopeCount: scopeCount(ctx.db),
      checkedAt: preflight.checkedAt,
    });
  }
  // The same sentences the panel and the empty state render. There is no
  // second vocabulary of status tokens.
  const mark = { ok: "ok  ", warn: "warn", blocked: "STOP", unknown: "?   " };
  const lines = preflight.probes.map((probe) => `${mark[probe.state]}  ${probe.label}\n      ${probe.detail}`);
  const headline =
    overall === "ok"
      ? "Everything Xcode Simulators needs is here."
      : overall === "blocked"
        ? "Something is missing that Xcode Simulators cannot work around."
        : "Xcode Simulators works, with caveats.";
  return { exitCode: overall === "blocked" ? 1 : 0, stdout: fit(`${headline}\n\n${lines.join("\n\n")}\n`) };
}

async function status(ctx: Ctx, argv: string[]): Promise<CliResult> {
  const state = ctx.live.state();
  const payload = {
    live: {
      kind: state.kind,
      device: state.device,
      screen: state.screen,
      foregroundBundleId: state.foregroundBundleId,
    },
  };
  if (wantsJson(argv)) return json(payload);

  const device = state.device;
  const liveLine =
    device === null
      ? "No simulator is running."
      : state.kind === "streaming"
        ? `Watching ${device.name}, iOS ${device.osVersion}.`
        : state.kind === "booting"
          ? `Booting ${device.name}.`
          : state.kind === "dead"
            ? `${device.name} shut down.`
            : `${device.name}: ${state.kind}.`;
  return { exitCode: 0, stdout: fit(`${liveLine}\n`) };
}

async function devices(ctx: Ctx, argv: string[]): Promise<CliResult> {
  let result: Awaited<ReturnType<Ctx["live"]["devices"]>>;
  try {
    result = await ctx.live.devices();
  } catch (error) {
    const detail = error instanceof SimctlError ? error.message : String(error);
    return {
      exitCode: 1,
      stderr: `Xcode Simulators could not ask about simulators — ${detail}\n`,
    };
  }
  if (wantsJson(argv)) return json(result);
  if (result.devices.length === 0) {
    return { exitCode: 0, stdout: "No simulators are installed.\n" };
  }

  const current = ctx.live.currentDevice();
  const rows = result.devices
    .filter((device) => device.isAvailable)
    .map((device) => {
      const flags = [
        device.state === "Booted" ? "booted" : "",
        device.udid === current?.udid ? "live" : "",
      ].filter((flag) => flag !== "");
      const suffix = flags.length === 0 ? "" : `  (${flags.join(", ")})`;
      return `  ${device.name}  ${device.platform} ${device.osVersion}${suffix}`;
    });
  return { exitCode: 0, stdout: fit(`${rows.join("\n")}\n`) };
}

async function live(ctx: Ctx, argv: string[]): Promise<CliResult> {
  if (argv.includes("--stop")) {
    await ctx.live.stop();
    return { exitCode: 0, stdout: "Stopped watching.\n" };
  }
  const wanted = positionals(argv)[0] ?? null;
  const state = await ctx.live.start(wanted);
  if (state.device === null) {
    return {
      exitCode: 1,
      stderr:
        wanted === null
          ? "No simulator to watch. Install an iOS runtime in Xcode → Settings → Components.\n"
          : `No simulator matched "${wanted}". Run \`bb xcode sim devices\` to see what is installed.\n`,
    };
  }
  return {
    exitCode: 0,
    stdout: `Booting ${state.device.name} — about twenty seconds the first time.\n`,
  };
}

/**
 * Capture one frame.
 *
 * `--out` names a file on the **invoking** machine, not on the server's
 * filesystem: `run` executes on the server, and on an enrolled remote machine
 * `node:fs` against a `ctx.cwd`-relative path silently writes to the wrong
 * host's disk. The write goes through `bb.sdk.files` with the invoking host's
 * id, resolved from the thread.
 *
 * Image bytes never go to stdout — only paths. Combined output has to fit
 * `PLUGIN_CLI_OUTPUT_MAX_BYTES`, and the host rejects an oversize result
 * atomically rather than clipping it.
 */
async function shot(ctx: Ctx, argv: string[], cliCtx: CliContext): Promise<CliResult> {
  const label = flagValue(argv, "label");
  const out = flagValue(argv, "out");

  let output: { path: string; rootPath: string } | null = null;
  if (out !== null) {
    if (isAbsolute(out)) {
      return { exitCode: 1, stderr: "--out must be a path inside this thread's checkout, not an absolute path.\n" };
    }
    if (cliCtx.threadId === undefined) {
      return { exitCode: 1, stderr: "--out needs a thread checkout so the write can be confined safely.\n" };
    }
    const scope = await ctx.scopeForInvocation({
      threadId: cliCtx.threadId,
      projectId: cliCtx.projectId,
      cwd: cliCtx.cwd,
    });
    if (scope === null) return { exitCode: 1, stderr: "Could not resolve this thread's checkout.\n" };
    const rootPath = scope.scope.checkoutPath;
    const base = cliCtx.cwd ?? rootPath;
    const target = resolve(base, out);
    const fromRoot = relative(rootPath, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
      return { exitCode: 1, stderr: "--out must stay inside this thread's checkout.\n" };
    }
    output = { path: target, rootPath };
    const approved = await ctx.confirmAction(
      {
        threadId: cliCtx.threadId,
        projectId: cliCtx.projectId,
      },
      {
        title: "Write this simulator capture into the checkout?",
        facts: [
          `Destination: ${target}`,
          "The write is create-only and will not replace an existing file.",
        ],
        confirmLabel: "Write capture",
      },
    );
    if (!approved) {
      return {
        exitCode: 1,
        stderr: "Writing the simulator capture was not confirmed.\n",
      };
    }
  }

  let result;
  try {
    result = await captureNow(ctx, label);
  } catch (error) {
    return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }

  if (output !== null) {
    const written = await ctx.writeToInvokingHost(
      cliCtx.threadId ?? null,
      output.path,
      output.rootPath,
      result.frameId,
    );
    if (written.ok) {
      return {
        exitCode: 0,
        stdout: wantsJson(argv)
          ? `${JSON.stringify({ ...result, out: written.path }, null, 2)}\n`
          : `${result.summary}\nWrote ${written.path}\n`,
      };
    }
    return { exitCode: 1, stderr: `${written.reason}\n` };
  }

  if (wantsJson(argv)) return json(result);
  return { exitCode: 0, stdout: `${result.summary}\nSaved as ${result.identity}.\n` };
}

/**
 * Run a drive script.
 *
 * The parser produces the same `Step` union the agent tool and the panel use,
 * so a gesture cannot behave differently depending on who asked for it. A
 * parse failure names the statement it failed on, because a script that fails
 * on step four should not read as a script that failed.
 */
async function drive(ctx: Ctx, argv: string[], cliCtx: CliContext = {}): Promise<CliResult> {
  const script = positionals(argv).join(" ");
  if (script.trim() === "") {
    return {
      exitCode: 2,
      stderr: 'Nothing to run. Try: bb xcode sim drive "tap 0.5,0.9; type hello; swipe up"\n',
    };
  }

  let steps;
  try {
    steps = parseDriveScript(script);
  } catch (error) {
    if (error instanceof DriveScriptError) {
      return { exitCode: 2, stderr: `Step ${error.index + 1}: ${error.message}\n` };
    }
    throw error;
  }

  const device = ctx.live.currentDevice();
  if (device === null) {
    return { exitCode: 1, stderr: "No simulator is running. Start one with `bb xcode sim live`.\n" };
  }

  // The lease holder is the invoking *thread*, exactly as the agent tools
  // pass it. `null` here was every CLI caller sharing one identity: two agent
  // threads driving via the CLI were re-entrant to each other and interleaved
  // gestures — the precise failure the lease exists to prevent — and a thread
  // already holding the lease through simulator_drive was refused its own CLI.
  const lease = ctx.leases.acquire(cliCtx.threadId ?? null);
  if (!lease.ok) return { exitCode: 1, stderr: `${lease.reason}\n` };

  const resolver = makeResolver(ctx, device.udid);
  const log: string[] = [];
  try {
    let socket;
    try {
      socket = ctx.live.requireSocket();
    } catch (error) {
      // Between the device guard above and a live socket sits "still booting"
      // and "reconnecting"; a sentence beats a raw stack either way.
      return {
        exitCode: 1,
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      };
    }
    for (const [index, step] of steps.entries()) {
      try {
        const result = await executeStep(socket, step, resolver, {
          pasteText: (text) => ctx.live.pasteText(text),
        });
        log.push(`${index + 1}. ${result.log}`);
      } catch (error) {
        log.push(`${index + 1}. ${step.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
        return { exitCode: 1, stdout: fit(`${log.join("\n")}\n`), stderr: `Stopped at step ${index + 1}.\n` };
      }
      if (movesTheScreen(step.kind)) resolver.invalidate();
    }
  } finally {
    lease.release();
  }

  if (wantsJson(argv)) return json({ steps: log });
  return { exitCode: 0, stdout: fit(`${log.join("\n")}\n`) };
}

async function stills(
  ctx: Ctx,
  argv: string[],
  cliCtx: CliContext,
): Promise<CliResult> {
  if ((await ctx.scopeForThread(null)) === null) {
    return { exitCode: 1, stderr: NO_INVOCATION_SCOPE };
  }
  const handlers = makeRpcHandlers(ctx);
  const device = flagValue(argv, "device");
  const result = await handlers.stillsRun({
    ...(device === null ? {} : { device }),
    ...(cliCtx.threadId === undefined ? {} : { threadId: cliCtx.threadId }),
    ...(cliCtx.projectId === undefined ? {} : { projectId: cliCtx.projectId }),
  });
  if (result.error !== null) return { exitCode: 1, stderr: `${result.error}\n` };
  // The run takes minutes and reports itself in the panel; blocking a terminal
  // on it would be a worse version of watching the panel.
  const queued =
    result.queued === 0 ? "" : `It is queued behind ${result.queued} other run(s) on that device.\n`;
  return { exitCode: 0, stdout: `Rendering previews. Watch it in the Xcode panel's Stills tab.\n${queued}` };
}

/**
 * `--dry-run` is the default and prints the full diff before anything is
 * written. `--apply` writes only the files that can be written safely; the
 * pbxproj is never rewritten.
 */
async function onboard(
  ctx: Ctx,
  argv: string[],
  cliCtx: CliContext,
): Promise<CliResult> {
  const handlers = makeRpcHandlers(ctx);
  const project = flagValue(argv, "project");
  const plan = await handlers.onboardPlan(project === null ? { wait: true } : { project, wait: true });

  if (wantsJson(argv)) return json(plan);

  const lines: string[] = [];
  if (plan.checkoutElsewhere !== null) {
    return { exitCode: 1, stderr: `${plan.checkoutElsewhere}\n` };
  }
  if (plan.candidates.length === 0) {
    return {
      exitCode: 1,
      stderr:
        `No Xcode project under ${plan.searched ?? "this checkout"}. Xcode Simulators looks two levels deep; set projectPath if yours is deeper.\n`,
    };
  }
  if (plan.candidates.length > 1) {
    lines.push(`${plan.candidates.length} Xcode projects under this checkout:`, "");
    for (const candidate of plan.candidates) lines.push(`  ${candidate.relPath}`);
    lines.push("", `Using ${plan.detected?.relPath ?? plan.candidates[0]!.relPath}. Set projectPath to choose another.`, "");
  }
  if (plan.detected !== null) {
    lines.push(plan.detected.summary, "");
  } else {
    return {
      exitCode: 1,
      stderr: `xcodebuild could not read ${plan.candidates[0]?.relPath ?? "the project"}. Run \`xcodebuild -list\` there to see why.\n`,
    };
  }
  if (plan.conflict !== null) {
    lines.push(plan.conflict);
    return { exitCode: 1, stdout: fit(`${lines.join("\n")}\n`) };
  }
  for (const done of plan.alreadyDone) lines.push(`already done: ${done}`);

  if (!argv.includes("--apply")) {
    if (plan.files.length > 0) {
      lines.push("", "Files it would write:");
      for (const file of plan.files) {
        lines.push("", `--- ${file.relPath}`, file.contents);
      }
    }
    lines.push("", "Then, in Xcode:");
    plan.manualSteps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
    lines.push("", "Nothing has been changed. Run again with --apply to write the files.");
    return { exitCode: 0, stdout: fit(`${lines.join("\n")}\n`) };
  }

  const approved = await ctx.confirmAction(
    { threadId: cliCtx.threadId, projectId: cliCtx.projectId },
    {
      title: "Write the Stills onboarding files?",
      facts: [
        `Checkout: ${plan.searched ?? "the resolved project checkout"}`,
        ...plan.files.map((file) => `Create: ${file.relPath}`).slice(0, 20),
        "Writes are create-only and will not replace existing files.",
      ],
      confirmLabel: "Write onboarding files",
    },
  );
  if (!approved) {
    return { exitCode: 1, stderr: "Stills onboarding was not confirmed.\n" };
  }

  const applied = await handlers.onboardApply(project === null ? {} : { project });
  if (applied.error !== null) return { exitCode: 1, stderr: `${applied.error}\n` };
  lines.push(
    "",
    applied.written.length === 0
      ? "Nothing to write — every file it can write is already there."
      : `Wrote: ${applied.written.join(", ")}`,
    "",
    "Then, in Xcode:",
  );
  applied.manualSteps.forEach((step, index) => lines.push(`  ${index + 1}. ${step}`));
  return { exitCode: 0, stdout: fit(`${lines.join("\n")}\n`) };
}

async function look(ctx: Ctx, argv: string[]): Promise<CliResult> {
  const handlers = makeRpcHandlers(ctx);
  const lookId = positionals(argv)[0];
  if (lookId !== undefined && (await scopedLook(ctx, lookId)) === null) {
    return { exitCode: 1, stderr: `No run called ${lookId}.\n` };
  }
  if (lookId === undefined && (await ctx.scopeForThread(null)) === null) {
    return { exitCode: 1, stderr: NO_INVOCATION_SCOPE };
  }
  const summary = await handlers.stillsLatest(lookId === undefined ? {} : { lookId });
  if (wantsJson(argv)) return json(summary);
  if (summary.lookId === null) return { exitCode: 0, stdout: "Nothing has run yet.\n" };

  const lines = [summary.sentence];
  if (summary.truncation !== null) lines.push("", summary.truncation.sentence);
  if (summary.rekey !== null) lines.push("", summary.rekey.sentence);
  const interesting = summary.rows.filter((row) => row.status !== "unchanged");
  if (interesting.length > 0) {
    lines.push("");
    for (const row of interesting.slice(0, 40)) {
      const name = row.groupName === "" ? row.displayName : `${row.groupName} / ${row.displayName}`;
      lines.push(`  ${row.status.padEnd(15)} ${name}`);
    }
    if (interesting.length > 40) lines.push(`  … and ${interesting.length - 40} more`);
  }
  return { exitCode: 0, stdout: fit(`${lines.join("\n")}\n`) };
}

async function history(ctx: Ctx, argv: string[]): Promise<CliResult> {
  const identity = positionals(argv)[0];
  if (identity === undefined) {
    return { exitCode: 2, stderr: "Which preview? Try: bb xcode sim history preview:MyApp_LoginView.swift_Dark.png\n" };
  }
  if ((await ctx.scopeForThread(null)) === null) {
    return { exitCode: 1, stderr: NO_INVOCATION_SCOPE };
  }
  const handlers = makeRpcHandlers(ctx);
  const result = await handlers.stillsIdentityHistory({ identity });
  if (wantsJson(argv)) return json(result);
  if (result.entries.length === 0) {
    return { exitCode: 0, stdout: `No kept run has rendered ${identity}.\n` };
  }
  const lines = result.entries.map(
    (entry) =>
      `  ${(entry.commitSha ?? "-------").slice(0, 7)}  ${new Date(entry.capturedAt).toISOString()}  ${entry.status ?? ""}`,
  );
  return { exitCode: 0, stdout: fit(`${identity}\n${lines.join("\n")}\n`) };
}

async function baseline(
  ctx: Ctx,
  argv: string[],
  cliCtx: CliContext,
): Promise<CliResult> {
  const handlers = makeRpcHandlers(ctx);
  const sub = positionals(argv)[0] ?? "show";
  const scope = await ctx.scopeForThread(null);
  if (scope === null) return { exitCode: 1, stderr: NO_INVOCATION_SCOPE };
  if (sub === "show") {
    const current = await handlers.baselineShow();
    if (wantsJson(argv)) return json(current);
    if (current.lookId === null) {
      return { exitCode: 0, stdout: "No baseline. Runs compare against the previous run.\n" };
    }
    const extra =
      current.identityCount === 0
        ? ""
        : ` ${current.identityCount} preview(s) have their own accepted baseline.`;
    return {
      exitCode: 0,
      stdout: `Baseline is ${current.lookId} from ${(current.commitSha ?? "an unknown commit").slice(0, 7)}, set by ${current.setBy}.${extra}\n`,
    };
  }
  if (sub === "clear") {
    const approved = await ctx.confirmAction(
      { threadId: cliCtx.threadId, projectId: cliCtx.projectId },
      {
        title: "Clear this project's preview baseline?",
        facts: ["Future preview runs will compare against the previous run instead."],
        confirmLabel: "Clear baseline",
      },
    );
    if (!approved) return { exitCode: 1, stderr: "Clearing the baseline was not confirmed.\n" };
    await handlers.baselineClear();
    return { exitCode: 0, stdout: "Cleared. Runs now compare against the previous run.\n" };
  }
  if (sub === "set") {
    const lookId = positionals(argv)[1];
    if (lookId === undefined) return { exitCode: 2, stderr: "Which run? bb xcode sim baseline set <lookId>\n" };
    if ((await scopedLook(ctx, lookId)) === null) {
      return { exitCode: 1, stderr: `No run called ${lookId}.\n` };
    }
    const approved = await ctx.confirmAction(
      { threadId: cliCtx.threadId, projectId: cliCtx.projectId },
      {
        title: "Replace this project's preview baseline?",
        facts: [`New baseline: ${lookId}`],
        confirmLabel: "Set baseline",
      },
    );
    if (!approved) return { exitCode: 1, stderr: "Setting the baseline was not confirmed.\n" };
    const result = await handlers.baselineSet({ lookId });
    if (!result.ok) return { exitCode: 1, stderr: `No run called ${lookId}.\n` };
    return {
      exitCode: 0,
      stdout:
        result.replaced === null
          ? `${lookId} is the baseline.\n`
          : `${lookId} is the baseline, replacing the one from ${result.replaced.slice(0, 7)}.\n`,
    };
  }
  return { exitCode: 2, stderr: "bb xcode sim baseline [show | set <lookId> | clear]\n" };
}

/**
 * The canonical directive for a run.
 *
 * This exists so a model never hand-writes one: a directive with a mistyped id
 * renders as its own source text in someone's transcript, forever.
 */
async function card(ctx: Ctx, argv: string[]): Promise<CliResult> {
  const lookId = positionals(argv)[0];
  if (lookId === undefined) return { exitCode: 2, stderr: "Which run? bb xcode sim card <lookId>\n" };
  if (!LOOK_ID_PATTERN.test(lookId)) {
    return { exitCode: 2, stderr: `"${lookId}" is not a run id.\n` };
  }
  const look = await scopedLook(ctx, lookId);
  if (look === null) return { exitCode: 1, stderr: `No run called ${lookId}.\n` };
  return { exitCode: 0, stdout: `::xcode-simulators{look="${lookId}"}\n` };
}

/**
 * Compare two runs directly, without touching either baseline.
 *
 * Useful for the question "did anything move between these two commits" when
 * neither is the baseline — and it never writes a verdict row, because a
 * comparison someone asked for by hand is not a run's truth.
 */
async function diffRuns(ctx: Ctx, argv: string[]): Promise<CliResult> {
  const [a, b] = positionals(argv);
  if (a === undefined || b === undefined) {
    return { exitCode: 2, stderr: "bb xcode sim diff <lookA> <lookB>\n" };
  }
  const [lookA, lookB] = await Promise.all([scopedLook(ctx, a), scopedLook(ctx, b)]);
  if (lookA === null || lookB === null) {
    return { exitCode: 1, stderr: `No run called ${lookA === null ? a : b}.\n` };
  }

  const base = new Map(listFrames(ctx.db, lookA.id).map((frame) => [frame.identity, frame]));
  const head = new Map(listFrames(ctx.db, lookB.id).map((frame) => [frame.identity, frame]));
  const rows: Array<{ identity: string; status: string }> = [];
  for (const identity of new Set([...base.keys(), ...head.keys()])) {
    const from = base.get(identity) ?? null;
    const to = head.get(identity) ?? null;
    // Only the two free rungs: a hand comparison should not spend a minute of
    // odiff on 148 frames to answer "what is different at all".
    const status =
      to === null
        ? "removed"
        : from === null
          ? "added"
          : from.contentHash === to.contentHash
            ? "unchanged"
            : from.width !== to.width || from.height !== to.height
              ? "layout-changed"
              : "changed";
    rows.push({ identity, status });
  }
  rows.sort((x, y) => x.identity.localeCompare(y.identity));

  if (wantsJson(argv)) return json({ base: lookA.id, head: lookB.id, rows });
  const interesting = rows.filter((row) => row.status !== "unchanged");
  if (interesting.length === 0) {
    return { exitCode: 0, stdout: `${rows.length} previews, all identical.\n` };
  }
  const lines = interesting.map((row) => `  ${row.status.padEnd(15)} ${row.identity.replace(/^preview:/, "")}`);
  return {
    exitCode: 0,
    stdout: fit(`${interesting.length} of ${rows.length} differ.\n${lines.join("\n")}\n`),
  };
}

/**
 * Report, then remove.
 *
 * `--dry-run` reports and stops. Uninstalling the plugin leaves the frames
 * tree and the database behind, so this is the command the README points at —
 * and a command that deletes without first saying how much is a command people
 * learn not to run.
 */
async function purge(ctx: Ctx, argv: string[], cliCtx: CliContext): Promise<CliResult> {
  const handlers = makeRpcHandlers(ctx);
  const preview = await handlers.purgePreview();
  if (wantsJson(argv)) return json(preview);
  if (preview.looks === 0) {
    return { exitCode: 0, stdout: "Nothing stored. There is nothing to purge.\n" };
  }
  if (argv.includes("--dry-run")) {
    return {
      exitCode: 0,
      stdout: `${preview.sentence}\n${preview.looks} run(s) across ${preview.scopes} project(s). Nothing has been removed.\n`,
    };
  }
  if (cliCtx.threadId === undefined && cliCtx.projectId === undefined) {
    return {
      exitCode: 1,
      stderr: "Purging needs a person to confirm in a recent thread. Run it from a bb thread.\n",
    };
  }
  let result;
  try {
    result = await handlers.purgeApply({
      threadId: cliCtx.threadId ?? null,
      projectId: cliCtx.projectId ?? null,
    });
  } catch (error) {
    return { exitCode: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
  }
  return {
    exitCode: 0,
    stdout: `Removed ${result.looks} run(s), freeing ${formatBytes(result.bytes)}.\n`,
  };
}

/**
 * Render one demo banner in the real composer location.
 *
 * The states worth reviewing are the failure states, and those are exactly the
 * ones you cannot produce on demand — so this produces them. It expires on its
 * own after five minutes, because a demo left on is a lie.
 */
function demoBannerCommand(ctx: Ctx, argv: string[]): CliResult {
  const state = positionals(argv)[0];
  if (state === undefined) {
    return { exitCode: 2, stderr: `Which one? ${DEMO_BANNER_STATES.join(", ")}\n` };
  }
  if (state === "off") {
    ctx.setDemo(null);
    return { exitCode: 0, stdout: "Demo banner off.\n" };
  }
  if (!isDemoBannerState(state)) {
    return { exitCode: 2, stderr: `"${state}" is not a demo state. Try: ${DEMO_BANNER_STATES.join(", ")}\n` };
  }
  ctx.setDemo(state);
  return { exitCode: 0, stdout: `Showing the "${state}" banner for five minutes.\n` };
}
