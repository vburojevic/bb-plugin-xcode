/**
 * Everything the collector reads from a Mac, behind one interface.
 *
 * The collector decides what to read and what it means; a `MachineIO` reads
 * it on one particular Mac. `LocalMachine` is the machine running bb — the
 * same `ps`, `lsof` and file reads the collector always made. The other Macs
 * a thread can have a checkout on are read through their `bb.host` worker by
 * `RemoteMachine` (`src/remote-watch.ts`), so a path is always read, and
 * checked, on the Mac it names.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { readTextFileBounded } from "./bounded-file";
import {
  discoverDefaultRoots,
  discoverProjectRoots,
  findTestResultBundles,
  looksLikeDerivedRoot,
} from "./discovery";
import { xcresultJson } from "./exec";
import { LOG_DOMAINS, parseManifest } from "./manifest";
import { ProcessObserver, readRootWorkspace } from "./observe";
import { listShimBundles } from "./shim";
import type { BuildResults, LiveActivity, RunStatus, TestResults, TestRow } from "./types";
import { parseBuildResults, parseTestNodes, parseTestSummary } from "./xcresult";

/** Xcode's plist is normally KB; this prevents a corrupt root from exhausting memory. */
export const MAX_LOG_MANIFEST_BYTES = 32 * 1024 * 1024;

export interface DiscoveredRoot {
  path: string;
  via: "default" | "manual" | "project-scan";
  /** For a project scan, the directory that was scanned. */
  projectPath: string | null;
}

/** The fields of a log-store entry the engine folds. */
export interface ManifestRecord {
  uniqueIdentifier: string;
  title: string | null;
  startedAt: number | null;
  endedAt: number | null;
  status: RunStatus;
  errorCount: number;
  warningCount: number;
  analyzerCount: number;
  testFailureCount: number;
}

export interface RootManifests {
  root: string;
  /** The workspace or project the root belongs to, from its `info.plist`. */
  workspace: string | null;
  domains: Array<{
    kind: "build" | "test";
    /** The manifest's modification time, when the reader looked. */
    mtimeMs: number | null;
    entries: ManifestRecord[];
  }>;
}

export interface BundleListing {
  /** Every bundle worth considering, in the order they should be read. */
  candidates: string[];
  /** The subset xcodebuild has finalized (its root `Info.plist` exists). */
  finalized: Set<string>;
}

export type ParsedBundle =
  | {
      status: "ok";
      build: BuildResults | null;
      summary: Omit<TestResults, "tests"> | null;
      tests: TestRow[];
    }
  /** xcresulttool made nothing of it: still being written, or corrupt. */
  | { status: "empty" }
  /** Not readable here at all (no Xcode); try again later, not a failure. */
  | { status: "unavailable"; reason: string }
  /** The machine will never read this one; stop asking. */
  | { status: "refused"; reason: string };

export interface MachineIO {
  /** The Xcode builds running there now; null when there is no answer. */
  snapshot(now: number, signal?: AbortSignal): Promise<LiveActivity[] | null>;
  discoverRoots(request: {
    projectPaths: readonly string[];
    extraRoots: readonly string[];
  }): Promise<DiscoveredRoot[]>;
  /**
   * The Build and Test log-store manifests of some roots. A root may be
   * answered with no domains when its manifests have not changed since
   * `ifModifiedSince`; a root missing from the answer was not read.
   */
  readManifests(
    roots: ReadonlyArray<{ path: string; ifModifiedSince: number | null }>,
    signal?: AbortSignal,
  ): Promise<RootManifests[]>;
  listBundles(roots: readonly string[], claimed: readonly string[]): Promise<BundleListing>;
  parseBundle(path: string): Promise<ParsedBundle>;
}

/** The machine running bb. */
export class LocalMachine implements MachineIO {
  private readonly workspaces = new Map<string, string | null>();
  private readonly observer: ProcessObserver;

  constructor(
    private readonly deps: {
      dataDir: string;
      /** xcresulttool, resolved once and shared with the overview. */
      resolveTool(): Promise<string | null>;
      observer?: ProcessObserver;
    },
  ) {
    this.observer = deps.observer ?? new ProcessObserver();
  }

