/**
 * The capture host ships raw, unbundled, as `sim-host.mjs`.
 *
 * serve-sim resolves its native addon from `import.meta.url`-relative paths, so
 * bundling that file breaks it — see `test/bundle.test.ts`. It stays JavaScript,
 * and this is the declaration that lets the security suite import its pure
 * predicates on any platform.
 */
declare module "*/sim-host.mjs" {
  export const SECRET_HEADER: string;
  export const MAX_CONTROL_BODY_BYTES: number;
  export const MAX_SCRUBBED_JSON_BYTES: number;
  export function createFilteredServer(
    middleware: unknown,
    secret: string,
    onError?: (error: unknown) => void,
    streamToken?: string | null,
  ): import("node:http").Server;
  export function isDenied(path: string): boolean;
  export function isAllowed(method: string, path: string): boolean;
  export function isWebSocketAllowed(path: string): boolean;
  export function isStreamRoute(path: string): boolean;
  export function authorize(args: {
    path: string;
    header: unknown;
    query: unknown;
    secret: string;
    streamToken: string | null;
  }): boolean;
  export function scrubExecToken(text: string): string;
  export function secretMatches(provided: unknown, expected: string): boolean;
}
