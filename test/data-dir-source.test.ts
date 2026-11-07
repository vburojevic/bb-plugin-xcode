/**
 * The plugin's files live in the bb data folder that runs it.
 *
 * bb hands every plugin a database at `<bb data dir>/plugins/<id>/data.db`,
 * and the folder around it is the plugin's own. The build tracker used to
 * guess that folder as `~/.bb/plugins/<id>` instead, so a dev or test bb, or
 * one started with `BB_DATA_DIR`, wrote its result bundles and installed its
 * shim into the main bb's folder. bb's SDK documents exactly this guess as the
 * mistake to avoid. Both halves now derive the folder from the database
 * handle (`dataDirOf`), and this keeps a guess from coming back.
 */

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if ([".ts", ".tsx", ".mjs"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const PRODUCTION_FILES = [
  ...sourceFiles(join(ROOT, "src")),
  join(ROOT, "server.ts"),
  join(ROOT, "sim-host.mjs"),
  join(ROOT, "sim-host-stream.mjs"),
];

describe("the plugin data folder", () => {
  it("is never derived from the home directory", () => {
    // A `".bb"` path segment next to the home directory is the guess. Comments
    // that mention `~/.bb` (for example bb's own worktree layout) are fine.
    const guess = /homedir\(\)[^;\n]*["']\.bb["']/;
    const offenders = PRODUCTION_FILES.filter((file) => guess.test(readFileSync(file, "utf8"))).map(
      (file) => relative(ROOT, file),
    );
    expect(offenders).toEqual([]);
  });
});