  snapshot(now: number, signal?: AbortSignal): Promise<LiveActivity[] | null> {
    return this.observer.snapshot(now, signal);
  }

  async discoverRoots(request: {
    projectPaths: readonly string[];
    extraRoots: readonly string[];
  }): Promise<DiscoveredRoot[]> {
    const found: DiscoveredRoot[] = [];
    for (const path of await discoverDefaultRoots()) {
      found.push({ path, via: "default", projectPath: null });
    }
    for (const root of request.extraRoots) {
      if (!root.startsWith("/")) continue;
      if (!(await looksLikeDerivedRoot(root))) continue;
      found.push({ path: root, via: "manual", projectPath: null });
    }
    for (const projectPath of request.projectPaths) {
      for (const path of await discoverProjectRoots(projectPath)) {
        found.push({ path, via: "project-scan", projectPath });
      }
    }
    return found;
  }

  /** Reads every manifest every time, as this machine always has. */
  async readManifests(
    roots: ReadonlyArray<{ path: string; ifModifiedSince: number | null }>,
    signal?: AbortSignal,
  ): Promise<RootManifests[]> {
    const out: RootManifests[] = [];
    for (const { path: root } of roots) {
      if (signal?.aborted) break;
      const domains: RootManifests["domains"] = [];
      for (const domain of LOG_DOMAINS) {
        const manifestPath = join(root, "Logs", domain.dir, "LogStoreManifest.plist");
        let xml: string;
        try {
          xml = await readTextFileBounded(manifestPath, MAX_LOG_MANIFEST_BYTES);
        } catch {
          continue;
        }
        domains.push({ kind: domain.kind, mtimeMs: null, entries: parseManifest(xml) });
      }
      out.push({ root, workspace: await this.workspaceOf(root), domains });
    }
    return out;
  }

  async listBundles(roots: readonly string[], claimed: readonly string[]): Promise<BundleListing> {
    const candidates = new Set<string>(await listShimBundles(this.deps.dataDir));
    for (const path of claimed) candidates.add(path);
    for (const root of roots) {
      for (const bundle of await findTestResultBundles(root)) candidates.add(bundle);
    }
    const finalized = new Set<string>();
    for (const bundle of candidates) {
      if (await isFinalized(bundle)) finalized.add(bundle);
    }
    return { candidates: [...candidates], finalized };
  }

  async parseBundle(path: string): Promise<ParsedBundle> {
    const tool = await this.deps.resolveTool();
    if (!tool) return { status: "unavailable", reason: "xcresulttool was not found." };
    return parseBundleWith(tool, path, xcresultJson);
  }

  private async workspaceOf(root: string): Promise<string | null> {
    const cached = this.workspaces.get(root);
    if (cached !== undefined) return cached;
    const workspace = await readRootWorkspace(root);
    if (workspace !== null) this.workspaces.set(root, workspace);
    return workspace;
  }
}

/**
 * Root Info.plist only exists once xcodebuild finalizes the bundle (verified
 * on disk: an in-progress or killed bundle has only Data/).
 */
export async function isFinalized(bundle: string): Promise<boolean> {
  return stat(join(bundle, "Info.plist"))
    .then((info) => info.isFile())
    .catch(() => false);
}

/** Read a finalized bundle with xcresulttool: build results, then tests. */
export async function parseBundleWith(
  tool: string,
  path: string,
  query: (tool: string, args: readonly string[]) => Promise<unknown | null>,
): Promise<ParsedBundle> {
  const build = parseBuildResults(await query(tool, ["get", "build-results", "--path", path]));
  const summary = parseTestSummary(
    await query(tool, ["get", "test-results", "summary", "--path", path]),
  );
  if (!build && !summary) return { status: "empty" };
  const tests =
    summary && summary.total > 0
      ? parseTestNodes(await query(tool, ["get", "test-results", "tests", "--path", path]))
      : [];
  return { status: "ok", build, summary, tests };
}
