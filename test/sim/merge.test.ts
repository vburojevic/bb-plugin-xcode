/**
 * The seams between the two halves of this plugin.
 *
 * Every assertion here stands for a way the merge landed the whole plugin in
 * `error` at install time, where the failure is one line in `bb plugin list`
 * and nothing at all loads — not the tracker, not the simulators. They are
 * cheap to assert and expensive to rediscover.
 */
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "../../src/store.js";
import { MIGRATIONS as SIMULATOR_MIGRATIONS } from "../../src/sim/store.js";
import { SETTINGS_DESCRIPTORS as SIMULATOR_SETTINGS } from "../../src/sim/settings.js";
import { CLI_COMMANDS } from "../../src/cli.js";
import { CLI_COMMANDS as SIM_VERBS } from "../../src/sim/cli.js";
import { rpcContract } from "../../src/contract.js";
import { rpcContract as simulatorContract } from "../../src/sim/contract.js";

/** bb's own validator, reproduced from the registration error message. */
const CLI_NAME = /^[a-z0-9-]+$/;
const RPC_NAME = /^[a-zA-Z0-9_-]+$/;

describe("the two halves share one plugin", () => {
  it("appends the simulator migrations rather than interleaving them", () => {
    // `bb.storage.migrate` applies by index, so the simulator statements must
    // sit at the end and stay there. If this ever fails, an installed database
    // is being re-indexed underneath itself.
    const tail = MIGRATIONS.slice(MIGRATIONS.length - SIMULATOR_MIGRATIONS.length);
    expect([...tail]).toEqual([...SIMULATOR_MIGRATIONS]);
  });

  it("keeps every migration to a single statement", () => {
    // better-sqlite3's `prepare` throws `RangeError: The supplied SQL string
    // contains more than one statement`, which is how a table and its indexes
    // packed into one template literal took out the whole tracker suite.
    for (const statement of MIGRATIONS) {
      const parts = statement.split(";").filter((part) => part.trim() !== "");
      expect(parts.length, statement.slice(0, 60)).toBe(1);
    }
  });

  it("has no settings key in both halves", () => {
    // `bb.settings.define` is one call, and the halves are spread into it. A
    // shared key would silently give one half the other's value.
    const tracker = new Set([
      "scanIntervalSeconds",
      "retentionDays",
      "bundleRetentionDays",
      "bundleBudgetGb",
      "scanProjects",
      "extraRoots",
    ]);
    for (const key of Object.keys(SIMULATOR_SETTINGS)) {
      expect(tracker.has(key), key).toBe(false);
    }
  });

  it("has no RPC method in both halves, and none with an illegal name", () => {
    // A duplicate method name throws at registration and the plugin never loads.
    const tracker = new Set(Object.keys(rpcContract));
    for (const name of Object.keys(simulatorContract)) {
      expect(tracker.has(name), name).toBe(false);
      expect(RPC_NAME.test(name), name).toBe(true);
    }
  });

  it("gives every CLI command a name bb will accept", () => {
    // `sim devices` is not a legal command name — a space fails the validator
    // and lands the plugin in `error`, which is why the simulator verbs are
    // mounted behind one `sim` entry instead of registered individually.
    for (const command of CLI_COMMANDS) {
      expect(CLI_NAME.test(command.name), command.name).toBe(true);
    }
    expect(CLI_NAME.test("sim")).toBe(true);
    for (const verb of SIM_VERBS) {
      expect(CLI_NAME.test(verb.name), verb.name).toBe(true);
    }
  });

  it("keeps the simulator verbs discoverable from the tracker's own hint", () => {
    // The hint is built from CLI_COMMANDS, which cannot contain `sim` because
    // `server.ts` dispatches it first. Omitting it is how a user concludes the
    // simulator half does not exist.
    const names = CLI_COMMANDS.map((command) => command.name);
    expect(names).not.toContain("sim");
  });
});
