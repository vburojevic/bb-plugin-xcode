/**
 * What the bundle is allowed to contain.
 *
 * `bb plugin build` inlines every third-party dependency into
 * `dist/server.js`. serve-sim resolves its native addon from
 * `import.meta.url`-relative paths and `odiff-bin` resolves a
 * platform-specific optional dependency — both die if inlined. So the capture
 * host ships raw as `sim-host.mjs`, nothing the bundled server statically
 * imports may reach `serve-sim/middleware` except as `import type`, and this
 * is the test that says so before a release does.
 *
 * Skipped when `dist/` is absent, so `npm test` works on a clean checkout;
 * CI runs `npm run build` first.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../../dist/server.js", import.meta.url));
const built = existsSync(DIST);

describe.skipIf(!built)("dist/server.js", () => {
  const bundle = built ? readFileSync(DIST, "utf8") : "";

  it("contains no serve-sim code, only the specifier strings we wrote", () => {
    // Markers that would only appear if the middleware had been inlined.
    for (const marker of [
      "simMiddleware",
      "DeviceSession",
      "previewConfigForState",
      "readServeSimStates",
      "startDeviceInProcess",
      "execToken",
    ]) {
      expect(bundle, marker).not.toContain(marker);
    }

    // The literal specifiers are expected: `preflight.ts` resolves them and
    // `sim-host.mjs` is spawned by path.
    const hits = [...bundle.matchAll(/serve-sim[^"',) ]*/g)].map((match) => match[0]);
    expect(new Set(hits)).toEqual(
      new Set(["serve-sim", "serve-sim/middleware", "serve-sim/dist/native/", "serve-sim-native.node"]),
    );
  });

  it("resolves odiff by specifier rather than inlining a platform binary", () => {
    expect(bundle).toContain("odiff-bin/bin/odiff");
    expect(bundle).not.toContain("@odiff/darwin");
  });

  it("ships sim-host.mjs raw beside the bundle", () => {
    // V1: a path install loads `server.ts` at the plugin root and a git install
    // prefers `dist/server.js`; both resolve the same file.
    expect(existsSync(fileURLToPath(new URL("../../sim-host.mjs", import.meta.url)))).toBe(true);
  });
});

describe("app.css", () => {
  const CSS = fileURLToPath(new URL("../../app.css", import.meta.url));
  const authored = readFileSync(CSS, "utf8");

  it("is where every comma-bearing value lives", () => {
    // The plugin Tailwind build silently drops arbitrary values containing
    // commas — `color-mix(in oklab,a,b)` written as `[...]` compiles to
    // nothing, with no error. Authored CSS has no such limit.
    expect(authored).toContain("color-mix(in oklab");
  });

  it("keeps its comma-bearing values out of Tailwind arbitrary values", () => {
    // Scanning whole files would flag ordinary JS — `[onStart, onRefresh]` is
    // a dependency array, not a utility. Only class strings can be dropped by
    // the Tailwind pass, so only class strings are checked.
    for (const source of componentSources()) {
      const text = readFileSync(source, "utf8");
      const offenders: string[] = [];
      for (const match of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
        const classes = match[1] ?? match[2] ?? match[3] ?? "";
        for (const arbitrary of classes.matchAll(/\[[^\]]*\]/g)) {
          if (arbitrary[0].includes(",")) offenders.push(arbitrary[0]);
        }
      }
      expect(offenders, source).toEqual([]);
    }
  });
});

function componentSources(): string[] {
  const roots = ["app.tsx", "app", "components"];
  const out: string[] = [];
  const walk = (relative: string): void => {
    const path = fileURLToPath(new URL(`../${relative}`, import.meta.url));
    if (!existsSync(path)) return;
    const stats = statSync(path);
    if (stats.isFile()) {
      if (path.endsWith(".tsx")) out.push(path);
      return;
    }
    for (const entry of readdirSync(path)) walk(`${relative}/${entry}`);
  };
  for (const root of roots) walk(root);
  return out;
}

describe("the compiled stylesheet", () => {
  const DIST_CSS = fileURLToPath(new URL("../../dist/app.css", import.meta.url));

  it.skipIf(!existsSync(DIST_CSS))("keeps the authored CSS outside the @scope block", () => {
    // Compiled plugin CSS is `@scope`-wrapped and matches DESCENDANTS only,
    // never the scope root itself — so a tone class on a root element would
    // compile, ship, and do nothing. Imported CSS is preserved unscoped, and
    // this asserts it stayed that way.
    const css = readFileSync(DIST_CSS, "utf8");
    const scopeAt = css.indexOf("@scope");
    const toneAt = css.indexOf(".bbxs-tone");
    expect(toneAt).toBeGreaterThan(-1);
    if (scopeAt === -1) return;
    // The authored block is appended after the scoped Tailwind output, so the
    // last `}` before it closes the scope.
    const between = css.slice(scopeAt, toneAt);
    const opens = (between.match(/\{/g) ?? []).length;
    const closes = (between.match(/\}/g) ?? []).length;
    expect(closes).toBeGreaterThanOrEqual(opens);
  });
});
