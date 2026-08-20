/**
 * Stills, without a project.
 *
 * A **recorded export directory** — real PNGs and sidecars, including one named
 * preview, one anonymous macro preview, one duplicate display name, one dotted
 * filename and one sidecar with `diff_threshold: 0.050000012` — plus a mutated
 * copy as the base, makes import → diff → verdict testable with zero Xcode.
 */
import { afterEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATIONS, prepareConnection } from "../../src/sim/store.js";
import { FrameStore } from "../../src/sim/framestore.js";
import {
  importExport,
  MAX_EXPORT_FRAMES,
  MAX_EXPORT_IMAGE_EDGE,
  MAX_EXPORT_MANIFEST_NAME_BYTES,
  MAX_EXPORT_PNG_BYTES,
  MAX_EXPORT_SIDECAR_BYTES,
  parseManifest,
  explainRenderFailure,
  explainEmptyRender,
  explainNoTestAction,
} from "../../src/sim/stills.js";
import { listFrames, insertLook } from "../../src/sim/frames.js";
import { compareCheaply, parseOdiffOutput, ratioFrom, runOdiff, applyThreshold } from "../../src/sim/diff.js";
import {
  summarize,
  describeEmpty,
  describeSetChange,
  rekeySentence,
  rekeyPrimaryLabel,
  truncationSentence,
} from "../../src/sim/verdict.js";
import { findTestTargets, findXctestrunFiles, keyPath, schemeOf } from "../../src/sim/xctestrun.js";
import {
  buildForTestingArgv,
  destinationFor,
  testWithoutBuildingArgv,
  type BuildTarget,
} from "../../src/sim/xcodebuild.js";
import type { Look } from "../../src/sim/model.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/export", import.meta.url));
const ODIFF = fileURLToPath(new URL("../node_modules/odiff-bin/bin/odiff", import.meta.url));

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): { db: BetterSqlite3.Database; store: FrameStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "xcsim-stills-"));
  temps.push(dir);
  const db = new BetterSqlite3(join(dir, "data.db"));
  prepareConnection(db);
  for (const statement of MIGRATIONS) db.exec(statement);
  return { db, store: new FrameStore(join(dir, "frames")), dir };
}

function seedLook(db: BetterSqlite3.Database, id: string, at: number): void {
  insertLook(db, {
    id,
    projectId: "proj_1",
    scopeKey: "scope",
    kind: "stills",
    status: "ok",
    commitSha: "a1b2c3d4",
    branch: "main",
    deviceKey: "iPhone 17 Pro|26.5|3|arm64",
    deviceUdid: "u1",
    deviceName: "iPhone 17 Pro",
    osVersion: "26.5",
    scale: 3,
    startedAt: at,
  });
}

