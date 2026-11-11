/**
 * The contract between the server entry and the `bb.host` worker.
 *
 * The worker runs on whichever enrolled Mac a thread's checkout lives on, so
 * this is the only way the server can start, watch, stop and read a tracked
 * build there. Everything crossing it is validated on both sides by bb; keep
 * it plugin-local and import-light, because `host.ts` bundles it.
 *
 * Calls are addressed by `buildId`, which the worker mints. The server never
 * hands the worker a path to act on other than the checkout it validates, so a
 * confused server cannot make the worker parse, signal or delete anything the
 * worker did not create itself.
 */

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const runStatus = z.enum([
  "running",
  "finishing",
  "passed",
  "warnings",
  "failed",
  "cancelled",
  "ended",
]);

/** A worker-minted id: base36 time, a dash, random hex. Never a path. */
export const buildIdSchema = z.string().regex(/^[a-z0-9]{1,16}-[a-f0-9]{8,32}$/);

const argvSchema = z.array(z.string().max(8192)).min(1).max(520);

const buildRequest = z
  .object({
    argv: argvSchema,
    /** The thread's checkout, as bb's environment names it on that host. */
    root: z.string().min(1).max(4096),
    /** Requested working directory; defaults to the checkout. */
    cwd: z.string().max(4096).optional(),
  })
  .strict();

const progressSchema = z
  .object({
    section: z.string().max(2000).nullable(),
    opened: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
  })
  .strict();

/**
 * What the worker knows about one build.
 *
 *  - `running`: the wrapper is alive, confirmed by pid + start time + marker.
 *  - `exited`: the wrapper wrote the exit status file.
 *  - `lost`: the wrapper is gone and wrote nothing (SIGKILL, reboot).
 *  - `unknown`: no record of that build on this Mac (data dir wiped).
 */
const buildStateSchema = z
  .object({
    buildId: buildIdSchema,
    status: z.enum(["running", "exited", "lost", "unknown"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().max(32).nullable(),
    endedAt: z.number().nullable(),
    progress: progressSchema,
    /** The last few KB xcodebuild wrote to stderr, once it has exited. */
    stderrTail: z.string().max(8192).nullable(),
  })
  .strict();

const issueSchema = z
  .object({
    severity: z.enum(["error", "warning", "analyzer", "note"]),
    message: z.string().max(4000),
    filePath: z.string().max(4096).nullable(),
    line: z.number().nullable(),
    column: z.number().nullable(),
    target: z.string().max(1000).nullable(),
  })
  .strict();

const buildResultsSchema = z
  .object({
    status: runStatus,
    startedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    errorCount: z.number(),
    warningCount: z.number(),
    analyzerCount: z.number(),
    actionTitle: z.string().max(2000).nullable(),
    destination: z.string().max(2000).nullable(),
    issues: z.array(issueSchema).max(2000),
  })
  .strict();

const testSummarySchema = z
  .object({
    status: runStatus,
    startedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    expectedFailures: z.number(),
    destination: z.string().max(2000).nullable(),
  })
  .strict();

const testRowSchema = z
  .object({
    suite: z.string().max(2000).nullable(),
    name: z.string().max(2000),
    identifier: z.string().max(4000).nullable(),
    status: z.enum(["passed", "failed", "skipped", "expected-failure", "recorded", "unknown"]),
    durationMs: z.number().nullable(),
    failureMessage: z.string().max(4000).nullable(),
    target: z.string().max(1000).nullable(),
  })
  .strict();

export const hostContract = defineRpcContract({
  /**
   * Check a build request where it will run, without starting anything.
   *
   * Called before the person is asked to confirm, so a refused argument is
   * refused with its own sentence instead of after a pointless prompt.
   */
  validateBuild: {
    input: buildRequest,
    output: z
      .discriminatedUnion("ok", [
        z.object({ ok: z.literal(true), workingDir: z.string() }).strict(),
        z.object({ ok: z.literal(false), message: z.string().max(4000) }).strict(),
      ]),
  },
  /** Validate again, then spawn xcodebuild detached and return at once. */
  startBuild: {
    input: buildRequest,
    output: z
      .discriminatedUnion("ok", [
        z
          .object({
            ok: z.literal(true),
            buildId: buildIdSchema,
            bundlePath: z.string(),
            workingDir: z.string(),
            /** The full argv xcodebuild was started with, flags injected. */
            argv: argvSchema,
            pid: z.number().int().positive(),
            startedAt: z.number(),
          })
          .strict(),
        z.object({ ok: z.literal(false), message: z.string().max(4000) }).strict(),
      ]),
  },
  /**
   * Current state of some builds. Also how a fresh worker re-adopts builds it
   * did not start: asking about one resumes watching it.
   */
  buildStates: {
    experimental_retryable: true,
    input: z.object({ buildIds: z.array(buildIdSchema).max(64) }).strict(),
    output: z.object({ states: z.array(buildStateSchema) }).strict(),
  },
  /** Parse a finished build's result bundle on the Mac that holds it. */
  summarize: {
    experimental_retryable: true,
    input: z.object({ buildId: buildIdSchema }).strict(),
    output: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("ok"),
          bundlePath: z.string(),
          build: buildResultsSchema.nullable(),
          summary: testSummarySchema.nullable(),
          tests: z.array(testRowSchema).max(10_000),
        })
        .strict(),
      /** Still running, or the bundle is not finalized yet. */
      z.object({ status: z.literal("pending") }).strict(),
      /** Nothing to parse: no record, no Xcode, or a bundle that never finalized. */
      z.object({ status: z.literal("unavailable"), reason: z.string().max(2000) }).strict(),
      /** The bundle exists but xcresulttool made nothing of it. */
      z.object({ status: z.literal("unparseable") }).strict(),
    ]),
  },
  /** Signal a running build, after proving the pid is still that build. */
  stop: {
    input: z
      .object({
        buildId: buildIdSchema,
        /** Escalate to SIGKILL on xcodebuild after this long, if it lingers. */
        graceMs: z.number().int().min(0).max(60_000).optional(),
      })
      .strict(),
    output: z
      .object({ stopped: z.boolean(), message: z.string().max(2000) })
      .strict(),
  },
  /** Retention for the builds this worker left on its Mac. */
  prune: {
    input: z
      .object({
        maxAgeMs: z.number().nonnegative(),
        maxTotalBytes: z.number().nonnegative(),
      })
      .strict(),
    output: z
      .object({
        removed: z.number().int().nonnegative(),
        bytesFreed: z.number().nonnegative(),
        bytesRetained: z.number().nonnegative(),
      })
      .strict(),
  },
});

export const hostSignals = {
  /** Live counts from the result stream, throttled by the worker. */
  progress: {
    payload: z.object({ buildId: buildIdSchema, progress: progressSchema }).strict(),
  },
  /** A build left `running`; the payload is its final state. */
  exited: {
    payload: z.object({ state: buildStateSchema }).strict(),
  },
} as const;

export type HostContract = typeof hostContract;
export type HostSignals = typeof hostSignals;
export type BuildState = z.infer<typeof buildStateSchema>;
export type BuildProgress = z.infer<typeof progressSchema>;
export type BuildRequest = z.infer<typeof buildRequest>;
export type SummarizeResult = z.output<(typeof hostContract)["summarize"]["output"]>;
export type StartBuildResult = z.output<(typeof hostContract)["startBuild"]["output"]>;
