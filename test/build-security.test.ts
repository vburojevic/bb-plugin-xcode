import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpath } from "node:fs/promises";

import { confinedBuildCwd, validateBuildArguments } from "../src/build-security";
import { curatedChildEnv } from "../src/child-env";
import { trustedExecutable } from "../src/sim/exec";
import { pathExportLine, shellQuote } from "../src/shim";
import { resolveBuildArgv } from "../src/wrapped";

const temps: string[] = [];

function scratch(): { root: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), "bb-xcode-security-"));
  temps.push(base);
  const root = join(base, "checkout");
  const outside = join(base, "outside");
  mkdirSync(join(root, "App"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "App", "config.xcconfig"), "");
  writeFileSync(join(outside, "secret.xcconfig"), "");
  return { root, outside };
}

afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("the tracked build execution boundary", () => {
  it("accepts only the absolute system xcodebuild stub", () => {
    expect(resolveBuildArgv(["xcodebuild", "-scheme", "App", "build"])[0]).toBe(
      "/usr/bin/xcodebuild",
    );
    expect(() => resolveBuildArgv(["/bin/sh", "-c", "id"])).toThrow(/Only xcodebuild/);
    expect(() => resolveBuildArgv(["/tmp/xcodebuild", "build"])).toThrow(/Only xcodebuild/);
  });

  it("confines cwd through real paths, including symlinks", async () => {
    const { root, outside } = scratch();
    expect(await confinedBuildCwd(root, "App")).toBe(await realpath(join(root, "App")));
    await expect(confinedBuildCwd(root, outside)).rejects.toThrow(/inside this thread's checkout/);
    symlinkSync(outside, join(root, "escape"));
    await expect(confinedBuildCwd(root, "escape")).rejects.toThrow(/inside this thread's checkout/);
  });

  it("confines xcodebuild path options and their existing ancestors", async () => {
    const { root, outside } = scratch();
    await expect(
      validateBuildArguments(
        ["/usr/bin/xcodebuild", "-xcconfig", "config.xcconfig", "-derivedDataPath", "Derived", "build"],
        root,
        join(root, "App"),
      ),
    ).resolves.toBeUndefined();
    await expect(
      validateBuildArguments(["/usr/bin/xcodebuild", "-xcconfig", join(outside, "secret.xcconfig"), "build"], root, root),
    ).rejects.toThrow(/must stay inside/);
    await expect(
      validateBuildArguments(["/usr/bin/xcodebuild", `-project=${join(outside, "App.xcodeproj")}`, "build"], root, root),
    ).rejects.toThrow(/must stay inside/);
    await expect(
      validateBuildArguments(["/usr/bin/xcodebuild", "-derivedDataPath", "$(HOME)/Derived", "build"], root, root),
    ).rejects.toThrow(/deferred variable expansion/);
    symlinkSync(outside, join(root, "redirect"));
    await expect(
      validateBuildArguments(["/usr/bin/xcodebuild", "-derivedDataPath", "redirect/new", "build"], root, root),
    ).rejects.toThrow(/resolves through/);
  });

  it("rejects host-mutating modes and absolute build-setting escapes", async () => {
    const { root, outside } = scratch();
    await expect(
      validateBuildArguments(["/usr/bin/xcodebuild", "-downloadAllPlatforms"], root, root),
    ).rejects.toThrow(/not available/);
    for (const option of [
      "-runFirstLaunch",
      "-deleteComponent",
      "-exportArchive",
      "-skipMacroValidation",
      "-collect-test-diagnostics",
    ]) {
      await expect(validateBuildArguments(["/usr/bin/xcodebuild", option], root, root)).rejects.toThrow(
        /not available/,
      );
    }
    await expect(
      validateBuildArguments(["/usr/bin/xcodebuild", "-downloadPlatform=iOS"], root, root),
    ).rejects.toThrow(/not available/);
    await expect(
      validateBuildArguments(["/usr/bin/xcodebuild", `SYMROOT=${outside}`, "build"], root, root),
    ).rejects.toThrow(/build-setting path/);
    await expect(
      validateBuildArguments(["/usr/bin/xcodebuild", "SYMROOT=../outside", "build"], root, root),
    ).rejects.toThrow(/build-setting path/);
    await expect(
      validateBuildArguments(["/usr/bin/xcodebuild", "SYMROOT=$(HOME)/Products", "build"], root, root),
    ).rejects.toThrow(/deferred variable expansion/);
  });
});

describe("child-process inputs", () => {
  it("does not resolve Apple and system helpers through PATH", () => {
    expect(trustedExecutable("xcodebuild")).toBe("/usr/bin/xcodebuild");
    expect(trustedExecutable("xcrun")).toBe("/usr/bin/xcrun");
    expect(trustedExecutable("git")).toBe("/usr/bin/git");
    expect(trustedExecutable("/opt/plugin/bin/odiff")).toBe("/opt/plugin/bin/odiff");
  });

  it("drops server credentials while preserving the developer toolchain", () => {
    const env = curatedChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/test",
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      XCODE_XCCONFIG_FILE: "/tmp/server-owned.xcconfig",
      BB_SERVER_TOKEN: "server-secret",
      OPENAI_API_KEY: "provider-secret",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.DEVELOPER_DIR).toContain("Xcode.app");
    expect(env.XCODE_XCCONFIG_FILE).toBeUndefined();
    expect(env.BB_SERVER_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("quotes shim paths as one literal shell word", () => {
    expect(shellQuote("/tmp/a'$(touch nope)")).toBe("'/tmp/a'\"'\"'$(touch nope)'");
    expect(pathExportLine("/tmp/a'$(touch nope)")).toBe(
      "export PATH='/tmp/a'\"'\"'$(touch nope)':\"$PATH\"",
    );
  });
});
