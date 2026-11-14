/**
 * Xcode tracker — host worker.
 *
 * bb runs this on every enrolled Mac, lazily, when the server first calls it.
 * It is how a thread whose checkout lives on another Mac gets its builds
 * tracked: the server routes `xcode_build`, `bb xcode run` and `bb xcode
 * stop` here, keyed by the thread environment's host, and it asks here about
 * the builds on that Mac nobody routed — Xcode.app's, a terminal's, Xcode's
 * own agent tools'. Pure wiring — the work lives in `src/host/builds.ts` and
 * `src/host/watch.ts`, the wire shape in `src/host/contract.ts`.
 */

import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
} from "@get-bb/plugin-sdk";

import { hostContract, hostSignals, type HostSignals } from "./src/host/contract";
import { HostBuilds, type HostBuildsDeps, type WorkerHooks } from "./src/host/builds";
import { HostWatch, type HostWatchDeps } from "./src/host/watch";

type HostContext = ExperimentalHostRpcContext<HostSignals>;

function hooksFor(context: HostContext): WorkerHooks {
  return {
    emitProgress: (buildId, progress) =>
      context.experimental_emitSignal("progress", { buildId, progress }),
    emitExited: (state) => context.experimental_emitSignal("exited", { state }),
    retainWorker: () => context.experimental_retainWorker(),
  };
}

/**
 * The entry, with its build manager's collaborators injectable.
 *
 * bb loads the default export, which takes none. Tests pass a fake xcodebuild
 * and short poll intervals; nothing else may, because the binary is the one
 * thing the checkout boundary does not cover.
 */
export function createHostEntry(
  options: Omit<HostBuildsDeps, "dataDir"> & { watch?: Omit<HostWatchDeps, "dataDir"> } = {},
) {
  const { watch: watchOptions, ...buildOptions } = options;
  let builds: HostBuilds | null = null;
  let watch: HostWatch | null = null;
  /** One manager per worker; the data dir is the same for every call. */
  const buildsFor = (context: HostContext): HostBuilds =>
    (builds ??= new HostBuilds({ ...buildOptions, dataDir: context.experimental_paths.dataDir }));
  const watchFor = (context: HostContext): HostWatch =>
    (watch ??= new HostWatch({
      findTool: buildOptions.findTool,
      xcresult: buildOptions.xcresult,
      ...watchOptions,
      dataDir: context.experimental_paths.dataDir,
    }));
  const now = buildOptions.now ?? Date.now;

  return experimental_defineHostEntry({
    contract: hostContract,
    experimental_signals: hostSignals,
    handlers: {
      validateBuild: (input, context) => buildsFor(context).validate(input),
      startBuild: (input, context) => buildsFor(context).start(input, hooksFor(context)),
      buildStates: async ({ buildIds }, context) => ({
        states: await buildsFor(context).states(buildIds, hooksFor(context)),
      }),
      summarize: ({ buildId }, context) => buildsFor(context).summarize(buildId),
      stop: ({ buildId, graceMs }, context) => buildsFor(context).stop(buildId, graceMs),
      prune: (retention, context) => buildsFor(context).prune(retention),
      probe: (_input, context) => watchFor(context).probe(now()),
      discoverRoots: (input, context) => watchFor(context).discoverRoots(input),
      readManifests: (input, context) => watchFor(context).readManifests(input),
      inspectBundles: (input, context) => watchFor(context).inspectBundles(input),
      summarizeBundle: ({ path }, context) => watchFor(context).summarizeBundle(path),
    },
    // Stops watching only. Builds carry on through a worker stop by design.
    dispose: async () => {
      const current = builds;
      builds = null;
      await current?.dispose();
    },
  });
}

export default createHostEntry();
