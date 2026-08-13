/**
 * Reduce BB's provider-neutral thread events to terminal shell outcomes.
 *
 * Claude-style background commands have two completions: the command tool
 * first exits 0 after merely launching the task, then a later
 * `item/backgroundTask/completed` event reports the real child exit. Only the
 * latter is a build verdict. Linking through `parentToolCallId` avoids parsing
 * unrelated task prose or mistaking the launcher for a successful build.
 */

export interface ThreadEventLike {
  id: string;
  seq: number;
  createdAt: number;
  type: string;
  data: {
    item?: {
      type?: string;
      id?: string;
      command?: string;
      cwd?: string;
      status?: string;
      taskStatus?: string;
      summary?: string;
      parentToolCallId?: string;
    };
  };
}

export interface BackgroundCommandOutcome {
  taskId: string;
  threadId?: string;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
  interrupted: boolean;
}

const EXIT_CODE = /\bexit code\s+(-?\d+)\b/i;

/** A `commandExecution` start, keyed by the tool-call id a task links back to. */
export interface CommandStart {
  id: string;
  seq: number;
  command: string;
  cwd: string;
  startedAt: number;
}

function commandStarts(
  events: readonly ThreadEventLike[],
): Map<string, CommandStart> {
  const commands = new Map<string, CommandStart>();
  for (const event of events) {
    if (event.type !== "item/started") continue;
    const item = event.data.item;
    if (
      item?.type !== "commandExecution" ||
      !item.id ||
      typeof item.command !== "string"
    ) {
      continue;
    }
    commands.set(item.id, {
      id: item.id,
      seq: event.seq,
      command: item.command,
      cwd: item.cwd ?? "",
      startedAt: event.createdAt,
    });
  }
  return commands;
}

/**
 * Command starts in this window that have not yet reported a task completion.
 *
 * A reader that pages forward has to know where it may safely resume from: a
 * launcher whose exit has not arrived yet is still needed to interpret that
 * exit when it does, and skipping past it would strand the verdict silently.
 * Returned oldest-first by sequence.
 */
export function unresolvedCommandStarts(
  events: readonly ThreadEventLike[],
): CommandStart[] {
  const completed = new Set<string>();
  for (const event of events) {
    if (event.type !== "item/backgroundTask/completed") continue;
    const parent = event.data.item?.parentToolCallId;
    if (parent) completed.add(parent);
  }
  return [...commandStarts(events).values()]
    .filter((start) => !completed.has(start.id))
    .sort((a, b) => a.seq - b.seq);
}

export function backgroundCommandOutcomes(
  events: readonly ThreadEventLike[],
): BackgroundCommandOutcome[] {
  const commands = commandStarts(events);

  const outcomes: BackgroundCommandOutcome[] = [];
  const seenTasks = new Set<string>();
  for (const event of events) {
    if (event.type !== "item/backgroundTask/completed") continue;
    const item = event.data.item;
    if (
      item?.type !== "backgroundTask" ||
      !item.id ||
      !item.parentToolCallId ||
      seenTasks.has(item.id)
    ) {
      continue;
    }
    const command = commands.get(item.parentToolCallId);
    if (!command) continue;

    const interrupted =
      item.status === "interrupted" ||
      item.taskStatus === "killed" ||
      item.taskStatus === "stopped";
    const match = item.summary?.match(EXIT_CODE);
    const parsed = match ? Number(match[1]) : null;
    const exitCode = Number.isSafeInteger(parsed) ? parsed : null;

    // `completed` alone is not an exit status. Providers currently include
    // the actual code in summary; if they stop doing so, stay verdict-less.
    if (!interrupted && exitCode === null && item.status !== "failed") continue;

    seenTasks.add(item.id);
    outcomes.push({
      taskId: item.id,
      command: command.command,
      cwd: command.cwd,
      startedAt: command.startedAt,
      endedAt: event.createdAt,
      exitCode: exitCode ?? (item.status === "failed" ? 1 : null),
      interrupted,
    });
  }

  return outcomes;
}