describe("importing a recorded export", () => {
  it("reads every preview, including the ones that break naive parsers", async () => {
    const { db, store } = scratch();
    seedLook(db, "lk_head", 2);
    const result = await importExport({
      db,
      store,
      lookId: "lk_head",
      scopeKey: "scope",
      exportDir: join(FIXTURES, "head"),
      now: () => 2,
    });

    expect(result.count).toBe(7);
    const frames = listFrames(db, "lk_head");
    const identities = frames.map((frame) => frame.identity);
    // The anonymous macro preview, keyed by ordinal.
    expect(identities).toContain("preview:Almanac_RecipeList.swift_2.png");
    // Two previews sharing a display name in different files stay distinct.
    expect(identities).toContain("preview:Almanac_Login.swift_Dark_Mode.png");
    expect(identities).toContain("preview:Almanac_Signup.swift_Dark_Mode.png");
    // The dotted filename survives.
    expect(identities).toContain("preview:MyModule_LoginView.swift_Dark_Mode.png");
    db.close();
  });

  it("reads the sidecar through the suffix swap, not an extension replacement", async () => {
    const { db, store } = scratch();
    seedLook(db, "lk_head", 2);
    await importExport({ db, store, lookId: "lk_head", scopeKey: "scope", exportDir: join(FIXTURES, "head"), now: () => 2 });

    const frame = listFrames(db, "lk_head").find(
      (entry) => entry.identity === "preview:Almanac_RecipeList.swift_Empty.png",
    );
    // `diff_threshold` round-trips through `1 - precision` in Float upstream.
    expect(frame?.diffThreshold).toBeCloseTo(0.05, 6);
    expect(frame?.displayName).toBe("Empty");
    db.close();
  });

  it("records the group and the display name from the filename", async () => {
    const { db, store } = scratch();
    seedLook(db, "lk_head", 2);
    await importExport({ db, store, lookId: "lk_head", scopeKey: "scope", exportDir: join(FIXTURES, "head"), now: () => 2 });
    const frame = listFrames(db, "lk_head").find(
      (entry) => entry.identity === "preview:MyModule_LoginView.swift_Dark_Mode.png",
    );
    expect(frame?.groupName).toBe("MyModule / LoginView.swift / Dark");
    db.close();
  });

  it("survives an export directory that is not there", async () => {
    const { db, store } = scratch();
    const result = await importExport({
      db,
      store,
      lookId: "lk_x",
      scopeKey: "scope",
      exportDir: join(FIXTURES, "nope"),
      now: () => 1,
    });
    expect(result).toEqual({ count: 0, bytes: 0, names: new Set() });
    db.close();
  });

  it("preflights total bytes before creating the look directory", async () => {
    const { db, store, dir } = scratch();
    seedLook(db, "lk_budget", 2);
    const exportDir = join(dir, "export");
    mkdirSync(exportDir);
    const source = join(FIXTURES, "head", "Almanac_Card.swift_Wide.png");
    const target = join(exportDir, "Almanac_Card.swift_Wide.png");
    copyFileSync(source, target);
    let reserved = 0;
    const result = await importExport({
      db,
      store,
      lookId: "lk_budget",
      scopeKey: "scope",
      exportDir,
      now: () => 2,
      beforeWrite: async (bytes) => {
        reserved = bytes;
      },
    });
    expect(reserved).toBeGreaterThan(0);
    expect(result.count).toBe(1);
    db.close();
  });

  it("rechecks bytes that grow after the directory preflight", async () => {
    const { db, store, dir } = scratch();
    seedLook(db, "lk_growing", 2);
    const exportDir = join(dir, "export");
    mkdirSync(exportDir);
    const target = join(exportDir, "Growing.png");
    copyFileSync(join(FIXTURES, "head", "Almanac_Card.swift_Wide.png"), target);
    const checks: number[] = [];
    const result = await importExport({
      db,
      store,
      lookId: "lk_growing",
      scopeKey: "scope",
      exportDir,
      now: () => 2,
      beforeWrite: async (bytes) => {
        checks.push(bytes);
        if (checks.length === 1) appendFileSync(target, Buffer.alloc(1024));
      },
    });
    expect(result.count).toBe(1);
    expect(checks).toHaveLength(2);
    expect(checks[1]!).toBeGreaterThan(checks[0]!);
    db.close();
  });

  it("rejects oversized PNGs and sidecars before reading them", async () => {
    const { db, store, dir } = scratch();
    seedLook(db, "lk_large", 2);
    const exportDir = join(dir, "export");
    mkdirSync(exportDir);
    const png = join(exportDir, "Large.png");
    writeFileSync(png, "");
    truncateSync(png, MAX_EXPORT_PNG_BYTES + 1);
    await expect(
      importExport({ db, store, lookId: "lk_large", scopeKey: "scope", exportDir, now: () => 2 }),
    ).rejects.toThrow(/per-image safety limit/);

    rmSync(png);
    copyFileSync(join(FIXTURES, "head", "Almanac_Card.swift_Wide.png"), png);
    const sidecar = join(exportDir, "Large.json");
    writeFileSync(sidecar, "");
    truncateSync(sidecar, MAX_EXPORT_SIDECAR_BYTES + 1);
    await expect(
      importExport({ db, store, lookId: "lk_large", scopeKey: "scope", exportDir, now: () => 2 }),
    ).rejects.toThrow(/sidecar.*safety limit/);
    db.close();
  });

  it("rejects compressed images that declare unsafe dimensions", async () => {
    const { db, store, dir } = scratch();
    seedLook(db, "lk_dimensions", 2);
    const exportDir = join(dir, "export");
    mkdirSync(exportDir);
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
    header.writeUInt32BE(13, 8);
    Buffer.from("IHDR").copy(header, 12);
    header.writeUInt32BE(MAX_EXPORT_IMAGE_EDGE + 1, 16);
    header.writeUInt32BE(1, 20);
    writeFileSync(join(exportDir, "Bomb.png"), header);
    await expect(
      importExport({ db, store, lookId: "lk_dimensions", scopeKey: "scope", exportDir, now: () => 2 }),
    ).rejects.toThrow(/dimensions beyond the safety limit/);
    db.close();
  });

  it("never follows a generated PNG symlink", async () => {
    const { db, store, dir } = scratch();
    seedLook(db, "lk_link", 2);
    const exportDir = join(dir, "export");
    mkdirSync(exportDir);
    symlinkSync(join(FIXTURES, "head", "Almanac_Card.swift_Wide.png"), join(exportDir, "Linked.png"));
    const result = await importExport({
      db,
      store,
      lookId: "lk_link",
      scopeKey: "scope",
      exportDir,
      now: () => 2,
    });
    expect(result.count).toBe(0);
    db.close();
  });

  it("refuses an unbounded number of generated frames", async () => {
    const { db, store, dir } = scratch();
    seedLook(db, "lk_many", 2);
    const exportDir = join(dir, "export");
    mkdirSync(exportDir);
    for (let index = 0; index <= MAX_EXPORT_FRAMES; index += 1) {
      writeFileSync(join(exportDir, `Frame-${index}.png`), "");
    }
    await expect(
      importExport({ db, store, lookId: "lk_many", scopeKey: "scope", exportDir, now: () => 2 }),
    ).rejects.toThrow(/safety limit/);
    db.close();
  });
});

