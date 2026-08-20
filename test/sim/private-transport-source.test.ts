import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

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
  ...sourceFiles(join(ROOT, "app")),
  join(ROOT, "app.tsx"),
  join(ROOT, "server.ts"),
  join(ROOT, "sim-host.mjs"),
];

describe("the private-only transport source invariant", () => {
  it("contains no shared-port or standalone exposure implementation", () => {
    const forbidden = [
      "declareSharedPorts",
      "ensureSharedPortTunnel",
      "startViewer",
      "ExposureGuard",
      "ExposureDelivery",
      "exposeState",
      "exposeStart",
      "exposeClaim",
      "exposeStop",
    ];
    for (const path of PRODUCTION_FILES) {
      const source = readFileSync(path, "utf8");
      for (const token of forbidden) {
        expect(source, `${relative(ROOT, path)} contains ${token}`).not.toContain(token);
      }
    }
  });

  it("has one first-party listener and pins it to IPv4 loopback", () => {
    const listeners = PRODUCTION_FILES.filter((path) => readFileSync(path, "utf8").includes(".listen("));
    expect(listeners.map((path) => relative(ROOT, path))).toEqual(["sim-host.mjs"]);
    expect(readFileSync(join(ROOT, "sim-host.mjs"), "utf8")).toContain(
      'server.listen(port, "127.0.0.1"',
    );
  });
});
