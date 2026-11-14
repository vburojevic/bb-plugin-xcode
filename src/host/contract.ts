/**
 * The contract between the server entry and the `bb.host` worker.
 *
 * The worker runs on whichever enrolled Mac a thread's checkout lives on, so
 * this is the only way the server can start, watch, stop and read a tracked
 * build there. Everything crossing it is validated on both sides by bb; keep
 * it plugin-local and import-light, because `host.ts` bundles it.
 *
 * Calls are addressed by `buildId`. The server mints it and records the run
 * BEFORE asking for the start, so a start whose reply is lost is still known
 * and can be recovered by asking about that id; the worker treats a repeated
 * start of a recorded id as the same build. The id's format admits no path
 * characters, and the server never hands the worker a path to act on other
 * than the checkout it validates, so a confused server cannot make the worker
 * parse, signal or delete anything the worker did not create itself.
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

/** A build id: base36 time, a dash, random hex. Never a path. */
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

const startRequest = z
  .object({
    buildId: buildIdSchema,
    argv: argvSchema,
    root: z.string().min(1).max(4096),
    cwd: z.string().max(4096).optional(),
  })
  .strict();

/** What the worker recorded at start; enough to adopt a run whose reply was lost. */
const startedSchema = z
  .object({
    bundlePath: z.string(),
    workingDir: z.string(),
    /** The full argv xcodebuild was started with, flags injected. */
    argv: argvSchema,
    pid: z.number().int().positive(),
    startedAt: z.number(),
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
    /** The worker's record of the start; null when it has none. */
    started: startedSchema.nullable(),
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

/** An absolute path on the Mac the worker runs on. */
const machinePath = z.string().min(1).max(4096).startsWith("/");

const runKind = z.enum([
  "build",
  "test",
  "archive",
  "clean",
  "analyze",
  "install",
  "export",
  "docbuild",
  "package",
  "index",
  "unknown",
]);

const buildPhase = z.enum([
  "preparing",
  "resolving",
  "compiling",
  "assets",
  "linking",
  "packaging",
  "signing",
  "testing",
]);

/** One Xcode build seen in the Mac's process table, as `findRootActivities` reports it. */
const activitySchema = z
  .object({
    pid: z.number().int().positive(),
    comm: z.string().max(256),
    args: z.string().max(4000),
    startedAt: z.number(),
    roots: z.array(z.string().max(4096)).max(32),
    workerCount: z.number().int().nonnegative(),
    phase: buildPhase.nullable(),
    currentFile: z.string().max(1000).nullable(),
    isDaemon: z.boolean(),
    actionStartedAt: z.number().nullable(),
    kind: runKind,
    scheme: z.string().max(1000).nullable(),
    container: z.string().max(4096).nullable(),
    configuration: z.string().max(1000).nullable(),
    destination: z.string().max(2000).nullable(),
    derivedDataPath: z.string().max(4096).nullable(),
    resultBundlePath: z.string().max(4096).nullable(),
    cwd: z.string().max(4096).nullable(),
    branch: z.string().max(1000).nullable(),
    worktree: z.string().max(1000).nullable(),
  })
  .strict();

/** The fields of a log-store entry the server folds. */
const manifestRecordSchema = z
  .object({
    uniqueIdentifier: z.string().max(200),
    title: z.string().max(2000).nullable(),
    startedAt: z.number().nullable(),
    endedAt: z.number().nullable(),
    status: runStatus,
    errorCount: z.number(),
    warningCount: z.number(),
    analyzerCount: z.number(),
    testFailureCount: z.number(),
  })
  .strict();

const summarizeOutput = z.discriminatedUnion("status", [
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
]);

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
  /**
   * Validate again, then spawn xcodebuild detached and return at once.
   * Idempotent per `buildId`: a build already recorded under it is returned,
   * never started twice.
   */
  startBuild: {
    input: startRequest,
    output: z.discriminatedUnion("ok", [
      startedSchema.extend({ ok: z.literal(true), buildId: buildIdSchema }).strict(),
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
    output: summarizeOutput,
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
  // ---- Watching builds this plugin did not start (Xcode.app, terminals) ----
  //
  // Read-only. Every path below is checked here, on the Mac it names, and the
  // worker reads nothing outside DerivedData roots, the bundles builds on this
  // Mac have named, and its own data directory.

  /**
   * The Xcode builds running on this Mac now: `ps`, then each build's
   * working directory, git branch and workspace, read here. Builds this
   * worker runs itself (`startBuild`) are left out: they are tracked already.
   */
  probe: {
    experimental_retryable: true,
    input: z.object({}).strict(),
    output: z
      .object({
        activities: z.array(activitySchema).max(64),
        /** Every build service alive on this Mac, reported or not. */
        services: z
          .array(z.object({ pid: z.number().int(), startedAt: z.number().nullable() }).strict())
          .max(64)
          .optional(),
      })
      .strict(),
  },
  /**
   * DerivedData roots on this Mac: Xcode's shared location in this user's
   * home, and any found by scanning the given checkouts.
   */
  discoverRoots: {
    experimental_retryable: true,
    input: z.object({ projectPaths: z.array(machinePath).max(64) }).strict(),
    output: z
      .object({
        roots: z
          .array(
            z
              .object({
                path: z.string(),
                via: z.enum(["default", "project-scan"]),
                projectPath: z.string().nullable(),
              })
              .strict(),
          )
          .max(500),
      })
      .strict(),
  },
  /**
   * The Build and Test log-store manifests of some roots, newest entries
   * first. A root whose manifests have not changed since `ifModifiedSince`
   * comes back with no domains; a root left out of the reply (not a root,
   * or over the reply budget) was not read.
   */
  readManifests: {
    experimental_retryable: true,
    input: z
      .object({
        roots: z
          .array(z.object({ path: machinePath, ifModifiedSince: z.number().nullable() }).strict())
          .max(200),
        /** Entries that started before this are left out. */
        notBefore: z.number().nullable(),
      })
      .strict(),
    output: z
      .object({
        roots: z
          .array(
            z
              .object({
                root: z.string(),
                workspace: z.string().max(4096).nullable(),
                domains: z
                  .array(
                    z
                      .object({
                        kind: z.enum(["build", "test"]),
                        mtimeMs: z.number().nullable(),
                        entries: z.array(manifestRecordSchema).max(1000),
                      })
                      .strict(),
                  )
                  .max(2),
              })
              .strict(),
          )
          .max(200),
      })
      .strict(),
  },
  /**
   * The result bundles worth reading on this Mac: those Xcode left in the
   * roots' Test logs, the shim's, and those of `paths` a build here named;
   * plus which of them xcodebuild has finalized.
   */
  inspectBundles: {
    experimental_retryable: true,
    input: z
      .object({
        roots: z.array(machinePath).max(200),
        paths: z.array(machinePath).max(500),
      })
      .strict(),
    output: z
      .object({
        candidates: z.array(z.string()).max(4000),
        finalized: z.array(z.string()).max(4000),
      })
      .strict(),
  },
  /** Parse a result bundle `inspectBundles` would list, on this Mac. */
  summarizeBundle: {
    experimental_retryable: true,
    input: z.object({ path: machinePath }).strict(),
    output: z.union([
      summarizeOutput,
      /** Not a bundle this worker will read: never ask about it again. */
      z.object({ status: z.literal("refused"), reason: z.string().max(2000) }).strict(),
    ]),
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
        /** Builds still on this Mac afterwards, running or retained. */
        remaining: z.number().int().nonnegative(),
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
export type StartRequest = z.infer<typeof startRequest>;
export type BuildStarted = z.infer<typeof startedSchema>;
export type SummarizeResult = z.output<(typeof hostContract)["summarize"]["output"]>;
export type WireActivity = z.infer<typeof activitySchema>;
export type ManifestReadReply = z.output<(typeof hostContract)["readManifests"]["output"]>;
export type DiscoverRootsReply = z.output<(typeof hostContract)["discoverRoots"]["output"]>;
export type SummarizeBundleResult = z.output<(typeof hostContract)["summarizeBundle"]["output"]>;
export type InspectBundlesReply = z.output<(typeof hostContract)["inspectBundles"]["output"]>;
export type StartBuildResult = z.output<(typeof hostContract)["startBuild"]["output"]>;