describe("the manifest", () => {
  it("is one name per line, deduplicated and sorted", async () => {
    const text = await readFile(join(FIXTURES, "manifest.txt"), "utf8");
    const manifest = parseManifest(text);
    expect(manifest).toHaveLength(8);
    expect(manifest).toEqual([...manifest].sort());
    // The name that never rendered is in the manifest, which is the whole point.
    expect(manifest).toContain("Almanac_Crash.swift_Boom.png");
  });

  it("ignores blank lines rather than counting them", () => {
    expect(parseManifest("a.png\n\n b.png \n\n")).toEqual(["a.png", "b.png"]);
  });

  it("bounds manifest entries and individual names before persisting them", () => {
    expect(() =>
      parseManifest(
        Array.from({ length: MAX_EXPORT_FRAMES + 1 }, (_unused, index) => `${index}.png`).join("\n"),
      ),
    ).toThrow(/entry safety limit/);
    expect(() => parseManifest(`${"a".repeat(MAX_EXPORT_MANIFEST_NAME_BYTES + 1)}.png`)).toThrow(
      /name beyond the safety limit/,
    );
  });
});

describe("the diff ladder", () => {
  const frame = (hash: string, width = 8, height = 8) => ({
    contentHash: hash,
    width,
    height,
    relPath: "a.png",
    diffThreshold: null,
  });

  it("eliminates an identical pair for free", () => {
    const result = compareCheaply(
      { identity: "preview:a.png", base: frame("h1"), head: frame("h1") },
      new Set(),
    );
    expect(result).toMatchObject({ status: "unchanged", rung: "hash" });
  });

  it("calls a dimension change layout-changed without asking odiff", () => {
    // odiff produces no mask for a dimension mismatch, and a fabricated one
    // would be a lie.
    const result = compareCheaply(
      { identity: "preview:a.png", base: frame("h1"), head: frame("h2", 8, 10) },
      new Set(),
    );
    expect(result).toMatchObject({ status: "layout-changed", rung: "dimensions" });
  });

  it("reports a manifest name with no frame as missing, never as removed", () => {
    // "You deleted this preview" and "this preview crashed" are opposite facts.
    const result = compareCheaply(
      { identity: "preview:crash.png", base: frame("h1"), head: null },
      new Set(["preview:crash.png"]),
    );
    expect(result?.status).toBe("missing");
  });

  it("reports a frame only in the base as removed", () => {
    const result = compareCheaply({ identity: "preview:old.png", base: frame("h1"), head: null }, new Set());
    expect(result?.status).toBe("removed");
  });

  it("reports a frame only in the head as added", () => {
    const result = compareCheaply({ identity: "preview:new.png", base: null, head: frame("h1") }, new Set());
    expect(result?.status).toBe("added");
  });

  it("defers to odiff for a same-size, different-content pair", () => {
    expect(compareCheaply({ identity: "preview:a.png", base: frame("h1"), head: frame("h2") }, new Set())).toBeNull();
  });
});

