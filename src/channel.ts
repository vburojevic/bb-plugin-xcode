/**
 * Realtime channel name.
 *
 * Deliberately its own module with zero imports: the frontend needs this value
 * at runtime, and importing it from `contract.ts` would drag that module's
 * runtime `@bb/plugin-sdk` + zod imports into the app bundle.
 */
export const XCODE_CHANNEL = "xcode:activity";
