import { describe, expect, it } from "vitest";

import { appleTimeToEpochMs } from "../src/manifest";
import {
  parseBuildResults,
  parseLocaleDuration,
  parseLocaleNumber,
  parseSourceUrl,
  parseTestNodes,
  parseTestSummary,
  unixSecondsToMs,
} from "../src/xcresult";

describe("parseLocaleDuration", () => {
  /**
   * Regression: `xcresulttool get test-results tests` formats durations with
   * the *user's* locale separator. On a European locale it emits "0,55s", and
   * parseFloat("0,55") silently yields 0 — losing every test duration.
   */
  it("handles a comma decimal separator", () => {
    expect(parseLocaleDuration("0,55s")).toBe(550);
    expect(parseLocaleDuration("0,0016s")).toBe(2);
  });

  it("handles a dot decimal separator", () => {
    expect(parseLocaleDuration("0.55s")).toBe(550);
  });

  it("handles grouped thousands in either convention", () => {
    expect(parseLocaleNumber("1,234.5")).toBeCloseTo(1234.5);
    expect(parseLocaleNumber("1.234,5")).toBeCloseTo(1234.5);
  });

  it("supports other units", () => {
    expect(parseLocaleDuration("12ms")).toBe(12);
    expect(parseLocaleDuration("2m")).toBe(120_000);
    expect(parseLocaleDuration("1h")).toBe(3_600_000);
  });

  it("returns null for unusable input", () => {
    expect(parseLocaleDuration(undefined)).toBeNull();
    expect(parseLocaleDuration("n/a")).toBeNull();
  });
});

describe("parseSourceUrl", () => {
  /**
   * Xcode encodes line/column in the URL fragment, 0-based. A single-line file
   * reports `EndingLineNumber=0`, which confirmed the indexing.
   */
  it("decodes path and converts 0-based line to 1-based", () => {
    const parsed = parseSourceUrl(
      "file:///tmp/x/Sources/Demo/Demo.swift#EndingColumnNumber=36&EndingLineNumber=2&StartingColumnNumber=36&StartingLineNumber=2",
    );
    expect(parsed.filePath).toBe("/tmp/x/Sources/Demo/Demo.swift");
    expect(parsed.line).toBe(3);
    expect(parsed.column).toBe(37);
  });

  it("survives a URL with no fragment", () => {
    const parsed = parseSourceUrl("file:///a/B.swift");
    expect(parsed.filePath).toBe("/a/B.swift");
    expect(parsed.line).toBeNull();
  });

  it("decodes percent-escaped paths", () => {
    expect(parseSourceUrl("file:///a/My%20App/B.swift").filePath).toBe(
      "/a/My App/B.swift",
    );
  });
});

describe("epoch handling", () => {
  /**
   * xcresulttool emits Unix-epoch seconds, unlike LogStoreManifest.plist which
   * uses Apple's 2001 reference date. Mixing them shifts times by ~31 years.
   */
  it("treats xcresult times as Unix epoch", () => {
    expect(new Date(unixSecondsToMs(1786057760.608)!).toISOString()).toBe(
      "2026-08-06T23:09:20.608Z",
    );
  });

  /**
   * The strongest available check that both converters are right: these two
   * values are the *same* build's start time, recorded by Xcode in its two
   * different time bases. They must land on the same instant.
   */
  it("agrees with the manifest's Apple epoch for the same build", () => {
    const fromXcresult = unixSecondsToMs(1786057760.608)!;
    const fromManifest = appleTimeToEpochMs(807750560.607597)!;
    expect(Math.abs(fromXcresult - fromManifest)).toBeLessThan(2);
  });
});

// Captured verbatim from `xcresulttool get build-results` on Xcode 26.6.
const BUILD_RESULTS = {
  actionTitle: 'Build "Demo"',
  analyzerWarningCount: 0,
  analyzerWarnings: [],
  destination: {
    architecture: "arm64",
    deviceName: "My Mac",
    modelName: "MacBook Pro",
    osVersion: "26.5.2",
    platform: "macOS",
  },
  endTime: 1786057766.239,
  errorCount: 0,
  errors: [],
  startTime: 1786057760.608,
  status: "succeeded",
  warningCount: 1,
  warnings: [
    {
      className: "DVTTextDocumentLocation",
      issueType: "No-usage",
      message: "Initialization of immutable value 'x' was never used",
      sourceURL:
        "file:///tmp/x/Sources/Demo/Demo.swift#EndingColumnNumber=36&EndingLineNumber=2&StartingColumnNumber=36&StartingLineNumber=2",
    },
  ],
};

