/**
 * The host worker's watch half, through the SDK's host harness.
 *
 * This is what runs on a MacBook a thread's checkout lives on, when the
 * server asks about builds there that nothing routed through the plugin:
 * Xcode.app's, a terminal's. `ps` and `lsof` are faked (the process table is
 * this suite's input); everything else — DerivedData discovery, manifests,
 * bundles, `realpath` fences — runs for real against a temp directory laid
 * out as Xcode lays DerivedData out.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { afterEach, describe, expect, it } from "vitest";

import { createHostEntry } from "../host";
import {
  makeDerivedRoot,
  makeTestBundle,
  writeBuildManifest,
  xcodeAppPs,
} from "./support/derived-data";
import { fakeXcresult } from "./support/fake-xcodebuild";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xcode-watch-")));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const dataDir = join(base, "host-data");
  const derivedData = join(base, "Library/Developer/Xcode/DerivedData");
  const checkout = join(base, "Development/ios-amion-v2");
  const workspace = join(checkout, "Amion.xcworkspace");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const root = makeDerivedRoot(join(derivedData, "Amion-bkfmqyxwjbnhmfahbwgcrtlvkhzo"), {
    workspace,
    build: [
      { id: "OLD-1", title: "Build Amion", startedAt: NOW - 40 * 86_400_000, endedAt: NOW - 40 * 86_400_000 + 1, status: "S" },
      { id: "NEW-1", title: "Build Amion", startedAt: NOW - 60_000, endedAt: NOW - 30_000, status: "E", errors: 2 },
    ],
  });

  const machine = { ps: "", cwds: new Map<number, string>() };
  const worker = () =>
    experimental_createHostEntryHarness(
      createHostEntry({
        findTool: async () => "/usr/bin/xcresulttool",
        xcresult: fakeXcresult,
        now: () => NOW,
        watch: {
          derivedDataDir: derivedData,
          observer: {
            ps: async () => machine.ps,
            cwdOf: async (pid) => machine.cwds.get(pid) ?? "/",
          },
        },
      }),
      { experimental_paths: { dataDir, tempDir: join(base, "temp") } },
    );
  let mac = worker();
  cleanups.push(() => mac.experimental_dispose());
  const call = <T>(method: string, input: unknown) =>
    mac.experimental_call(method as never, input as never) as Promise<T>;
  const restartWorker = async () => {
    await mac.experimental_dispose();
    mac = worker();
  };
  return { base, dataDir, derivedData, checkout, workspace, root, machine, call, restartWorker };
}

type Activity = {
  pid: number;
  isDaemon: boolean;
  container: string | null;
  roots: string[];
  workerCount: number;
  phase: string | null;
  resultBundlePath: string | null;
  currentFile: string | null;
};

describe("probe", () => {
  it("reports an Xcode.app build with the workspace its DerivedData belongs to", async () => {
    const { machine, call, root, workspace } = setup();
    machine.ps = xcodeAppPs({ servicePid: 812, root, workers: 2 });
    const { activities } = await call<{ activities: Activity[] }>("probe", {});
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      pid: 812,
      isDaemon: true,
      roots: [root],
      // Nothing in the process table names the checkout; the root's
      // info.plist does.
      container: workspace,
      workerCount: 2,
      phase: "compiling",
      currentFile: "File0.swift",
    });
  });

  it("says nothing about an idle Xcode", async () => {
    const { machine, call } = setup();
    machine.ps = xcodeAppPs({ servicePid: 812 });
    expect(await call("probe", {})).toEqual({ activities: [] });
  });

  it("leaves out the builds this worker runs itself, and resolves a relative bundle path", async () => {
    const { machine, call, dataDir, checkout } = setup();
    const tracked = join(dataDir, "builds", "mvv-0123456789ab", "result.xcresult");
    machine.ps = [
      `  900     1 00:10 /bin/sh -c wrapper`,
      `  901   900 00:10 /usr/bin/xcodebuild -scheme Tracked build -resultBundlePath ${tracked}`,
      `  950     1 00:05 /usr/bin/xcodebuild -scheme Amion test -resultBundlePath out/Run.xcresult`,
      "",
    ].join("\n");
    machine.cwds.set(950, checkout);
    const { activities } = await call<{ activities: Activity[] }>("probe", {});
    expect(activities.map((activity) => [activity.pid, activity.resultBundlePath])).toEqual([
      [950, join(checkout, "out/Run.xcresult")],
    ]);
  });
});

describe("discoverRoots", () => {
  it("finds Xcode's shared DerivedData and roots inside the checkouts it is given", async () => {
    const { call, root, checkout, base } = setup();
    makeDerivedRoot(join(checkout, "AmionKit", ".build-sim"));
    const { roots } = await call<{ roots: Array<{ path: string; via: string; projectPath: string | null }> }>(
      "discoverRoots",
      {
        projectPaths: [
          checkout,
          // Not a directory, and not a clean absolute path: both skipped.
          join(base, "missing"),
          `${checkout}/../ios-amion-v2`,
        ],
      },
    );
    expect(roots).toEqual([
      { path: root, via: "default", projectPath: null },
      { path: join(checkout, "AmionKit", ".build-sim"), via: "project-scan", projectPath: checkout },
    ]);
  });
});

describe("readManifests", () => {
  type Reply = {
    roots: Array<{
      root: string;
      workspace: string | null;
      domains: Array<{ kind: string; mtimeMs: number | null; entries: Array<{ uniqueIdentifier: string; status: string; errorCount: number }> }>;
    }>;
  };

  it("reads a root's log store newest first, with its workspace, inside the horizon", async () => {
    const { call, root, workspace } = setup();
    const reply = await call<Reply>("readManifests", {
      roots: [{ path: root, ifModifiedSince: null }],
      notBefore: NOW - 30 * 86_400_000,
    });
    expect(reply.roots).toHaveLength(1);
    expect(reply.roots[0]!.workspace).toBe(workspace);
    expect(reply.roots[0]!.domains).toEqual([
      {
        kind: "build",
        mtimeMs: expect.any(Number),
        entries: [expect.objectContaining({ uniqueIdentifier: "NEW-1", status: "failed", errorCount: 2 })],
      },
    ]);
  });

  it("answers an unchanged manifest with no entries, and a changed one in full", async () => {
    const { call, root } = setup();
    const first = await call<Reply>("readManifests", {
      roots: [{ path: root, ifModifiedSince: null }],
      notBefore: null,
    });
    const mtime = first.roots[0]!.domains[0]!.mtimeMs!;
    const again = await call<Reply>("readManifests", {
      roots: [{ path: root, ifModifiedSince: mtime }],
      notBefore: null,
    });
    expect(again.roots[0]!.domains).toEqual([]);

    writeBuildManifest(root, [
      { id: "NEWER-1", title: "Build Amion", startedAt: NOW, endedAt: NOW + 1, status: "S" },
    ]);
    const { utimesSync } = await import("node:fs");
    const later = new Date(mtime + 5_000);
    utimesSync(join(root, "Logs/Build/LogStoreManifest.plist"), later, later);
    const changed = await call<Reply>("readManifests", {
      roots: [{ path: root, ifModifiedSince: mtime }],
      notBefore: null,
    });
    expect(changed.roots[0]!.domains[0]!.entries.map((entry) => entry.uniqueIdentifier)).toEqual(["NEWER-1"]);
  });

  it("reads only DerivedData roots, and no manifest a link leads out of one", async () => {
    const { call, base, root } = setup();
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "LogStoreManifest.plist"), "<plist/>");
    const linked = makeDerivedRoot(join(base, "linked-root"));
    symlinkSync(join(elsewhere, "LogStoreManifest.plist"), join(linked, "Logs/Build/LogStoreManifest.plist"));

    const reply = await call<Reply>("readManifests", {
      roots: [
        { path: elsewhere, ifModifiedSince: null },
        { path: "/", ifModifiedSince: null },
        { path: linked, ifModifiedSince: null },
        { path: root, ifModifiedSince: null },
      ],
      notBefore: null,
    });
    expect(reply.roots.map((entry) => [entry.root, entry.domains.length])).toEqual([
      [linked, 0],
      [root, 1],
    ]);
  });
});

describe("result bundles", () => {
  it("lists a root's test bundles and which are finalized", async () => {
    const { call, root } = setup();
    const done = makeTestBundle(root, "Run-Amion-2026.11.11_12-00-00");
    const writing = makeTestBundle(root, "Run-Amion-2026.11.11_12-05-00", false);
    expect(await call("inspectBundles", { roots: [root], paths: [] })).toEqual({
      candidates: [done, writing],
      finalized: [done],
    });
  });

  it("reads a bundle in a root's Test logs on this Mac", async () => {
    const { call, root } = setup();
    const bundle = makeTestBundle(root, "Run-Amion");
    expect(await call("summarizeBundle", { path: bundle })).toMatchObject({
      status: "ok",
      bundlePath: bundle,
      build: { status: "passed" },
    });
    const writing = makeTestBundle(root, "Run-Amion-2", false);
    expect(await call("summarizeBundle", { path: writing })).toEqual({ status: "pending" });
  });

  it("refuses a path no build here produced, and one a link leads elsewhere", async () => {
    const { call, root, base } = setup();
    const stray = join(base, "Desktop/Someone.xcresult");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "Info.plist"), "");
    symlinkSync(stray, join(root, "Logs/Test/Linked.xcresult"));

    for (const path of [stray, join(root, "Logs/Test/Linked.xcresult"), "/etc/../tmp/x.xcresult"]) {
      expect(await call("summarizeBundle", { path })).toMatchObject({ status: "refused" });
    }
    const listed = await call<{ candidates: string[] }>("inspectBundles", { roots: [], paths: [stray] });
    expect(listed.candidates).toEqual([]);
  });

  it("reads a bundle a terminal build on this Mac named, also after a worker restart", async () => {
    const { call, machine, checkout, restartWorker } = setup();
    const bundle = join(checkout, "out/Run.xcresult");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, "Info.plist"), "");
    expect(await call("summarizeBundle", { path: bundle })).toMatchObject({ status: "refused" });

    machine.ps = `  950     1 00:05 /usr/bin/xcodebuild -scheme Amion build -resultBundlePath ${bundle}\n`;
    await call("probe", {});
    await restartWorker();
    expect(await call("inspectBundles", { roots: [], paths: [bundle] })).toEqual({
      candidates: [bundle],
      finalized: [bundle],
    });
    expect(await call("summarizeBundle", { path: bundle })).toMatchObject({ status: "ok" });
  });
});
