/**
 * Where a tracked build runs, and the one door every surface uses to start it.
 *
 * `bb xcode run`, `bb xcode run --wait` and `xcode_build` used to spawn
 * xcodebuild in the server process unconditionally, and refused a thread
 * whose checkout lived on another enrolled Mac, because every check below
 * read the server's disk. Now the thread's environment decides: a checkout on
 * this machine builds here exactly as before (`wrapped.ts`), and one on
 * another Mac builds there, through that Mac's host worker (`remote.ts`).
 * Either way the checkout boundary is enforced on the disk the build uses.
 */

import { confinedBuildCwd, validateBuildArguments } from "./build-security";
import type { Run } from "./model";
import type { RemoteBuilds } from "./remote";
import type { ThreadScope } from "./scopes";
import { startWrappedBuild, type WrappedDeps, type WrappedOutcome } from "./wrapped";

export interface HostSummary {
  id: string;
  name: string;
}

export type BuildTarget =
  | { kind: "local"; machineName: string | null }
  | { kind: "remote"; hostId: string; machineName: string };

/**
 * Pick the machine a scope's builds run on.
 *
 * Local unless the checkout is known to be on a different host than this
 * server. Unknown identities fail toward local — the single-machine setup
 * every existing user has — exactly as the old refusal failed open.
 */
export function buildTargetFor(
  scope: Pick<ThreadScope, "hostId">,
  serverHostId: string | null,
  hosts: readonly HostSummary[],
): BuildTarget {
  const serverName = hosts.find((host) => host.id === serverHostId)?.name ?? null;
  if (scope.hostId === null || serverHostId === null || scope.hostId === serverHostId) {
    return { kind: "local", machineName: serverName };
  }
  const name = hosts.find((host) => host.id === scope.hostId)?.name;
  return { kind: "remote", hostId: scope.hostId, machineName: name ?? scope.hostId };
}

export interface LaunchRequest {
  /** Full argv, `/usr/bin/xcodebuild` first. */
  argv: readonly string[];
  /** The thread's checkout. */
  root: string;
  /** Requested working directory, relative to the checkout or absolute. */
  cwd?: string;
}

export interface LaunchedBuild {
  /** Known up front for a remote build; a local one gets its id from the probe. */
  runId: string | null;
  bundlePath: string;
  /**
   * Resolves once the build has exited and its verdict has been folded.
   * Never rejects.
   */
  completed: Promise<WrappedOutcome>;
}

export interface BuildLauncher {
  /** Where this scope's builds run. Never throws; unknown means local. */
  targetFor(scope: ThreadScope): Promise<BuildTarget>;
  /**
   * The checkout-boundary checks, run where the build will run. Resolves to
   * the working directory; rejects with the sentence to show.
   */
  prepare(target: BuildTarget, request: LaunchRequest): Promise<string>;
  /** Start it. A string is the reason it did not start. */
  start(
    target: BuildTarget,
    request: LaunchRequest & { workingDir: string },
    scope: ThreadScope,
    killSignal?: AbortSignal,
  ): Promise<LaunchedBuild | string>;
  /** Stop a run that lives on another Mac. */
  stopRemote(run: Run): Promise<{ stopped: boolean; message: string }>;
}

export interface LauncherDeps {
  wrapped: WrappedDeps;
  remote: RemoteBuilds;
  serverHostId(): Promise<string | null>;
  listHosts(): Promise<HostSummary[]>;
  log: { debug(m: string): void };
}

export function createLauncher(deps: LauncherDeps): BuildLauncher {
  return {
    async targetFor(scope) {
      if (scope.hostId === null) return { kind: "local", machineName: null };
      try {
        const [serverHostId, hosts] = await Promise.all([deps.serverHostId(), deps.listHosts()]);
        return buildTargetFor(scope, serverHostId, hosts);
      } catch (error) {
        // Never block a build on this machine because host discovery failed.
        deps.log.debug(`host lookup failed, building locally: ${String(error)}`);
        return { kind: "local", machineName: null };
      }
    },

    async prepare(target, request) {
      if (target.kind === "local") {
        const workingDir = await confinedBuildCwd(request.root, request.cwd);
        await validateBuildArguments(request.argv, request.root, workingDir);
        return workingDir;
      }
      const checked = await deps.remote.validate(target, request);
      if (!checked.ok) throw new Error(checked.message);
      return checked.workingDir;
    },

    async start(target, request, scope, killSignal) {
      if (target.kind === "local") {
        const started = await startWrappedBuild(deps.wrapped, {
          argv: request.argv,
          cwd: request.workingDir,
          ...(killSignal ? { killSignal } : {}),
        });
        return started
          ? { runId: null, bundlePath: started.bundlePath, completed: started.completed }
          : "Failed to start the build.";
      }
      // The worker validates again: the request crossed a process boundary
      // and the disk may have changed since the person approved it.
      const started = await deps.remote.start(
        target,
        { argv: request.argv, root: request.root, ...(request.cwd ? { cwd: request.cwd } : {}) },
        scope,
        killSignal,
      );
      return started.ok
        ? { runId: started.runId, bundlePath: started.bundlePath, completed: started.completed }
        : started.message;
    },

    stopRemote: (run) => deps.remote.stop(run),
  };
}
