import { describe, expect, it } from "vitest";
import {
  DriveScriptError,
  parseDriveScript,
  parseDuration,
  parsePoint,
  splitStatements,
  tokenize,
} from "../../src/sim/drive-script.js";
import { centreOf, describeMiss, findByLabel, flatten, MAX_ELEMENTS } from "../../src/sim/ax.js";

describe("splitting a script", () => {
  it("splits on semicolons and newlines", () => {
    expect(splitStatements("tap 0.5,0.5; type hi\nswipe up")).toEqual([
      "tap 0.5,0.5",
      "type hi",
      "swipe up",
    ]);
  });

  it("keeps a quoted semicolon inside its step", () => {
    // `type "hello; world"` is one step, and a person who quoted it said so.
    expect(splitStatements('type "hello; world"')).toEqual(['type "hello; world"']);
  });

  it("ignores empty statements", () => {
    expect(splitStatements(";; tap 0.5,0.5 ;;")).toEqual(["tap 0.5,0.5"]);
  });
});

describe("tokenizing", () => {
  it("keeps a quoted run whole", () => {
    expect(tokenize('tap "Sign in"')).toEqual(["tap", '"Sign in"']);
    expect(tokenize("tap 0.5,0.5")).toEqual(["tap", "0.5,0.5"]);
  });
});

describe("points", () => {
  it("reads a fraction pair", () => {
    expect(parsePoint("0.5,0.9", 0)).toEqual({ x: 0.5, y: 0.9 });
  });

  it("reads a quoted label as an element", () => {
    // `tap "Sign in"` survives a layout change; `tap 0.5,0.87` breaks on the
    // next padding tweak.
    expect(parsePoint('"Sign in"', 0)).toEqual({ element: { label: "Sign in" } });
    expect(parsePoint("'Sign in'", 0)).toEqual({ element: { label: "Sign in" } });
  });

  it("refuses pixels, which would land in the corner", () => {
    expect(() => parsePoint("400,900", 0)).toThrow(/fractions between 0 and 1/);
  });

  it("refuses an Infinity that parseFloat would happily produce", () => {
    expect(() => parsePoint("1e999,0.5", 0)).toThrow(/fractions between 0 and 1/);
  });

  it("refuses an empty label rather than tapping nothing", () => {
    expect(() => parsePoint('""', 0)).toThrow(/cannot be empty/);
  });
});

describe("durations", () => {
  it("accepts bare milliseconds, ms and s", () => {
    expect(parseDuration("500", 0)).toBe(500);
    expect(parseDuration("500ms", 0)).toBe(500);
    expect(parseDuration("1s", 0)).toBe(1000);
    expect(parseDuration("1.5s", 0)).toBe(1500);
  });

  it("refuses a duration nobody meant", () => {
    expect(() => parseDuration("soon", 0)).toThrow(/is not a duration/);
    expect(() => parseDuration("1ms", 0)).toThrow(/between 10ms and 10s/);
    expect(() => parseDuration("60s", 0)).toThrow(/between 10ms and 10s/);
  });
});

describe("the script the CLI documents", () => {
  it("parses end to end", () => {
    const steps = parseDriveScript("tap 0.5,0.9; type hello; swipe up; rotate landscape-left");
    expect(steps).toEqual([
      { kind: "tap", at: { x: 0.5, y: 0.9 } },
      { kind: "type", text: "hello" },
      { kind: "swipe", from: { x: 0.5, y: 0.75 }, to: { x: 0.5, y: 0.25 } },
      { kind: "rotate", orientation: "landscape_left" },
    ]);
  });

  it("takes unquoted text after `type`, because quoting a sentence is friction", () => {
    expect(parseDriveScript("type hello there")).toEqual([{ kind: "type", text: "hello there" }]);
  });

  it("names the three buttons people reach for", () => {
    expect(parseDriveScript("home; lock; siri")).toEqual([
      { kind: "button", name: "home" },
      { kind: "button", name: "lock" },
      { kind: "button", name: "siri" },
    ]);
  });

  it("parses every remaining verb", () => {
    expect(parseDriveScript('double-tap "Row"; press 0.5,0.5 900ms; scroll down; pinch in; key enter; keyboard; wait 1s')).toEqual([
      { kind: "doubleTap", at: { element: { label: "Row" } } },
      { kind: "longPress", at: { x: 0.5, y: 0.5 }, holdMs: 900 },
      { kind: "scroll", dx: 0, dy: 0.5 },
      { kind: "pinch", at: { x: 0.5, y: 0.5 }, from: 0.2, to: 0.7 },
      { kind: "key", name: "enter" },
      { kind: "keyboard" },
      { kind: "wait", ms: 1000 },
    ]);
  });

  it("names the step it failed on", () => {
    // A script that fails on step four should not read as a script that failed.
    try {
      parseDriveScript("tap 0.5,0.5; type hi; frobnicate");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DriveScriptError);
      expect((error as DriveScriptError).index).toBe(2);
      expect((error as DriveScriptError).message).toContain('"frobnicate" is not something this can do');
    }
  });

  it("refuses more steps than a drive may carry", () => {
    const long = Array.from({ length: 25 }, () => "tap 0.5,0.5").join("; ");
    expect(() => parseDriveScript(long)).toThrow(/more than the 24/);
  });

  it("refuses an empty script", () => {
    expect(() => parseDriveScript("   ")).toThrow(/the script is empty/);
  });
});

