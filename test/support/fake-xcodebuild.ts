/**
 * A stand-in for `xcodebuild`, for the host worker's suites.
 *
 * The worker's `/bin/sh` wrapper, its exit-status file, its process group and
 * its `ps` identity checks are the real thing in those suites; only the build
 * is fake. This script writes a result stream and a finalized bundle and
 * exits as its `-scheme` says:
 *
 *  - `pass`: exit 0;
 *  - `fail`: an error on the stream, a `failed` marker in the bundle, exit 65;
 *  - `slow`: thirty seconds, for stop tests;
 *  - `gated`: until a file named `go` appears in the working directory.
 *
 * POSIX sh only, so it runs on the Linux CI runner too.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FAKE_XCODEBUILD = `#!/bin/sh
bundle=""; stream=""; scheme=""
while [ $# -gt 0 ]; do
  case "$1" in
    -resultBundlePath) bundle="$2"; shift ;;
    -resultStreamPath) stream="$2"; shift ;;
    -scheme) scheme="$2"; shift ;;
  esac
  shift
done
printf '%s\\n' '{"name":"invocationStarted","structuredPayload":{}}' >> "$stream"
printf '%s\\n' '{"name":"logSectionCreated","structuredPayload":{"section":{"title":"Compile App"}}}' >> "$stream"
case "$scheme" in
  slow) sleep 30 ;;
  gated) while [ ! -f "$PWD/go" ]; do sleep 0.05; done ;;
esac
case "$scheme" in
  fail) printf '%s\\n' '{"name":"issueEmitted","structuredPayload":{"severity":"error"}}' >> "$stream" ;;
esac
echo "fake xcodebuild done" >&2
mkdir -p "$bundle"
touch "$bundle/Info.plist"
case "$scheme" in
  fail) touch "$bundle/failed"; exit 65 ;;
esac
exit 0
`;

export interface Workspace {
  base: string;
  /** The thread's checkout, as it exists on "the Mac". */
  checkout: string;
  /** The host worker's data dir on that Mac. */
  dataDir: string;
  /** Path of the fake xcodebuild. */
  fake: string;
  /** Let a `gated` build finish. */
  release(): void;
  cleanup(): void;
}

export function makeWorkspace(prefix = "xcode-host-"): Workspace {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const checkout = join(base, "checkout");
  const dataDir = join(base, "data");
  mkdirSync(join(checkout, "App"), { recursive: true });
  mkdirSync(dataDir);
  const fake = join(base, "fake-xcodebuild");
  writeFileSync(fake, FAKE_XCODEBUILD);
  chmodSync(fake, 0o755);
  return {
    base,
    checkout,
    dataDir,
    fake,
    release: () => writeFileSync(join(checkout, "go"), ""),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

/** Poll until `read` is truthy, or fail after `timeoutMs`. */
export async function until<T>(
  read: () => T | Promise<T>,
  timeoutMs = 10_000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** What the worker's xcresulttool reports: failing for a `fail` bundle. */
export async function fakeXcresult(_tool: string, args: readonly string[]): Promise<unknown> {
  const { existsSync } = await import("node:fs");
  const bundle = args[args.indexOf("--path") + 1]!;
  const now = Date.now() / 1000;
  if (args[1] !== "build-results") return null;
  if (!existsSync(join(bundle, "failed"))) {
    return { status: "succeeded", startTime: now - 1, endTime: now, errorCount: 0, warningCount: 0 };
  }
  return {
    status: "failed",
    startTime: now - 1,
    endTime: now,
    errorCount: 1,
    warningCount: 0,
    analyzerCount: 0,
    errors: [
      {
        issueType: "Swift Compiler Error",
        message: "cannot find 'frobnicate' in scope",
        // 0-based, as Xcode writes it: line 41 to a person.
        sourceURL: "file:///w/App/Sources/App.swift#StartingLineNumber=40",
      },
    ],
  };
}
