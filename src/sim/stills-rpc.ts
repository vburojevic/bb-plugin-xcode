/**
 * The Stills RPC handlers, and the assembly of a run into what the panel
 * renders.
 *
 * `stillsRun` **enqueues and returns a look id**. The build behind it takes
 * minutes; a handler that waited for it would block the panel from rendering
 * the progress state that explains the wait.
 */
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Ctx } from "./context.js";
import { deviceKey, previewIdentity, type Look, type VerdictStatus } from "./model.js";
import {
  changeFrequency,
  getBaseline,
  getIdentityBaselines,
  getLook,
  getLookMeta,
  latestLook,
  listFrames,
  listVerdicts,
  previousOkLook,
  setBaseline,
  clearBaseline,
  setIdentityBaseline,
  clearIdentityBaselines,
  insertVerdicts,
  identityHistory,
  latestThreadLink,
  dismissThreadLink,
} from "./frames.js";
import { bannerRows, changedIdentitiesOf } from "./banner.js";
import { demoBanner } from "./demos.js";
import { isFlaky } from "./model.js";
import { summarize, rekeySentence, rekeyPrimaryLabel, truncationSentence, type VerdictRow } from "./verdict.js";
import { applyThreshold, compareCheaply, runOdiff, type FramePair } from "./diff.js";
import { beginLook, onlyTestingFor, runStills } from "./stills.js";
import { destinationFor, type BuildTarget } from "./xcodebuild.js";
import { buildPlan, existingDependency, findCandidates, describeDetection } from "./onboard.js";
import { describeBuildPath } from "./peers.js";
import { formatDuration } from "./format.js";
import { toFrameDto, imageUrl } from "./rpc.js";
import { frameAbsolutePath } from "./framestore.js";

/** How many runs back the flaky heuristic looks. */
const FLAKY_WINDOW = 5;

/** The nothing-has-run-yet summary, which is a state rather than an absence. */
function emptySummary() {
  return {
    lookId: null,
    status: "none" as const,
    sentence: "Nothing has run yet.",
    rekey: null,
    truncation: null,
    rows: [],
    counts: {
      unchanged: 0,
      changed: 0,
      "layout-changed": 0,
      added: 0,
      removed: 0,
      missing: 0,
      errored: 0,
    },
    missingOverflow: 0,
    undiffed: false,
    isBaseline: false,
    facts: [],
    progress: null,
    startedAt: null,
    endedAt: null,
  };
}