describe("odiff's output", () => {
  it("reads a bare 0 as well as a count;percentage pair", () => {
    // Measured: `--parsable-stdout` prints a bare `0` when nothing differs, not
    // `0;0.00`. A parser reading field [1] gets undefined on the common case.
    expect(parseOdiffOutput("0", 0)).toEqual({ count: 0, layout: false, error: null });
    expect(parseOdiffOutput("4;6.25", 22)).toEqual({ count: 4, layout: false, error: null });
    expect(parseOdiffOutput("", 0)).toEqual({ count: 0, layout: false, error: null });
  });

  it("reads the layout answer, which only appears with --fail-on-layout", () => {
    expect(parseOdiffOutput("layout", 21)).toEqual({ count: null, layout: true, error: null });
  });

  it("keeps an error message rather than inventing a count", () => {
    const result = parseOdiffOutput("Error: Could not load comparison image", 1);
    expect(result.count).toBeNull();
    expect(result.error).toContain("Could not load");
  });

  it("computes the ratio itself, never from the rounded percentage", () => {
    // odiff rounds to two decimals, so a real 0.004% diff prints as 0.00.
    expect(ratioFrom(4, 8, 8)).toBe(0.0625);
    expect(ratioFrom(1, 8, 8)).toBe(0.015625);
    expect(ratioFrom(1, 0, 0)).toBe(0);
  });
});

describe.skipIf(!existsSync(ODIFF))("odiff, for real", () => {
  const png = (name: string) => fileURLToPath(new URL(`./fixtures/png/${name}`, import.meta.url));

  it("finds the single changed pixel that --antialiasing would have hidden", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xcsim-odiff-"));
    temps.push(dir);
    const output = await runOdiff({
      odiffPath: ODIFF,
      basePath: png("base.png"),
      headPath: png("changed-tiny.png"),
      maskPath: join(dir, "mask.png"),
      width: 8,
      height: 8,
    });
    expect(output).toMatchObject({ status: "changed", diffPixels: 1 });
    expect(output.diffRatio).toBeCloseTo(1 / 64, 10);
  });

  it("answers layout for mismatched dimensions rather than a fabricated ratio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xcsim-odiff-"));
    temps.push(dir);
    const output = await runOdiff({
      odiffPath: ODIFF,
      basePath: png("base.png"),
      headPath: png("layout.png"),
      maskPath: join(dir, "mask.png"),
      width: 8,
      height: 10,
    });
    expect(output.status).toBe("layout-changed");
    expect(output.maskWritten).toBe(false);
  });

  it("writes no mask when nothing differs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xcsim-odiff-"));
    temps.push(dir);
    const output = await runOdiff({
      odiffPath: ODIFF,
      basePath: png("base.png"),
      headPath: png("identical.png"),
      maskPath: join(dir, "mask.png"),
      width: 8,
      height: 8,
    });
    expect(output.status).toBe("unchanged");
    expect(existsSync(join(dir, "mask.png"))).toBe(false);
  });
});

describe("the threshold", () => {
  const changed = { status: "changed" as const, diffRatio: 0.05, diffPixels: 3, maskWritten: true, error: null };

  it("is this plugin's, not the diff engine's", () => {
    // odiff runs at its defaults and reports everything; the decision is here.
    expect(applyThreshold(changed, null, 0.01)).toBe("changed");
    expect(applyThreshold(changed, null, 0.1)).toBe("unchanged");
  });

  it("lets a per-frame sidecar override the global", () => {
    expect(applyThreshold(changed, 0.1, 0.01)).toBe("unchanged");
    expect(applyThreshold(changed, 0.001, 0.5)).toBe("changed");
  });

  it("tolerates the Float round-trip", () => {
    const atThreshold = { ...changed, diffRatio: 0.05 };
    expect(applyThreshold(atThreshold, 0.050000012, 0.01)).toBe("unchanged");
  });
});

