import { describe, expect, it } from "vitest";

import {
  applyStreamEvent,
  emptyProgress,
  injectStreamFlags,
  parseStreamLine,
  splitLines,
  unwrapTyped,
} from "../src/stream";

// Captured verbatim from a real `-resultStreamPath` file on Xcode 26.6.
const INVOCATION_STARTED =
  '{"_type":{"_name":"StreamedEvent"},"name":{"_type":{"_name":"String"},"_value":"invocationStarted"},"structuredPayload":{"_type":{"_name":"InvocationStartedEventPayload"},"metadata":{"_type":{"_name":"ActionsInvocationMetadata"},"uniqueIdentifier":{"_type":{"_name":"String"},"_value":"abc"}}}}';

const ISSUE_EMITTED =
  '{"_type":{"_name":"StreamedEvent"},"name":{"_type":{"_name":"String"},"_value":"issueEmitted"},"structuredPayload":{"_type":{"_name":"IssueEmittedEventPayload"},"issue":{"_type":{"_name":"IssueSummary"},"issueType":{"_type":{"_name":"String"},"_value":"No-usage"},"message":{"_type":{"_name":"String"},"_value":"never used"}}}}';

describe("unwrapTyped", () => {
  it("flattens Apple's self-describing scalars", () => {
    expect(
      unwrapTyped({ _type: { _name: "String" }, _value: "hello" }),
    ).toBe("hello");
  });

  it("flattens arrays wrapped in _values", () => {
    expect(
      unwrapTyped({ _values: [{ _value: "a" }, { _value: "b" }] }),
    ).toEqual(["a", "b"]);
  });

  it("drops type metadata from records", () => {
    expect(
      unwrapTyped({
        _type: { _name: "X" },
        _supertype: { _name: "Y" },
        title: { _value: "Compile Demo.swift" },
      }),
    ).toEqual({ title: "Compile Demo.swift" });
  });
});

describe("parseStreamLine", () => {
  it("parses a real invocationStarted event", () => {
    const event = parseStreamLine(INVOCATION_STARTED)!;
    expect(event.name).toBe("invocationStarted");
    expect(event.payload).toMatchObject({
      metadata: { uniqueIdentifier: "abc" },
    });
  });

  it("returns null for a partially flushed trailing line", () => {
    expect(parseStreamLine('{"_type":{"_na')).toBeNull();
  });

  it("returns null for blank lines", () => {
    expect(parseStreamLine("   ")).toBeNull();
  });
});

describe("applyStreamEvent", () => {
  it("tracks the build lifecycle and issue counts", () => {
    let progress = emptyProgress();
    progress = applyStreamEvent(progress, parseStreamLine(INVOCATION_STARTED)!);
    expect(progress.started).toBe(true);

    progress = applyStreamEvent(progress, {
      name: "logSectionCreated",
      payload: { section: { title: "Compile Demo.swift" } },
    });
    expect(progress.sectionsOpened).toBe(1);
    expect(progress.currentSection).toBe("Compile Demo.swift");

    progress = applyStreamEvent(progress, parseStreamLine(ISSUE_EMITTED)!);
    expect(progress.warnings).toBe(1);
    expect(progress.errors).toBe(0);

    progress = applyStreamEvent(progress, {
      name: "issueEmitted",
      payload: { issue: { issueType: "Swift Compiler Error" } },
    });
    expect(progress.errors).toBe(1);

    progress = applyStreamEvent(progress, {
      name: "invocationFinished",
      payload: {},
    });
    expect(progress.finished).toBe(true);
    expect(progress.currentSection).toBeNull();
  });

  it("ignores unknown events", () => {
    const before = emptyProgress();
    expect(applyStreamEvent(before, { name: "somethingNew", payload: {} })).toEqual(
      before,
    );
  });
});

describe("injectStreamFlags", () => {
  it("adds both flags when neither is present", () => {
    const result = injectStreamFlags(
      ["/usr/bin/xcodebuild", "-scheme", "A", "build"],
      "/t/r.xcresult",
      "/t/s.ndjson",
    );
    expect(result.argv).toContain("-resultBundlePath");
    expect(result.argv).toContain("-resultStreamPath");
    expect(result.bundlePath).toBe("/t/r.xcresult");
  });

  it("replaces caller-controlled result paths with plugin-owned paths", () => {
    const result = injectStreamFlags(
      [
        "xcodebuild",
        "-resultBundlePath",
        "/mine.xcresult",
        "-resultStreamPath=/mine.ndjson",
        "build",
      ],
      "/t/r.xcresult",
      "/t/s.ndjson",
    );
    expect(result.bundlePath).toBe("/t/r.xcresult");
    expect(result.argv.filter((a) => a === "-resultBundlePath")).toHaveLength(1);
    expect(result.argv).not.toContain("/mine.xcresult");
    expect(result.argv).not.toContain("-resultStreamPath=/mine.ndjson");
    expect(result.argv).toContain("/t/s.ndjson");
  });
});

describe("splitLines", () => {
  it("carries an incomplete trailing line forward", () => {
    const { lines, rest } = splitLines('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":');
  });
});
