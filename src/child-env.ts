/**
 * Minimal environment for children that execute project code or native
 * dependencies. The bb server commonly holds provider, plugin, and tunnel
 * credentials; inheriting all of `process.env` would hand every build phase
 * and third-party child those credentials.
 */
const SAFE_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "DEVELOPER_DIR",
  "ELECTRON_RUN_AS_NODE",
]);

export function curatedChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SAFE_KEYS.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  env.PATH ??= "/usr/bin:/bin:/usr/sbin:/sbin";
  return env;
}