describe("the verdict sentence", () => {
  const look = (over: Partial<Look> = {}): Look => ({
    id: "lk_1",
    projectId: "p",
    scopeKey: "s",
    kind: "stills",
    status: "ok",
    commitSha: "aaaaaaaa",
    branch: "main",
    deviceKey: "iPhone 17 Pro|26.5|3|arm64",
    deviceUdid: "u",
    deviceName: "iPhone 17 Pro",
    osVersion: "26.5",
    scale: 3,
    startedAt: 1,
    endedAt: 2,
    frameCount: 148,
    expectedCount: 148,
    manifestRan: true,
    bytesTotal: 0,
    error: null,
    ...over,
  });

  const row = (status: string, identity: string) => ({
    identity,
    displayName: identity,
    groupName: "",
    status: status as never,
    diffRatio: null,
    flaky: false,
    flakyDetail: null,
  });

  it("names the count and the base commit when things changed", () => {
    const summary = summarize({
      look: look(),
      rows: [row("changed", "a"), ...Array.from({ length: 147 }, (_u, i) => row("unchanged", `u${i}`))],
      manifest: [],
      baseCommit: "a1b2c3d4e5",
      firstRun: false,
      undiffed: false,
    });
    expect(summary.sentence).toBe("1 of 148 previews changed since `a1b2c3d`.");
  });

  it("does not claim agreement when the set of previews changed", () => {
    // Regression: three previews that did not exist in the baseline used to be
    // announced as "Everything looks the same as `a1b2c3d`."
    const rows = [row("added", "a"), row("added", "b"), row("unchanged", "c")];
    expect(
      summarize({ look: look(), rows, manifest: [], baseCommit: "a1b2c3d4", firstRun: false, undiffed: false })
        .sentence,
    ).toBe("2 new previews. Nothing else changed since `a1b2c3d`.");

    expect(describeSetChange(1, 0)).toBe("1 new preview");
    expect(describeSetChange(0, 1)).toBe("1 preview is gone");
    expect(describeSetChange(0, 3)).toBe("3 previews are gone");
    expect(describeSetChange(3, 1)).toBe("3 new previews and 1 gone");
  });

  it("claims agreement only when the run earned it", () => {
    const rows = Array.from({ length: 148 }, (_u, i) => row("unchanged", `u${i}`));
    expect(
      summarize({ look: look(), rows, manifest: [], baseCommit: "a1b2c3d4", firstRun: false, undiffed: false })
        .sentence,
    ).toBe("Everything looks the same as `a1b2c3d`.");

    // Same empty result, no denominator: never "everything looks the same".
    const noManifest = summarize({
      look: look({ manifestRan: false, expectedCount: null, frameCount: 0 }),
      rows: [],
      manifest: [],
      baseCommit: "a1b2c3d4",
      firstRun: false,
      undiffed: false,
    });
    expect(noManifest.sentence).toContain("did not report how many previews there are");
  });

  it("says a first run is a first run, not 148 regressions", () => {
    const summary = summarize({
      look: look(),
      rows: Array.from({ length: 148 }, (_u, i) => row("added", `a${i}`)),
      manifest: [],
      baseCommit: null,
      firstRun: true,
      undiffed: false,
    });
    expect(summary.sentence).toBe(
      "First run on iPhone 17 Pro — 148 previews rendered, nothing to compare against yet.",
    );
  });

  it("says so when odiff was missing rather than claiming agreement", () => {
    const summary = summarize({
      look: look(),
      rows: [],
      manifest: [],
      baseCommit: null,
      firstRun: false,
      undiffed: true,
    });
    expect(summary.sentence).toBe("Rendered 148 previews. odiff is missing, so nothing was compared.");
  });

  it("puts a broken render above a changed one", () => {
    const summary = summarize({
      look: look(),
      rows: [row("changed", "a"), row("missing", "b")],
      manifest: [],
      baseCommit: "a1b2c3d4",
      firstRun: false,
      undiffed: false,
    });
    expect(summary.sentence).toBe("1 of 148 previews did not render.");
    // Failure first: `missing` sorts above `changed`.
    expect(summary.rows[0]?.status).toBe("missing");
  });

  it("names every empty result", () => {
    expect(describeEmpty(look({ manifestRan: false }))).toContain("did not report how many");
    expect(describeEmpty(look({ expectedCount: 0 }))).toContain("hosted by your app");
    expect(describeEmpty(look({ frameCount: 0 }))).toBe(
      "The manifest pass found 148 previews and none of them rendered.",
    );
  });
});

