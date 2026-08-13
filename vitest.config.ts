import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * The suite is pure Node: parsers, the reconciler, and an in-memory SQLite.
 * Nothing here needs a DOM, so the default node environment is the fast and
 * honest choice — a jsdom default would only hide that the frontend is
 * currently covered by type checking rather than by tests.
 */
export default defineConfig({
  // The Simulators half's suite drives the plugin factory itself, so it needs
  // the two SDK entry points resolved to stubs — there is no `@bb/plugin-sdk`
  // package on disk, only the declarations in `types/`.
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "@bb/plugin-sdk": fileURLToPath(new URL("./test/sim/stubs/plugin-sdk.ts", import.meta.url)),
      "@bb/plugin-sdk/app": fileURLToPath(
        new URL("./test/sim/stubs/plugin-sdk-app.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    environmentMatchGlobs: [["test/**/*.dom.test.tsx", "jsdom"]],
    // `abandoned.test.ts` drives a real Collector over a temp directory tree,
    // which is slower than the parser tests but still well inside this bound.
    testTimeout: 20_000,
  },
});
