/**
 * Runtime stand-in for `@bb/plugin-sdk`'s two value exports.
 *
 * The plugin's `types/bb-plugin-sdk.d.ts` is a declaration file with no runtime
 * behind it — bb supplies the implementation in-process. Under vitest the two
 * values the plugin actually imports are trivially reproducible, so this stub
 * is a faithful stand-in rather than a mock: `defineRpcContract` really is
 * identity in the host, and the byte ceiling really is this number.
 */

/** The host's own value, from `@bb/plugin-sdk`. */
export const PLUGIN_CLI_OUTPUT_MAX_BYTES = 1_048_576;

export function defineRpcContract<T>(contract: T): T {
  return contract;
}

export type BbPluginApi = unknown;
export type JsonValue = unknown;