describe("the re-key and truncation lines", () => {
  it("asks whether a file moved rather than asking for a signature", () => {
    // The state where you are least sure what happened is not the state to
    // promote an irreversible action to primary.
    const rekey = { changed: 112, total: 148, realCount: 8 };
    expect(rekeySentence(rekey)).toBe(
      "112 of 148 previews changed — that usually means previews were re-keyed rather than that the UI moved. Did a file move?",
    );
    expect(rekeyPrimaryLabel(rekey)).toBe("Show me the 8 that actually moved");
  });

  it("names where the runner stopped rather than listing sixty-one rows", () => {
    expect(truncationSentence({ stoppedAfter: "preview:Feed_Empty.png", neverReached: 61 })).toBe(
      "The test runner stopped after `Feed_Empty` — 61 later previews were never reached.",
    );
  });
});

describe("SnapshotPreviews' one opaque failure", () => {
  it("is translated, and degrades to nothing when upstream changes the string", () => {
    // `SnapshotTest.testPreview` waits 10s and fails with exactly "Did not
    // render"; HeightExpansionTimeLimitInSeconds is 30, so the expansion
    // timeout can never fire.
    expect(explainRenderFailure("... XCTFail: Did not render ...")).toBe(
      "This preview took longer than 10s to lay out — usually an unbounded List.",
    );
    expect(explainRenderFailure("some other failure")).toBeNull();
  });
});

describe("the render pass clears the manifest variable by removing it", () => {
  it("never sets it to an empty string", async () => {
    // Verified the hard way against SnapshotPreviews 0.18.0:
    // AllSnapshotImageNamesWriter.createFromEnvironment guards the key for
    // presence and then preconditionFailure()s on an empty value, so blanking
    // it crashes the runner before it bootstraps — "Early unexpected exit,
    // operation never finished bootstrapping".
    const source = await readFile(fileURLToPath(new URL("../../src/sim/stills.ts", import.meta.url)), "utf8");
    expect(source).toContain("removeEnvironment(xctestrunPath, [MANIFEST_ENV]");
    expect(source).not.toMatch(/\[MANIFEST_ENV\]:\s*""/);
  });
});

describe("the .xctestrun editor", () => {
  const plist = {
    __xctestrun_metadata__: { FormatVersion: 2 },
    ContainerInfo: { SchemeName: "Almanac" },
    TestConfigurations: [
      { TestTargets: [{ BlueprintName: "AlmanacTests" }, { BlueprintName: "AlmanacUITests" }] },
    ],
  };

  it("finds every target in FormatVersion 2", () => {
    expect(findTestTargets(plist)).toEqual([
      { blueprintName: "AlmanacTests", configurationIndex: 0, targetIndex: 0 },
      { blueprintName: "AlmanacUITests", configurationIndex: 0, targetIndex: 1 },
    ]);
    expect(schemeOf(plist)).toBe("Almanac");
  });

  it("recognises FormatVersion 1 rather than silently finding nothing", () => {
    const v1 = { __xctestrun_metadata__: { FormatVersion: 1 }, AlmanacTests: { TestBundlePath: "x" } };
    expect(findTestTargets(v1).map((target) => target.blueprintName)).toEqual(["AlmanacTests"]);
  });

  it("escapes a dot in a variable name", () => {
    // A key with a dot would otherwise read as two plutil path components.
    const target = { blueprintName: "AlmanacTests", configurationIndex: 0, targetIndex: 0 };
    expect(keyPath(target, "TestingEnvironmentVariables", "SNAPSHOTS_EXPORT_DIR")).toBe(
      "TestConfigurations.0.TestTargets.0.TestingEnvironmentVariables.SNAPSHOTS_EXPORT_DIR",
    );
    expect(keyPath(target, "EnvironmentVariables", "com.example.flag")).toBe(
      "TestConfigurations.0.TestTargets.0.EnvironmentVariables.com\\.example\\.flag",
    );
  });
});