export function makeStillsHandlers(ctx: Ctx) {
  return {
    async stillsRun({
      device,
      threadId,
      projectId,
    }: {
      scope?: "changed" | "all";
      device?: string;
      threadId?: string | null;
      projectId?: string | null;
    }) {
      try {
        const hints = {
          ...(typeof threadId === "string" ? { threadId } : {}),
          ...(typeof projectId === "string" ? { projectId } : {}),
        };
        const scope = await ctx.scopeForInvocation(hints);
        if (scope === null) {
          throw new Error("Xcode Simulators could not work out which project this is.");
        }
        const approved = await ctx.confirmAction(hints, {
          title: "Run the preview test target on the host?",
          facts: [
            `Checkout: ${scope.scope.checkoutPath}`,
            "Xcode test targets and package/compiler plugins execute code as your host user.",
          ],
          confirmLabel: "Render previews",
        });
        if (!approved) throw new Error("The preview render was not confirmed.");
        const enqueued = await ctx.stills.enqueue(scope, device ?? null);
        return { lookId: enqueued.lookId, queued: enqueued.queued, error: null };
      } catch (error) {
        return {
          lookId: null,
          queued: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async stillsLatest({ lookId }: { lookId?: string }) {
      // An explicit id is not scope-filtered: it came from a directive in a
      // message in this user's own bb, and a record that refuses to render
      // because you have since switched project is not a record.
      if (lookId !== undefined) {
        const look = getLook(ctx.db, lookId);
        return look === null ? emptySummary() : summarizeLook(ctx, look);
      }
      const scope = await ctx.scopeForThread(null);
      if (scope === null) return emptySummary();
      const look = latestLook(ctx.db, scope.scope.scopeKey, "stills");
      return look === null ? emptySummary() : summarizeLook(ctx, look);
    },

    async stillsIdentityHistory({ identity, limit }: { identity: string; limit?: number }) {
      const scope = await ctx.scopeForThread(null);
      if (scope === null) return { identity, entries: [] };
      const history = identityHistory(ctx.db, scope.scope.scopeKey, identity, limit ?? 20);
      return {
        identity,
        entries: history.map((entry) => ({
          frame: toFrameDto(ctx.pluginId, entry.frame),
          lookId: entry.look.id,
          commitSha: entry.look.commitSha,
          capturedAt: entry.frame.capturedAt,
          status: entry.verdict,
        })),
      };
    },

    async stillsAcceptIdentity({ lookId, identity }: { lookId: string; identity: string }) {
      const look = getLook(ctx.db, lookId);
      if (look === null) return { ok: false };
      // Run-level baselining is all-or-nothing, and the ordinary workflow — you
      // moved the padding on three screens and one real regression rode along —
      // otherwise forces accepting all 148 previews' worth of new truth to
      // clear the three you meant.
      setIdentityBaseline(ctx.db, look.scopeKey, look.deviceKey, identity, lookId, "user", Date.now());
      ctx.publish("look");
      return { ok: true };
    },

    async baselineShow() {
      const scope = await ctx.scopeForThread(null);
      if (scope === null) {
        return { lookId: null, setAt: null, setBy: null, commitSha: null, identityCount: 0 };
      }
      const latest = latestLook(ctx.db, scope.scope.scopeKey, "stills");
      if (latest === null) {
        return { lookId: null, setAt: null, setBy: null, commitSha: null, identityCount: 0 };
      }
      const baseline = getBaseline(ctx.db, scope.scope.scopeKey, latest.deviceKey);
      const identities = getIdentityBaselines(ctx.db, scope.scope.scopeKey, latest.deviceKey);
      const baseLook = baseline === null ? null : getLook(ctx.db, baseline.lookId);
      return {
        lookId: baseline?.lookId ?? null,
        setAt: baseline?.setAt ?? null,
        setBy: baseline?.setBy ?? null,
        commitSha: baseLook?.commitSha ?? null,
        identityCount: identities.size,
      };
    },

    async baselineSet({ lookId }: { lookId: string }) {
      const look = getLook(ctx.db, lookId);
      if (look === null) return { ok: false, replaced: null };
      const existing = getBaseline(ctx.db, look.scopeKey, look.deviceKey);
      const replacedLook = existing === null ? null : getLook(ctx.db, existing.lookId);
      setBaseline(ctx.db, look.scopeKey, look.deviceKey, lookId, "user", Date.now());
      // Accepting a whole run supersedes the per-identity exceptions that were
      // carved out of the old one; keeping them would silently pin frames to a
      // baseline the user just replaced.
      clearIdentityBaselines(ctx.db, look.scopeKey, look.deviceKey);
      ctx.publish("look");
      return { ok: true, replaced: replacedLook?.commitSha ?? null };
    },

    async baselineClear() {
      const scope = await ctx.scopeForThread(null);
      if (scope === null) return { ok: false };
      const latest = latestLook(ctx.db, scope.scope.scopeKey, "stills");
      if (latest === null) return { ok: false };
      clearBaseline(ctx.db, scope.scope.scopeKey, latest.deviceKey);
      clearIdentityBaselines(ctx.db, scope.scope.scopeKey, latest.deviceKey);
      ctx.publish("look");
      return { ok: true };
    },

    async bannerState({ threadId }: { threadId: string | null }) {
      try {
        // A demo overrides everything, so the design-review loop works with no
        // simulator and no project — and expires on its own, so it cannot be
        // left on by accident.
        const demo = ctx.demo();
        if (demo !== null) return { rows: demoBanner(demo) };
        if (threadId === null) return { rows: [] };
        const link = latestThreadLink(ctx.db, threadId);
        const look = link === null ? null : getLook(ctx.db, link.lookId);
        const verdicts = look === null ? [] : listVerdicts(ctx.db, look.id);
        const baseLookId = verdicts.find((verdict) => verdict.baseLookId !== null)?.baseLookId ?? null;
        const baseLook = baseLookId === null ? null : getLook(ctx.db, baseLookId);
        return {
          rows: bannerRows({
            look:
              look === null
                ? null
                : {
                    ...look,
                    changedIdentities: changedIdentitiesOf(verdicts),
                    baseCommit: baseLook?.commitSha ?? null,
                  },
            dismissed: link?.dismissed ?? null,
            offerRuns: ctx.settings().postChangedPreviews,
          }),
        };
      } catch (error) {
        // No banner, and a log line. The banner is an offer; the panel is the
        // surface that must never lie.
        ctx.log("warn", `banner state failed: ${error instanceof Error ? error.message : String(error)}`);
        return { rows: [] };
      }
    },

    async bannerDismiss({ threadId, lookId, watermark }: { threadId: string; lookId: string; watermark: string }) {
      dismissThreadLink(ctx.db, threadId, lookId, watermark);
      return { ok: true };
    },

    async onboardPlan({ project, wait }: { project?: string; wait?: boolean }) {
      return planOnboarding(ctx, project ?? null, wait === true);
    },

    async onboardApply({ project }: { project?: string }) {
      // Applying is always a foreground act, so it always waits.
      const plan = await planOnboarding(ctx, project ?? null, true);
      if (plan.conflict !== null) {
        return { written: [], manualSteps: plan.manualSteps, error: plan.conflict };
      }
      if (plan.checkoutElsewhere !== null) {
        return { written: [], manualSteps: plan.manualSteps, error: plan.checkoutElsewhere };
      }
      const written = await ctx.writeOnboardingFiles(plan.files);
      return { written, manualSteps: plan.manualSteps, error: null };
    },
  };
}

// ---------------------------------------------------------------------------
// Assembling a run
// ---------------------------------------------------------------------------

export async function summarizeLook(ctx: Ctx, look: Look) {
  const frames = listFrames(ctx.db, look.id);
  const verdicts = listVerdicts(ctx.db, look.id);
  const meta = getLookMeta(ctx.db, look.id);
  const byIdentity = new Map(frames.map((frame) => [frame.identity, frame]));
  const verdictByIdentity = new Map(verdicts.map((verdict) => [verdict.identity, verdict]));

  const baseline = getBaseline(ctx.db, look.scopeKey, look.deviceKey);
  const baseLookId = verdicts.find((verdict) => verdict.baseLookId !== null)?.baseLookId ?? null;
  const baseLook = baseLookId === null ? null : getLook(ctx.db, baseLookId);
  const baseFrames = baseLook === null ? [] : listFrames(ctx.db, baseLook.id);
  const baseByIdentity = new Map(baseFrames.map((frame) => [frame.identity, frame]));

  const rows: VerdictRow[] = [];
  const identities = new Set([...byIdentity.keys(), ...verdictByIdentity.keys()]);
  for (const identity of identities) {
    const frame = byIdentity.get(identity) ?? null;
    const verdict = verdictByIdentity.get(identity);
    const status: VerdictStatus = verdict?.status ?? (baseLook === null ? "added" : "unchanged");
    const frequency = changeFrequency(ctx.db, look.scopeKey, identity, FLAKY_WINDOW);
    const flaky = isFlaky(frequency.changedRuns, frequency.totalRuns);
    rows.push({
      identity,
      displayName: frame?.displayName ?? identity.replace(/^preview:/, ""),
      groupName: frame?.groupName ?? "",
      status,
      diffRatio: verdict?.diffRatio ?? null,
      flaky,
      // The fact, which is shorter than defending the word "flaky".
      flakyDetail: flaky
        ? `changed in ${frequency.changedRuns} of the last ${frequency.totalRuns} runs`
        : null,
    });
  }

  const summary = summarize({
    look,
    rows,
    manifest: meta.manifest ?? [],
    baseCommit: baseLook?.commitSha ?? null,
    firstRun: baseLook === null && look.status === "ok",
    undiffed: meta.diffed === false,
  });

  const withImages = summary.rows.map((row) => {
    const frame = byIdentity.get(row.identity) ?? null;
    const base = baseByIdentity.get(row.identity) ?? null;
    const verdict = verdictByIdentity.get(row.identity);
    return {
      ...row,
      frame: frame === null ? null : toFrameDto(ctx.pluginId, frame),
      maskUrl:
        frame === null || verdict?.maskRelPath == null
          ? null
          : imageUrl(ctx.pluginId, frame, "mask"),
      baseUrl: base === null ? null : imageUrl(ctx.pluginId, base, "frame"),
      baseWidth: base?.width ?? null,
      baseHeight: base?.height ?? null,
    };
  });

  return {
    lookId: look.id,
    status: look.status,
    sentence: summary.sentence,
    rekey:
      summary.rekey === null
        ? null
        : {
            ...summary.rekey,
            sentence: rekeySentence(summary.rekey),
            primaryLabel: rekeyPrimaryLabel(summary.rekey),
          },
    truncation:
      summary.truncation === null
        ? null
        : { ...summary.truncation, sentence: truncationSentence(summary.truncation) },
    rows: withImages,
    counts: summary.counts,
    missingOverflow: summary.missingOverflow,
    undiffed: summary.undiffed,
    isBaseline: baseline?.lookId === look.id,
    facts: factsFor(ctx, look, meta, baseLook),
    progress:
      look.status === "running"
        ? { done: look.frameCount, total: look.expectedCount }
        : null,
    startedAt: look.startedAt,
    endedAt: look.endedAt,
  };
}

/**
 * The Facts section: only what the sentence above does not already carry.
 */
function factsFor(
  ctx: Ctx,
  look: Look,
  meta: ReturnType<typeof getLookMeta>,
  baseLook: Look | null,
): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  if (look.deviceName !== null) {
    facts.push({
      label: "Device",
      value: `${look.deviceName}, iOS ${look.osVersion ?? "?"}${look.scale === null ? "" : ` @${look.scale}x`}`,
    });
  }
  if (meta.arch !== undefined) facts.push({ label: "Architecture", value: meta.arch });
  if (meta.scheme !== undefined) facts.push({ label: "Scheme", value: meta.scheme });
  if (meta.buildVia !== undefined) {
    facts.push({ label: "Build", value: describeBuildPath(meta.buildVia) });
  }
  // Only when it differs from the verdict sentence, which already names it.
  if (baseLook?.commitSha != null && baseLook.commitSha !== look.commitSha) {
    facts.push({ label: "Compared against", value: baseLook.commitSha.slice(0, 7) });
  }
  if (look.endedAt !== null) {
    facts.push({ label: "Took", value: formatDuration(look.endedAt - look.startedAt) });
  }
  facts.push({
    label: "Threshold",
    value: `${meta.threshold ?? ctx.settings().diffThreshold} of the pixels, unless a preview overrides it`,
  });
  facts.push({ label: "Manifest", value: look.manifestRan ? "ran" : "did not run" });
  if (meta.serveSimVersion !== undefined) {
    facts.push({ label: "serve-sim", value: meta.serveSimVersion });
  }
  if (meta.snapshotPreviewsVersion !== undefined) {
    facts.push({ label: "SnapshotPreviews", value: meta.snapshotPreviewsVersion });
  }
  // `EMGInvocationCreator` hooks gettimeofday to 2024-08-13 07:00:00 UTC unless
  // EMERGE_DISABLE_FIX_TIME=1, and the hook is compiled out entirely on x86_64.
  // `time()`, `mach_absolute_time()` and Date() paths that skip it are
  // untouched, so a view mixing both produces inconsistent timestamps.
  facts.push({
    label: "Clock",
    value:
      meta.arch === "x64"
        ? "Not pinned on Intel — the time hook is compiled out on x86_64"
        : "Pinned to 2024-08-13 07:00 UTC (partial: only gettimeofday)",
  });
  return facts;
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

export async function planOnboarding(ctx: Ctx, projectOverride: string | null, wait = false) {
  const scope = await ctx.scopeForThread(null);
  if (scope === null) {
    return {
      candidates: [],
      detected: null,
      files: [],
      manualSteps: [],
      conflict: null,
      alreadyDone: [],
      checkoutElsewhere: null,
      searched: null,
    };
  }

  const checkout = scope.scope.checkoutPath;
  const candidates = await findCandidates(checkout);
  const chosen =
    projectOverride !== null
      ? (candidates.find((candidate) => candidate.relPath === projectOverride) ?? null)
      : (candidates[0] ?? null);

  if (chosen === null) {
    return {
      candidates: candidates.map((candidate) => ({ shape: candidate.shape, relPath: candidate.relPath })),
      detected: null,
      files: [],
      manualSteps: [],
      conflict: null,
      alreadyDone: [],
      checkoutElsewhere: scope.checkoutElsewhere,
      searched: checkout,
    };
  }

  // Answered from the cache. A miss returns the candidates — a cheap directory
  // walk — with `detected: null`, and the detection lands via a realtime
  // signal rather than by holding this handler open for a minute.
  const request = { checkoutPath: checkout, relPath: chosen.relPath, scheme: ctx.settings().scheme };
  const detected = wait
    ? ({ status: "ready", project: await ctx.detection.resolve(request) } as const)
    : ctx.detection.get(request);
  if (detected.status === "detecting" || detected.project === null) {
    return {
      candidates: candidates.map((candidate) => ({ shape: candidate.shape, relPath: candidate.relPath })),
      detected: null,
      files: [],
      manualSteps: [],
      conflict: null,
      alreadyDone: [],
      checkoutElsewhere: scope.checkoutElsewhere,
      searched: checkout,
    };
  }

  const project = detected.project;
  const existing = await existingDependency(checkout, chosen);
  const plan = buildPlan({ checkoutPath: checkout, project, candidate: chosen, existing });

  return {
    candidates: candidates.map((candidate) => ({ shape: candidate.shape, relPath: candidate.relPath })),
    detected: {
      shape: project.shape,
      relPath: project.relPath,
      schemes: project.schemes,
      targets: project.targets,
      scheme: project.scheme,
      appTarget: project.appTarget,
      snapshotTestTarget: project.snapshotTestTarget,
      summary: describeDetection(project),
    },
    files: plan.files.map((file) => ({ relPath: file.relPath, contents: file.contents })),
    manualSteps: plan.manualSteps,
    conflict: plan.conflict,
    alreadyDone: plan.alreadyDone,
    checkoutElsewhere: scope.checkoutElsewhere,
    searched: checkout,
  };
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

export interface RunRequest {
  scopeKey: string;
  projectId: string;
  checkoutPath: string;
  device: { udid: string; name: string; osVersion: string };
  scale: number;
  commitSha: string | null;
  branch: string | null;
  target: BuildTarget;
  testTargetName: string | null;
  odiffPath: string | null;
  globalThreshold: number;
}

/**
 * Render, then compare.
 *
 * The comparison is a separate phase on purpose: a run that rendered but could
 * not be compared is still a useful run, and the verdict says so rather than
 * failing.
 */
export async function runAndCompare(ctx: Ctx, request: RunRequest, signal: AbortSignal): Promise<string> {
  const now = Date.now;
  const lookId = beginLook(ctx.db, {
    scopeKey: request.scopeKey,
    projectId: request.projectId,
    device: request.device,
    scale: request.scale,
    commitSha: request.commitSha,
    branch: request.branch,
    now: now(),
  });
  ctx.publish("look");

  const workDir = await mkdtemp(join(tmpdir(), "xcsim-run-"));
  const result = await (async () => {
    try {
      return await runStills({
        db: ctx.db,
        store: ctx.store,
        lookId,
        scopeKey: request.scopeKey,
        projectId: request.projectId,
        checkoutPath: request.checkoutPath,
        target: {
          ...request.target,
          destination: destinationFor(request.device.udid),
          // Per run and private. The bundles are useful while xcodebuild is
          // running but are not part of the Stills record; retaining three
          // directory trees forever made the frame disk budget meaningless.
          resultBundlePath: join(workDir, "results"),
        },
        onlyTesting: onlyTestingFor(request.testTargetName),
        testTargetName: request.testTargetName,
        device: request.device,
        commitSha: request.commitSha,
        branch: request.branch,
        scale: request.scale,
        workDir,
        signal,
        now,
        log: (message) => ctx.log("info", `stills ${lookId}: ${message}`),
        beforeImport: (incomingBytes) => ctx.beforeFrameImport(incomingBytes),
      });
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  })();

  if (result.frameCount > 0) {
    await compareAgainstBaseline(ctx, lookId, result.missing, request);
  }
  ctx.publish("look");
  return lookId;
}

/**
 * Compare a finished run against its base.
 *
 * Resolution order per identity is identity baseline, then run baseline, then
 * the previous successful run — which is what a person means by "since".
 */
export async function compareAgainstBaseline(
  ctx: Ctx,
  lookId: string,
  missingNames: readonly string[],
  request: RunRequest,
): Promise<void> {
  const look = getLook(ctx.db, lookId);
  if (look === null) return;

  const runBaseline = getBaseline(ctx.db, look.scopeKey, look.deviceKey);
  const identityBaselines = getIdentityBaselines(ctx.db, look.scopeKey, look.deviceKey);
  const fallback = previousOkLook(ctx.db, look.scopeKey, look.deviceKey, lookId);
  const baseLookId = runBaseline?.lookId ?? fallback?.id ?? null;

  const headFrames = listFrames(ctx.db, lookId);
  const missing = new Set(missingNames.map((name) => previewIdentity(name)));

  // Frames from every base a row might resolve to, loaded once.
  const baseCache = new Map<string, Map<string, ReturnType<typeof listFrames>[number]>>();
  const framesOf = (id: string) => {
    let frames = baseCache.get(id);
    if (frames === undefined) {
      frames = new Map(listFrames(ctx.db, id).map((frame) => [frame.identity, frame]));
      baseCache.set(id, frames);
    }
    return frames;
  };

  const verdicts = [];
  const identities = new Set([...headFrames.map((frame) => frame.identity), ...missing]);

  for (const identity of identities) {
    const head = headFrames.find((frame) => frame.identity === identity) ?? null;
    const baseFor = identityBaselines.get(identity)?.lookId ?? baseLookId;
    const base = baseFor === null ? null : (framesOf(baseFor).get(identity) ?? null);

    const pair: FramePair = {
      identity,
      base:
        base === null
          ? null
          : { contentHash: base.contentHash, width: base.width, height: base.height, relPath: base.relPath },
      head:
        head === null
          ? null
          : {
              contentHash: head.contentHash,
              width: head.width,
              height: head.height,
              relPath: head.relPath,
              diffThreshold: head.diffThreshold,
            },
    };

    const cheap = compareCheaply(pair, missing);
    if (cheap !== null) {
      verdicts.push({
        lookId,
        baseLookId: baseFor,
        identity,
        status: cheap.status,
        diffRatio: cheap.diffRatio,
        diffPixels: cheap.diffPixels,
        maskRelPath: null,
        error: null,
      });
      continue;
    }

    if (request.odiffPath === null || head === null || base === null || baseFor === null) {
      // Rendered but not compared. The verdict sentence says so.
      verdicts.push({
        lookId,
        baseLookId: baseFor,
        identity,
        status: "unchanged" as VerdictStatus,
        diffRatio: null,
        diffPixels: null,
        maskRelPath: null,
        error: null,
      });
      continue;
    }

    const maskRelPath = `${identity.replace(/^preview:/, "").replace(/\.png$/, "")}.mask.png`;
    const basePath = frameAbsolutePath(ctx.framesRoot, {
      scopeKey: look.scopeKey,
      lookId: baseFor,
      relPath: base.relPath,
    });
    const headPath = frameAbsolutePath(ctx.framesRoot, {
      scopeKey: look.scopeKey,
      lookId,
      relPath: head.relPath,
    });
    const maskPath = frameAbsolutePath(ctx.framesRoot, {
      scopeKey: look.scopeKey,
      lookId,
      relPath: maskRelPath,
    });
    if (basePath === null || headPath === null || maskPath === null) continue;

    const output = await runOdiff({
      odiffPath: request.odiffPath,
      basePath,
      headPath,
      maskPath,
      width: head.width,
      height: head.height,
    });
    const status = applyThreshold(output, head.diffThreshold, request.globalThreshold);
    verdicts.push({
      lookId,
      baseLookId: baseFor,
      identity,
      status,
      diffRatio: output.diffRatio,
      diffPixels: output.diffPixels,
      maskRelPath: status === "changed" && output.maskWritten ? maskRelPath : null,
      error: output.error,
    });
  }

  // Anything in the base that the head no longer has is `removed` — which is a
  // different fact from `missing`, and the manifest is what tells them apart.
  if (baseLookId !== null) {
    const headIdentities = new Set(headFrames.map((frame) => frame.identity));
    for (const [identity] of framesOf(baseLookId)) {
      if (headIdentities.has(identity) || missing.has(identity)) continue;
      verdicts.push({
        lookId,
        baseLookId,
        identity,
        status: "removed" as VerdictStatus,
        diffRatio: null,
        diffPixels: null,
        maskRelPath: null,
        error: null,
      });
    }
  }

  insertVerdicts(ctx.db, verdicts);
}

export { deviceKey };
