/**
 * The runtime context every surface is built from.
 *
 * `server.ts` composes exactly one of these and hands it to the RPC handlers,
 * the CLI, the HTTP routes and the agent tools, so those four surfaces cannot
 * drift into having different ideas about the settings, the device driver or
 * where the frames live.
 */
import { dirname, join } from "node:path";
import type { Db } from "./store.js";
import type { Preflight } from "./preflight.js";
import type { Settings } from "./settings.js";
import type { LiveService } from "./live.js";
import type { DeviceDriver } from "./devices.js";
import type { Scope } from "./scope.js";
import type { FrameStore } from "./framestore.js";
import type { LeaseOutcome } from "./lease.js";

export interface ThreadScope {
  scope: Scope;
  projectId: string;
  /** `null` when the checkout is on this machine or we could not tell. */
  checkoutElsewhere: string | null;
}

/** What `waitFor` resolves to — the same shape the panel renders. */
export interface StillsSummary {
  lookId: string | null;
  status: string;
  sentence: string;
  rekey: { sentence: string } | null;
  truncation: { sentence: string } | null;
  rows: Array<{
    identity: string;
    displayName: string;
    groupName: string;
    status: string;
    frame: { id: string } | null;
  }>;
}

export interface Ctx {
  pluginId: string;
  db: Db;
  /** `<dataDir>/plugins/xcode-simulators` — derived from the database path. */
  dataDir: string;
  /** `<dataDir>/plugins/xcode-simulators/frames`. Never persisted anywhere. */
  framesRoot: string;
  store: FrameStore;
  settings(): Settings;
  /**
   * Probed on first use and cached, never at load.
   *
   * The probes shell out to `sw_vers`, `xcode-select`, `xcodebuild` and the bb
   * CLI, which together cost a few seconds. Paying that on every reload would
   * delay activation for a fact nothing needs until someone opens the doctor.
   */
  preflight(): Promise<Preflight>;
  refreshPreflight(): Promise<Preflight>;
  live: LiveService;
  driver: DeviceDriver;
  /**
   * Take the live device's lease, or explain who has it.
   *
   * Keyed on the device rather than the caller: the contended resource is the
   * simulator, and a person tapping while an agent drives interleaves exactly
   * the same way two agents do.
   */
  leases: { acquire(threadId: string | null): LeaseOutcome };
  log(level: "info" | "warn" | "error", message: string): void;
  publish(kind: "look" | "live"): void;
  /**
   * Resolve the repo scope for a thread, or for the plugin's own default
   * project when there is no thread. Cached per thread for the life of the
   * load, because it shells out to git three times.
   */
  scopeForThread(threadId: string | null): Promise<ThreadScope | null>;
  /**
   * The scope for a CLI invocation.
   *
   * A bare terminal invocation has no thread, so `cwd` is the strongest
   * evidence available — and it is the difference between `bb sims onboard`
   * analysing the repo you are standing in and analysing whichever project bb
   * happens to list first. `projectId` beats it when the caller knew one.
   */
  scopeForInvocation(hints: {
    threadId?: string;
    projectId?: string;
    cwd?: string;
  }): Promise<ThreadScope | null>;
  /**
   * Recent builds and the destination each targeted, newest first.
   *
   * Supplied by the tracker half, which parses `-destination` off every
   * `xcodebuild` process it sees. `pickSimulator` ranks it above everything
   * else: a thread that built for a device two minutes ago has said which
   * simulator it means out loud.
   */
  recentDestinations(limit: number): readonly import("./pick.js").RunDestination[];
  /**
   * The machine the simulators run on, and every other enrolled machine.
   *
   * `current` is the bb server host's name — CoreSimulator, the capture host
   * and every `simctl` call live there. `others` exist so the picker can name
   * them honestly as out of reach rather than hiding the machine dimension.
   * Never throws: a hosts API that cannot answer is an empty answer.
   */
  machines(): Promise<{ current: string | null; others: string[] }>;
  /** Prune and enforce the disk ceiling before generated frames are copied. */
  beforeFrameImport(incomingBytes: number): Promise<void>;
  /** HEAD for a checkout, so a frame records what it was a picture of. */
  gitHead(checkoutPath: string): Promise<{ commitSha: string | null; branch: string | null }>;
  stills: {
    /**
     * Enqueue a render. Returns as soon as it is queued, never when it is done.
     *
     * The **scope is passed in** rather than resolved inside. It used to be
     * resolved from the default project, which meant `bb sims stills` rendered
     * whichever project bb listed first instead of the one the caller meant.
     */
    enqueue(scope: ThreadScope, device: string | null): Promise<{ lookId: string | null; queued: number }>;
    /**
     * Enqueue a render and wait for it.
     *
     * Only the agent tool uses this. `simulator_stills` is documented as
     * blocking and bounded, because a model that fires a render and returns has
     * told the user nothing. Every other caller enqueues and watches the panel,
     * which is the surface that explains the wait.
     */
    run(scope: ThreadScope, device: string | null): Promise<StillsSummary | null>;
  };
  /** Resolve a real thread, then ask through host-owned UI. */
  confirmAction(
    hints: { threadId?: string | null; projectId?: string | null },
    consent: { title: string; facts: string[]; confirmLabel: string },
  ): Promise<boolean>;
  /**
   * Project detection, cached.
   *
   * `xcodebuild -list` takes tens of seconds on a project with package
   * dependencies — 47s measured here — and the Stills panel asks on every mount
   * and every realtime signal. A handler must never wait on that.
   */
  detection: import("./detect-cache.js").DetectCache;
  /** The demo banner state, when one is armed and unexpired. */
  demo(): import("./demos.js").DemoBannerState | null;
  setDemo(state: import("./demos.js").DemoBannerState | null): void;
  /** Write the onboarding files into the checkout, through bb.sdk.files. */
  writeOnboardingFiles(files: ReadonlyArray<{ relPath: string; contents: string }>): Promise<string[]>;
  /**
   * Write a stored frame to a path on the machine that invoked the CLI.
   *
   * `run` executes on the server, so a path argument names a file on the
   * *invoking* machine. Using `node:fs` here would silently write to the wrong
   * host's disk on an enrolled remote machine.
   */
  writeToInvokingHost(
    threadId: string | null,
    path: string,
    rootPath: string,
    frameId: string,
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }>;
  isDisposed(): boolean;
}

/** The plugin's own data directory, from the database handle rather than an SDK call. */
export function dataDirOf(db: Db): string {
  return dirname(db.name);
}

export function framesRootOf(db: Db): string {
  return join(dataDirOf(db), "frames");
}