describe("failures a green build can hide", () => {
  it("refuses to call a render that exported nothing a success", () => {
    // Measured against SnapshotPreviews 0.18.0: three tests pass in 0.000s
    // each, `** TEST SUCCEEDED **`, and the export directory is empty.
    const sentence = explainEmptyRender(3);
    expect(sentence).toContain("3 previews found, 0 rendered");
    expect(sentence).toContain("host application");
    expect(explainEmptyRender(1)).toContain("1 preview found");
  });

  it("names the scheme when the scheme has no test action", () => {
    expect(explainNoTestAction("Almanac")).toContain("The scheme Almanac built");
    expect(explainNoTestAction("Almanac")).toContain("no test action");
  });

  it("prefers the newest .xctestrun, not the first one alphabetically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "xcsim-xctestrun-"));
    temps.push(dir);
    const products = join(dir, "Build", "Products");
    mkdirSync(products, { recursive: true });
    // "A…" sorts first by name; "z…" is the one the build just wrote.
    writeFileSync(join(products, "A_stale.xctestrun"), "{}");
    writeFileSync(join(products, "z_fresh.xctestrun"), "{}");
    utimesSync(join(products, "A_stale.xctestrun"), new Date(1000), new Date(1000));
    utimesSync(join(products, "z_fresh.xctestrun"), new Date(9000), new Date(9000));

    const found = await findXctestrunFiles(dir);
    expect(found.map((path) => path.split("/").pop())).toEqual([
      "z_fresh.xctestrun",
      "A_stale.xctestrun",
    ]);
  });

  it("has no .xctestrun to offer when the products directory is missing", async () => {
    expect(await findXctestrunFiles(join(tmpdir(), "xcsim-not-a-real-dir"))).toEqual([]);
  });
});

describe("the xcodebuild argv", () => {
  const target = (over: Partial<BuildTarget> = {}): BuildTarget => ({
    projectRelPath: "apps/Almanac/Almanac.xcworkspace",
    shape: "xcworkspace",
    scheme: "Almanac",
    destination: destinationFor("UDID-1"),
    derivedDataPath: "/derived",
    resultBundlePath: "/derived/results/lk_1",
    ...over,
  });

  it("names the project relative to the directory the build runs in", () => {
    // The build's cwd is the directory containing the project, so passing the
    // checkout-relative path asks for apps/Almanac/Almanac.xcworkspace from
    // inside apps/Almanac. xcodebuild answers with a bare "error (66)".
    expect(buildForTestingArgv(target())).toContain("Almanac.xcworkspace");
    expect(buildForTestingArgv(target())).not.toContain("apps/Almanac/Almanac.xcworkspace");

    const project = target({ projectRelPath: "apps/Almanac.xcodeproj", shape: "xcodeproj" });
    expect(buildForTestingArgv(project)).toContain("-project");
    expect(buildForTestingArgv(project)).toContain("Almanac.xcodeproj");

    // SwiftPM, XcodeGen and Tuist build from the directory with no flag at all.
    for (const shape of ["spm", "xcodegen", "tuist", "unknown"] as const) {
      const argv = buildForTestingArgv(target({ shape, projectRelPath: "packages/Almanac" }));
      expect(argv).not.toContain("-project");
      expect(argv).not.toContain("-workspace");
    }
  });

  it("keeps each run's result bundle to itself", () => {
    // xcodebuild refuses to overwrite an existing bundle and fails in about a
    // second with no diagnostics, so a shared path breaks every run but the first.
    const argv = testWithoutBuildingArgv("/derived/x.xctestrun", target(), null, "render.xcresult");
    expect(argv).toContain("/derived/results/lk_1/render.xcresult");
    expect(argv).toContain("test-without-building");
    expect(argv).not.toContain("-only-testing:");

    const scoped = testWithoutBuildingArgv("/x.xctestrun", target(), "AlmanacPreviewTests", "m.xcresult");
    expect(scoped).toContain("-only-testing:AlmanacPreviewTests");
  });
});