describe("flattening the accessibility tree", () => {
  /** The shape the native bridge actually returns, from a real device. */
  const tree = [
    {
      AXLabel: " ",
      type: "Application",
      enabled: true,
      frame: { x: 0, y: 0, width: 440, height: 956 },
      children: [
        {
          AXLabel: "21:24",
          type: "StaticText",
          enabled: true,
          frame: { x: 60, y: 22, width: 47, height: 21 },
          children: [],
        },
        {
          AXLabel: "Sign in",
          AXValue: null,
          type: "Button",
          enabled: true,
          frame: { x: 20, y: 800, width: 400, height: 50 },
          children: [],
        },
        {
          AXLabel: "",
          AXValue: "Email address",
          type: "TextField",
          enabled: true,
          frame: { x: 20, y: 400, width: 400, height: 44 },
          children: [],
        },
        {
          AXLabel: "Sign in with Apple",
          type: "Button",
          enabled: false,
          frame: { x: 20, y: 870, width: 400, height: 50 },
          children: [],
        },
      ],
    },
  ];

  it("drops the container covering the whole screen", () => {
    const snapshot = flatten(tree);
    expect(snapshot.screen).toEqual({ width: 440, height: 956 });
    expect(snapshot.elements.map((element) => element.label)).toEqual([
      "21:24",
      "Sign in",
      "",
      "Sign in with Apple",
    ]);
  });

  it("normalizes against accessibility points, not pixels", () => {
    // The root frame is the screen in the same units the elements use, so
    // dividing by the frame's pixel dimensions would be wrong by the scale.
    const snapshot = flatten(tree);
    const signIn = snapshot.elements.find((element) => element.label === "Sign in")!;
    expect(centreOf(snapshot, signIn)).toEqual({ x: 0.5, y: (800 + 25) / 956 });
  });

  it("survives a tree that is not a tree", () => {
    expect(flatten(null).elements).toEqual([]);
    expect(flatten({}).elements).toEqual([]);
  });

  it("stops at the element cap", () => {
    const wide = [
      {
        frame: { x: 0, y: 0, width: 100, height: 100 },
        children: Array.from({ length: MAX_ELEMENTS + 50 }, (_unused, index) => ({
          AXLabel: `row ${index}`,
          frame: { x: 0, y: index, width: 10, height: 10 },
          children: [],
        })),
      },
    ];
    expect(flatten(wide).elements).toHaveLength(MAX_ELEMENTS);
  });
});

describe("finding an element by label", () => {
  const snapshot = flatten([
    {
      frame: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        { AXLabel: "Sign in", enabled: true, frame: { x: 0, y: 0, width: 50, height: 10 }, children: [] },
        { AXLabel: "Sign in with Apple", enabled: true, frame: { x: 0, y: 20, width: 50, height: 10 }, children: [] },
        { AXLabel: "", AXValue: "Email address", enabled: true, frame: { x: 0, y: 40, width: 50, height: 10 }, children: [] },
        { AXLabel: "Cancel", enabled: false, frame: { x: 0, y: 60, width: 50, height: 10 }, children: [] },
      ],
    },
  ]);

  it("prefers an exact match over a prefix of a longer label", () => {
    expect(findByLabel(snapshot, "Sign in")?.element.label).toBe("Sign in");
  });

  it("matches a value when the label is empty", () => {
    // A text field's label is often empty while its value is the placeholder a
    // person would read.
    expect(findByLabel(snapshot, "Email")?.element.value).toBe("Email address");
  });

  it("is case-insensitive", () => {
    expect(findByLabel(snapshot, "SIGN IN")?.element.label).toBe("Sign in");
  });

  it("still finds a disabled element, because greyed out is a useful answer", () => {
    expect(findByLabel(snapshot, "Cancel")?.element.enabled).toBe(false);
  });

  it("answers null rather than guessing", () => {
    expect(findByLabel(snapshot, "Log out")).toBeNull();
    expect(findByLabel(snapshot, "  ")).toBeNull();
  });

  it("names what is on screen when it finds nothing", () => {
    // A model told "Sign in" is present will get it right on the retry, where
    // "not found" sends it to guess coordinates.
    const miss = describeMiss(snapshot, "Log out");
    expect(miss).toContain('Nothing on screen is labelled "Log out"');
    expect(miss).toContain("Sign in");
  });

  it("says so when the screen reports no labels at all", () => {
    expect(describeMiss({ screen: { width: 1, height: 1 }, elements: [] }, "x")).toContain(
      "no labelled elements at all",
    );
  });
});
