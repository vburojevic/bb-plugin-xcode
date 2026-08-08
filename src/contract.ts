/**
 * RPC contract shared by `server.ts` and `app.tsx`.
 *
 * The frontend imports only the *type* of `rpcContract`, so this module and
 * its zod dependency are erased from the app bundle.
 */

import { defineRpcContract } from "@bb/plugin-sdk";
import { z } from "zod";

export { XCODE_CHANNEL } from "./channel";

const runStatus = z.enum([
  "running",
  "finishing",
  "passed",
  "warnings",
  "failed",
  "cancelled",
  "ended",
]);

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

const runSchema = z.object({
  id: z.string(),
  status: runStatus,
  kind: runKind,
  scheme: z.string().nullable(),
  container: z.string().nullable(),
  configuration: z.string().nullable(),
  destination: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  root: z.string().nullable(),
  cwd: z.string().nullable(),
  pid: z.number().nullable(),
  cmdline: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  errorCount: z.number(),
  warningCount: z.number(),
  analyzerCount: z.number(),
  testTotal: z.number().nullable(),
  testFailed: z.number().nullable(),
  testSkipped: z.number().nullable(),
  bundlePath: z.string().nullable(),
  detailed: z.boolean(),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  /** Friendly destination ("iPhone 16 · iOS 26.0"), raw spec preserved above. */
  destinationLabel: z.string().nullable(),
  /** Live compiler processes right now; null unless running. */
  workerCount: z.number().nullable(),
});

const findingSchema = z.object({
  severity: z.enum(["error", "warning", "analyzer"]),
  message: z.string(),
  filePath: z.string().nullable(),
  line: z.number().nullable(),
  target: z.string().nullable(),
});

const testSchema = z.object({
  suite: z.string().nullable(),
  name: z.string(),
  status: z.enum(["passed", "failed", "skipped", "expected-failure", "unknown"]),
  durationMs: z.number().nullable(),
  failureMessage: z.string().nullable(),
  target: z.string().nullable(),
});

export const rpcContract = defineRpcContract({
  overview: {
    input: z
      .object({
        projectId: z.string().nullable().optional(),
        kind: runKind.nullable().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    output: z.object({
      runs: z.array(runSchema),
      total: z.number(),
      projects: z.array(
        z.object({ id: z.string(), name: z.string(), path: z.string() }),
      ),
      rootCount: z.number(),
      lastScanAt: z.number().nullable(),
      xcodeAvailable: z.boolean(),
      shimActive: z.boolean(),
      simulators: z.array(
        z.object({
          udid: z.string(),
          name: z.string(),
          os: z.string(),
          state: z.string(),
        }),
      ),
    }),
  },

  runDetail: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({
      run: runSchema.nullable(),
      findings: z.array(findingSchema),
      tests: z.array(testSchema),
    }),
  },

  trends: {
    input: z
      .object({
        projectId: z.string().nullable().optional(),
        days: z.number().int().min(1).max(180).optional(),
      })
      .strict(),
    output: z.object({
      durations: z.array(
        z.object({
          at: z.number(),
          durationMs: z.number(),
          status: runStatus,
          scheme: z.string().nullable(),
          kind: runKind,
        }),
      ),
      daily: z.array(
        z.object({
          day: z.string(),
          total: z.number(),
          failed: z.number(),
          passed: z.number(),
          avgDurationMs: z.number().nullable(),
        }),
      ),
      flakyTests: z.array(
        z.object({
          name: z.string(),
          suite: z.string().nullable(),
          failures: z.number(),
          runs: z.number(),
        }),
      ),
    }),
  },

  rescan: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), rootCount: z.number() }),
  },
});
