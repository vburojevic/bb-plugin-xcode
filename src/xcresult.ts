/**
 * Tier 2 — `.xcresult` enrichment via `xcresulttool`.
 *
 * Uses the Xcode 16+ subcommands (`get build-results`, `get test-results …`),
 * not the deprecated `get object` graph API.
 *
 * Two traps verified by experiment on Xcode 26.6:
 *  - Timestamps here are **Unix** epoch seconds, unlike the Apple-epoch values
 *    in `LogStoreManifest.plist`.
 *  - `get test-results tests` renders durations as *locale-formatted strings*
 *    (`"0,55s"` under a European locale). `parseFloat` silently yields 0.
 */

import type {
  BuildResults,
  IssueRow,
  RunStatus,
  TestResults,
  TestRow,
} from "./types";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Unix-epoch seconds (as emitted by xcresulttool) to epoch ms. */
export function unixSecondsToMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 1000);
}

/**
 * Parse a duration string that may use a locale decimal separator.
 *
 * Accepts `0,55s`, `0.55s`, `1,234.5s`, `12ms`, `2m`, `1h`. Returns ms.
 */
export function parseLocaleDuration(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw * 1000);
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;

  const match = /^([\d.,]+)\s*(ms|s|m|h)?$/i.exec(text);
  if (!match) return null;
  const [, numberText, unit] = match;

  const value = parseLocaleNumber(numberText!);
  if (value === null) return null;

  switch ((unit ?? "s").toLowerCase()) {
    case "ms":
      return Math.round(value);
    case "m":
      return Math.round(value * 60_000);
    case "h":
      return Math.round(value * 3_600_000);
    default:
      return Math.round(value * 1000);
  }
}

/**
 * Interpret a number that may use `,` as either a decimal or grouping
 * separator. When both separators appear, the *last* one is the decimal point.
 */
