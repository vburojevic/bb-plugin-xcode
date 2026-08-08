/**
 * Tier 3 — true live progress via `xcodebuild -resultStreamPath`.
 *
 * xcodebuild can write newline-delimited JSON events *while* it builds. This is
 * the only mechanism that reports per-section progress and issues as they
 * happen, but it requires wrapping the command, so it is opt-in.
 *
 * Two requirements verified by experiment:
 *  - `-resultStreamPath` is rejected unless `-resultBundlePath` is also given;
 *  - the stream file must already exist before xcodebuild starts.
 */

/** Events xcodebuild emits, in the order a build produces them. */
export type StreamEventName =
  | "invocationStarted"
  | "invocationFinished"
  | "actionStarted"
  | "actionFinished"
  | "issueEmitted"
  | "testStarted"
  | "testFinished"
  | "logSectionCreated"
  | "logSectionAttached"
  | "logSectionClosed"
  | "logTextAppended"
  | "logMessageEmitted";

export interface StreamEvent {
  name: StreamEventName | string;
  payload: unknown;
}

/**
 * Unwrap Apple's self-describing JSON into plain values.
 *
 * Every scalar arrives as `{"_type": {...}, "_value": "…"}` and every array as
 * `{"_values": [...]}`, which is unusable without flattening first.
 */
export function unwrapTyped(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapTyped);
  if (typeof value !== "object" || value === null) return value;

  const record = value as Record<string, unknown>;
  if ("_value" in record) return unwrapTyped(record["_value"]);
  if ("_values" in record) return unwrapTyped(record["_values"]);

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (key === "_type" || key === "_supertype") continue;
    out[key] = unwrapTyped(entry);
  }
  return out;
}

/** Parse one NDJSON line; null when the line is blank or malformed. */
export function parseStreamLine(line: string): StreamEvent | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null; // a partially flushed trailing line
  }
  const record = raw as Record<string, unknown>;
  const name = unwrapTyped(record["name"]);
  if (typeof name !== "string") return null;
  return { name, payload: unwrapTyped(record["structuredPayload"]) };
}

/** Running progress derived from a stream, suitable for a progress bar. */
export interface StreamProgress {
  started: boolean;
  finished: boolean;
  sectionsOpened: number;
  sectionsClosed: number;
  errors: number;
  warnings: number;
  currentSection: string | null;
  testsFinished: number;
}

export function emptyProgress(): StreamProgress {
  return {
    started: false,
    finished: false,
    sectionsOpened: 0,
    sectionsClosed: 0,
    errors: 0,
    warnings: 0,
    currentSection: null,
    testsFinished: 0,
  };
}

function sectionTitle(payload: unknown): string | null {
  const record = payload as Record<string, unknown> | null;
  const section = record?.["section"] as Record<string, unknown> | undefined;
  const title = section?.["title"];
  return typeof title === "string" && title ? title : null;
}

/** Fold one event into the running progress snapshot. */
export function applyStreamEvent(
  progress: StreamProgress,
  event: StreamEvent,
): StreamProgress {
  switch (event.name) {
    case "invocationStarted":
      return { ...progress, started: true };
    case "invocationFinished":
      return { ...progress, finished: true, currentSection: null };
    case "logSectionCreated": {
      const title = sectionTitle(event.payload);
      return {
        ...progress,
        sectionsOpened: progress.sectionsOpened + 1,
        currentSection: title ?? progress.currentSection,
      };
    }
    case "logSectionClosed":
      return { ...progress, sectionsClosed: progress.sectionsClosed + 1 };
    case "issueEmitted": {
      const record = event.payload as Record<string, unknown> | null;
      const severity = String(record?.["severity"] ?? "").toLowerCase();
      const issue = record?.["issue"] as Record<string, unknown> | undefined;
      const type = String(issue?.["issueType"] ?? "").toLowerCase();
      const isError = severity.includes("error") || type.includes("error");
      return isError
        ? { ...progress, errors: progress.errors + 1 }
        : { ...progress, warnings: progress.warnings + 1 };
    }
    case "testFinished":
      return { ...progress, testsFinished: progress.testsFinished + 1 };
    default:
      return progress;
  }
}

/**
 * Rewrite an xcodebuild argv so it emits a result bundle and a live stream.
 *
 * Existing `-resultBundlePath` / `-resultStreamPath` flags are respected rather
 * than duplicated, so wrapping a command that already sets them is safe.
 */
export function injectStreamFlags(
  argv: readonly string[],
  bundlePath: string,
  streamPath: string,
): { argv: string[]; bundlePath: string; streamPath: string } {
  const out = [...argv];

  const existingBundle = valueOf(out, "-resultBundlePath");
  const resolvedBundle = existingBundle ?? bundlePath;
  if (!existingBundle) out.push("-resultBundlePath", resolvedBundle);

  const existingStream = valueOf(out, "-resultStreamPath");
  const resolvedStream = existingStream ?? streamPath;
  if (!existingStream) out.push("-resultStreamPath", resolvedStream);

  return { argv: out, bundlePath: resolvedBundle, streamPath: resolvedStream };
}

function valueOf(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index === -1 || index + 1 >= argv.length) return null;
  return argv[index + 1] ?? null;
}

/**
 * Split a buffer into complete lines, returning the trailing partial line.
 *
 * The stream file is tailed while xcodebuild writes it, so the last line is
 * routinely incomplete and must be carried into the next read.
 */
export function splitLines(buffer: string): {
  lines: string[];
  rest: string;
} {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}
