/**
 * Is this thread's checkout on the machine that runs bb?
 *
 * bb supports a Linux server with enrolled Macs, and a thread's environment can
 * live on a host that is not the server's own. Stills builds with `xcodebuild`
 * on the server's filesystem, so a checkout on another host is a real refusal
 * with a real sentence rather than a mysterious "no such file".
 *
 * The `Host` DTO carries no "this is the server's own host" flag, so it is
 * derived once and cached: write a nonce file under the plugin's own data
 * directory with `node:fs`, then ask each host whether that exact absolute path
 * exists. The host that says yes is the server's.
 *
 * This is the same multi-machine rule the CLI's `--out` obeys, applied to the
 * thing that actually builds.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface HostSummary {
  id: string;
  name: string;
}

export interface HostcheckDeps {
  /** `<dataDir>/plugins/xcode-simulators` — server-local by construction. */
  pluginDataDir: string;
  listHosts: () => Promise<HostSummary[]>;
  pathsExist: (hostId: string, paths: string[]) => Promise<Record<string, boolean>>;
  kvGet: (key: string) => Promise<string | null>;
  kvSet: (key: string, value: string) => Promise<void>;
}

const KV_KEY = "serverHostId";

/**
 * The server's own host id, cached in kv across reloads.
 *
 * Returns `null` when it cannot be determined — which is a legitimate answer,
 * not an error. Every caller treats `null` as "do not claim the checkout is
 * elsewhere", because refusing a build on a guess is worse than attempting one.
 */
export async function resolveServerHostId(deps: HostcheckDeps): Promise<string | null> {
  const cached = await deps.kvGet(KV_KEY);
  if (cached !== null && cached !== "") return cached;

  const hosts = await deps.listHosts();
  if (hosts.length === 0) return null;
  // One host cannot be anything but the server's own.
  if (hosts.length === 1) {
    await deps.kvSet(KV_KEY, hosts[0]!.id);
    return hosts[0]!.id;
  }

  const noncePath = join(deps.pluginDataDir, `.host-probe-${randomBytes(8).toString("hex")}`);
  await mkdir(deps.pluginDataDir, { recursive: true });
  await writeFile(noncePath, "bb-plugin-xcode-simulators host probe\n", { mode: 0o600 });

  try {
    for (const host of hosts) {
      let existence: Record<string, boolean>;
      try {
        existence = await deps.pathsExist(host.id, [noncePath]);
      } catch {
        // A host that is offline cannot answer, and cannot be the one running
        // this process either. Keep looking.
        continue;
      }
      if (existence[noncePath] === true) {
        await deps.kvSet(KV_KEY, host.id);
        return host.id;
      }
    }
    return null;
  } finally {
    // Best effort: a leftover probe file is inert, and failing the check
    // because cleanup failed would be absurd.
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(noncePath);
    } catch {
      // Nothing to do.
    }
  }
}

export type CheckoutLocation =
  | { kind: "same-host" }
  | { kind: "other-host"; hostName: string }
  | { kind: "unknown" };

export function locateCheckout(
  serverHostId: string | null,
  environmentHostId: string | null,
  hosts: readonly HostSummary[],
): CheckoutLocation {
  if (serverHostId === null || environmentHostId === null) return { kind: "unknown" };
  if (serverHostId === environmentHostId) return { kind: "same-host" };
  const host = hosts.find((entry) => entry.id === environmentHostId);
  return { kind: "other-host", hostName: host?.name ?? "another machine" };
}

/** The sentence, so the doctor and the Stills tab say the same thing. */
export function describeCheckoutLocation(location: CheckoutLocation): string | null {
  switch (location.kind) {
    case "same-host":
    case "unknown":
      return null;
    case "other-host":
      return `This thread's checkout lives on ${location.hostName}, but Xcode Simulators builds on the machine running bb.`;
  }
}