describe("parseBuildResults", () => {
  it("parses a real build-results document", () => {
    const parsed = parseBuildResults(BUILD_RESULTS)!;
    expect(parsed.status).toBe("warnings"); // succeeded + warnings
    expect(parsed.errorCount).toBe(0);
    expect(parsed.warningCount).toBe(1);
    expect(parsed.destination).toBe("macOS · My Mac · (26.5.2)");
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]!.severity).toBe("warning");
    expect(parsed.issues[0]!.filePath).toBe("/tmp/x/Sources/Demo/Demo.swift");
    expect(parsed.issues[0]!.line).toBe(3);
  });

  it("reports a clean build as succeeded", () => {
    const parsed = parseBuildResults({
      ...BUILD_RESULTS,
      warningCount: 0,
      warnings: [],
    })!;
    expect(parsed.status).toBe("passed");
  });

  it("returns null for junk", () => {
    expect(parseBuildResults(null)).toBeNull();
  });
});

// Captured verbatim from `xcresulttool get test-results summary`.
const TEST_SUMMARY = {
  devicesAndConfigurations: [
    {
      device: {
        architecture: "arm64",
        deviceName: "My Mac",
        modelName: "MacBook Pro",
        osVersion: "26.5.2",
        platform: "macOS",
      },
      expectedFailures: 0,
      failedTests: 1,
      passedTests: 1,
    },
  ],
  expectedFailures: 0,
  failedTests: 1,
  finishTime: 1786057820.601,
  passedTests: 1,
  result: "Failed",
  skippedTests: 0,
  startTime: 1786057801.497,
  testFailures: [
    {
      failureText: 'XCTAssertEqual failed: ("2") is not equal to ("3")',
      targetName: "DemoTests",
      testName: "testFail()",
    },
  ],
  title: "Test - Demo",
  totalTestCount: 2,
};

describe("parseTestSummary", () => {
  it("parses a real failing test summary", () => {
    const parsed = parseTestSummary(TEST_SUMMARY)!;
    expect(parsed.status).toBe("failed");
    expect(parsed.total).toBe(2);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.destination).toBe("macOS · My Mac · (26.5.2)");
  });

  it("maps a passing run", () => {
    const parsed = parseTestSummary({
      ...TEST_SUMMARY,
      result: "Passed",
      failedTests: 0,
    })!;
    expect(parsed.status).toBe("passed");
  });
});

// Shape of `xcresulttool get test-results tests`, with the locale duration.
const TEST_NODES = {
  testNodes: [
    {
      nodeType: "Test Plan",
      name: "Demo",
      result: "Failed",
      children: [
        {
          nodeType: "Unit test bundle",
          name: "DemoTests",
          result: "Failed",
          children: [
            {
              nodeType: "Test Suite",
              name: "DemoTests",
              result: "Failed",
              children: [
                {
                  nodeType: "Test Case",
                  name: "testAdd()",
                  result: "Passed",
                  duration: "0,0016s",
                },
                {
                  nodeType: "Test Case",
                  name: "testFail()",
                  result: "Failed",
                  duration: "0,55s",
                  children: [
                    {
                      nodeType: "Failure Message",
                      name: 'DemoTests.swift:5: XCTAssertEqual failed: ("2") is not equal to ("3")',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("parseTestNodes", () => {
  it("flattens the node tree into rows with suite and target", () => {
    const rows = parseTestNodes(TEST_NODES);
    expect(rows).toHaveLength(2);

    const passed = rows.find((row) => row.name === "testAdd()")!;
    expect(passed.status).toBe("passed");
    expect(passed.suite).toBe("DemoTests");
    expect(passed.target).toBe("DemoTests");
    expect(passed.durationMs).toBe(2);

    const failed = rows.find((row) => row.name === "testFail()")!;
    expect(failed.status).toBe("failed");
    expect(failed.durationMs).toBe(550);
    expect(failed.failureMessage).toContain("is not equal to");
  });

  it("returns [] for junk", () => {
    expect(parseTestNodes({})).toEqual([]);
  });
});