export function parseLocaleNumber(text: string): number | null {
  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  let normalized = text;

  if (hasComma && hasDot) {
    const decimalSeparator = text.lastIndexOf(",") > text.lastIndexOf(".") ? "," : ".";
    const groupSeparator = decimalSeparator === "," ? "." : ",";
    normalized = text.split(groupSeparator).join("");
    normalized = normalized.replace(decimalSeparator, ".");
  } else if (hasComma) {
    // A single comma with 3 trailing digits is ambiguous (`1,234`); Xcode emits
    // fractional seconds here, so treat it as a decimal separator.
    normalized = text.replace(",", ".");
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

/**
 * Decode the `sourceURL` Xcode attaches to issues.
 *
 * Shape: `file:///path/File.swift#StartingLineNumber=2&StartingColumnNumber=36…`
 * The line/column values are **0-based**, so they are converted to the 1-based
 * numbers an editor expects.
 */
export function parseSourceUrl(raw: unknown): {
  filePath: string | null;
  line: number | null;
  column: number | null;
} {
  const empty = { filePath: null, line: null, column: null };
  const text = asString(raw);
  if (!text) return empty;

  const hashIndex = text.indexOf("#");
  const pathPart = hashIndex === -1 ? text : text.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : text.slice(hashIndex + 1);

  let filePath: string | null = null;
  try {
    filePath = pathPart.startsWith("file://")
      ? decodeURIComponent(new URL(pathPart).pathname)
      : pathPart;
  } catch {
    filePath = pathPart;
  }

  const params = new URLSearchParams(fragment);
  const readIndex = (key: string): number | null => {
    const value = params.get(key);
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed + 1 : null;
  };

  return {
    filePath,
    line: readIndex("StartingLineNumber"),
    column: readIndex("StartingColumnNumber"),
  };
}

function describeDestination(destination: unknown): string | null {
  const record = asRecord(destination);
  if (!record) return null;
  const device = asRecord(record["device"]) ?? record;
  const platform = asString(device["platform"]);
  const name = asString(device["deviceName"]) ?? asString(device["modelName"]);
  const os = asString(device["osVersion"]);
  const parts = [platform, name, os ? `(${os})` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function issuesFrom(list: unknown, severity: IssueRow["severity"]): IssueRow[] {
  return asArray(list).flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const message = asString(record["message"]);
    if (!message) return [];
    const location = parseSourceUrl(record["sourceURL"]);
    return [
      {
        severity,
        message,
        filePath: location.filePath,
        line: location.line,
        column: location.column,
        target: asString(record["targetName"]),
      },
    ];
  });
}

/** Parse the JSON from `xcresulttool get build-results`. */
export function parseBuildResults(json: unknown): BuildResults | null {
  const root = asRecord(json);
  if (!root) return null;

  const errorCount = asNumber(root["errorCount"]);
  const warningCount = asNumber(root["warningCount"]);
  const rawStatus = asString(root["status"]);

  let status: RunStatus;
  switch (rawStatus) {
    case "succeeded":
      status = warningCount > 0 ? "warnings" : "passed";
      break;
    case "failed":
      status = "failed";
      break;
    case "cancelled":
      status = "cancelled";
      break;
    default:
      status = errorCount > 0 ? "failed" : "ended";
  }

  return {
    status,
    startedAt: unixSecondsToMs(root["startTime"]),
    endedAt: unixSecondsToMs(root["endTime"]),
    errorCount,
    warningCount,
    analyzerCount: asNumber(root["analyzerWarningCount"]),
    actionTitle: asString(root["actionTitle"]),
    destination: describeDestination(root["destination"]),
    issues: [
      ...issuesFrom(root["errors"], "error"),
      ...issuesFrom(root["warnings"], "warning"),
      ...issuesFrom(root["analyzerWarnings"], "analyzer"),
    ],
  };
}

/** Parse the JSON from `xcresulttool get test-results summary`. */
export function parseTestSummary(
  json: unknown,
): Omit<TestResults, "tests"> | null {
  const root = asRecord(json);
  if (!root) return null;

  const failed = asNumber(root["failedTests"]);
  const rawResult = asString(root["result"]);
  const status: RunStatus =
    rawResult === "Passed"
      ? "passed"
      : rawResult === "Failed"
        ? "failed"
        : failed > 0
          ? "failed"
          : "ended";

  const devices = asArray(root["devicesAndConfigurations"]);
  const destination = devices.length ? describeDestination(devices[0]) : null;

  return {
    status,
    startedAt: unixSecondsToMs(root["startTime"]),
    endedAt: unixSecondsToMs(root["finishTime"]),
    total: asNumber(root["totalTestCount"]),
    passed: asNumber(root["passedTests"]),
    failed,
    skipped: asNumber(root["skippedTests"]),
    expectedFailures: asNumber(root["expectedFailures"]),
    destination,
  };
}

function testStatusFrom(raw: string | null): TestRow["status"] {
  switch (raw) {
    case "Passed":
      return "passed";
    case "Failed":
      return "failed";
    case "Skipped":
      return "skipped";
    case "Expected Failure":
      return "expected-failure";
    default:
      return "unknown";
  }
}

/**
 * Flatten the node tree from `xcresulttool get test-results tests` into rows.
 *
 * The tree nests Test Plan → bundle → suite → case → failure message; only the
 * `Test Case` nodes become rows, with their child failure messages folded in.
 */
export function parseTestNodes(json: unknown): TestRow[] {
  const root = asRecord(json);
  if (!root) return [];
  const rows: TestRow[] = [];

  const visit = (
    node: unknown,
    suite: string | null,
    target: string | null,
  ): void => {
    const record = asRecord(node);
    if (!record) return;
    const nodeType = asString(record["nodeType"]);
    const name = asString(record["name"]);
    const children = asArray(record["children"]);

    if (nodeType === "Test Case" && name) {
      const failureMessages = children.flatMap((child) => {
        const childRecord = asRecord(child);
        if (!childRecord) return [];
        if (asString(childRecord["nodeType"]) !== "Failure Message") return [];
        const text = asString(childRecord["name"]);
        return text ? [text] : [];
      });
      rows.push({
        suite,
        name,
        identifier: asString(record["nodeIdentifier"]),
        status: testStatusFrom(asString(record["result"])),
        durationMs: parseLocaleDuration(record["duration"]),
        failureMessage: failureMessages.length ? failureMessages.join("\n") : null,
        target,
      });
      return;
    }

    const nextSuite = nodeType === "Test Suite" && name ? name : suite;
    const nextTarget =
      nodeType === "Unit test bundle" || nodeType === "UI test bundle"
        ? name
        : target;
    for (const child of children) visit(child, nextSuite, nextTarget);
  };

  for (const node of asArray(root["testNodes"])) visit(node, null, null);
  return rows;
}
