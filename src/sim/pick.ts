/**
 * Which simulator does *this thread* mean?
 *
 * The nav panel is machine-wide and asks the user. The thread side panel cannot
 * — it opens beside a conversation, and asking "which of your nine simulators?"
 * every time is the difference between a surface people use and one they close.
 *
 * So it guesses, from evidence in strength order, and **says which evidence it
 * used**. That last part is the whole design: a wrong guess the user can see
 * the reason for is a dropdown away from right, while a wrong guess with no
 * explanation reads as a broken panel.
 *
 * The evidence is ranked by how recently a human expressed intent about it:
 *
 *  1. **This thread's own last build.** The tracker already parses
 *     `-destination` out of every `xcodebuild` process it sees and attributes
 *     runs to threads, so a thread that ran `-destination 'id=<UDID>'` two
 *     minutes ago has named its device out loud. Nothing beats this.
 *  2. **This project's last build**, from any thread. Same evidence, weaker
 *     claim: it is the project's device rather than this conversation's.
 *  3. **The device already being mirrored.** If a simulator is on screen in the
 *     nav panel, opening a second surface on a different one is surprising.
 *  4. **The only booted simulator.** With exactly one running there is no
 *     ambiguity to resolve.
 *  5. **The best booted simulator**, by the same ranking the device list uses.
 *  6. **The best simulator that could be booted.** Requires a boot, so it is
 *     offered rather than started.
 *
 * Everything here is pure. The inputs are gathered by the caller, which is what
 * lets the ranking be tested without a Mac, a thread, or a running build.
 */

/** A destination specifier as the tracker recorded it, newest first. */
export interface RunDestination {
  /** Raw `-destination` value, e.g. `platform=iOS Simulator,id=<UDID>`. */
  destination: string | null;
  /** Epoch ms the run started. */
  startedAt: number;
  /** Set when the tracker attributed the run to a thread. */
  threadId: string | null;
  projectId: string | null;
}

export interface PickCandidate {
  udid: string;
  name: string;
  osVersion: string;
  booted: boolean;
  isAvailable: boolean;
}

export type PickReason =
  | "thread-build"
  | "project-build"
  | "mirrored"
  | "only-booted"
  | "best-booted"
  | "best-available";

export interface PickInput {
  candidates: readonly PickCandidate[];
  runs: readonly RunDestination[];
  threadId: string | null;
  projectId: string | null;
  /** The device the nav panel is currently mirroring, if any. */
  mirroring: string | null;
  /** Ranking for the two "best" rungs; `pickDefaultDevice`, injected. */
  rank(candidates: readonly PickCandidate[]): PickCandidate | null;
}

export interface Pick {
  device: PickCandidate;
  reason: PickReason;
  /** One clause, for the panel: "the device this thread last built for". */
  because: string;
}

const BECAUSE: Record<PickReason, string> = {
  "thread-build": "the device this thread last built for",
  "project-build": "the device this project last built for",
  mirrored: "the device already on screen",
  "only-booted": "the only simulator running",
  "best-booted": "the newest simulator running",
  "best-available": "the newest simulator available",
};

/**
 * Pull a UDID out of a destination specifier.
 *
 * Only `id=` is honoured. A `name=iPhone 17 Pro` destination names a device the
 * user did choose, but resolving it means matching on a string that several
 * simulators can share — and picking the wrong iPhone 17 Pro is worse than
 * falling through to a rung that cannot be wrong about identity.
 */
export function udidFromDestination(destination: string | null): string | null {
  if (destination === null) return null;
  for (const part of destination.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== "id") continue;
    const value = part.slice(eq + 1).trim();
    // Simulator UDIDs are formatted; a device id is not, and this must never
    // resolve to a physical device.
    if (/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value)) {
      return value.toUpperCase();
    }
  }
  return null;
}

/** The most recent run matching `where`, and the simulator it targeted. */
function fromRuns(
  input: PickInput,
  where: (run: RunDestination) => boolean,
): PickCandidate | null {
  const byUdid = new Map(input.candidates.map((device) => [device.udid.toUpperCase(), device]));
  const ordered = [...input.runs].filter(where).sort((a, b) => b.startedAt - a.startedAt);
  for (const run of ordered) {
    const udid = udidFromDestination(run.destination);
    if (udid === null) continue;
    const device = byUdid.get(udid);
    // A destination naming a simulator that has since been deleted is not
    // evidence about any simulator that exists now.
    if (device !== undefined && device.isAvailable) return device;
  }
  return null;
}

export function pickSimulator(input: PickInput): Pick | null {
  const usable = input.candidates.filter((device) => device.isAvailable);
  if (usable.length === 0) return null;

  const rungs: Array<[PickReason, () => PickCandidate | null]> = [
    [
      "thread-build",
      () =>
        input.threadId === null ? null : fromRuns(input, (run) => run.threadId === input.threadId),
    ],
    [
      "project-build",
      () =>
        input.projectId === null
          ? null
          : fromRuns(input, (run) => run.projectId === input.projectId),
    ],
    [
      "mirrored",
      () =>
        input.mirroring === null
          ? null
          : (usable.find((device) => device.udid === input.mirroring) ?? null),
    ],
    [
      "only-booted",
      () => {
        const booted = usable.filter((device) => device.booted);
        return booted.length === 1 ? booted[0]! : null;
      },
    ],
    ["best-booted", () => input.rank(usable.filter((device) => device.booted))],
    ["best-available", () => input.rank(usable)],
  ];

  for (const [reason, resolve] of rungs) {
    const device = resolve();
    if (device !== null) return { device, reason, because: BECAUSE[reason] };
  }
  return null;
}
