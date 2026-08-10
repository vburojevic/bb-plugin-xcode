/**
 * Calls that must never crash the bb server.
 *
 * The plugin API handle is invalidated on reload: touching it afterwards
 * throws PluginContextStaleError. Most of this plugin's work outlives its own
 * instance — the stream tail of a wrapped build, the continuation that folds
 * its exit, a sweep already in flight — so those calls land on a handle that
 * may have gone stale mid-flight. From a detached continuation such a throw
 * becomes an unhandled rejection, which Node raises as an uncaughtException,
 * which kills the whole bb server rather than just this plugin.
 *
 * Measured, not theoretical: `server.ts:702` (a stream-tail `publish`) took
 * the server down on 2026-08-10.
 *
 * The rule this module encodes: any plugin-handle call reachable from work
 * that can outlive the instance goes through `safely`. It is deliberately
 * boring — check the flag, swallow the race.
 */

/**
 * Wrap a side-effecting call so it becomes a no-op once disposed, and can
 * never throw even if disposal races the check.
 *
 * The returned function swallows every error, which is correct here and only
 * here: the sole caller category is "tell the UI/log about something", and by
 * definition the instance being torn down has no one left to tell.
 */
export function safely<TArgs extends readonly unknown[]>(
  isDisposed: () => boolean,
  call: (...args: TArgs) => void,
): (...args: TArgs) => void {
  return (...args: TArgs): void => {
    if (isDisposed()) return;
    try {
      call(...args);
    } catch {
      // Disposed between the check and the call, or the host handle went
      // stale under us. Either way the fresh instance owns this surface now.
    }
  };
}

/**
 * Run detached async work whose rejection must never reach the process.
 *
 * `void promise` is not enough: an async continuation that throws — including
 * one throwing from inside its own `catch`, which is exactly what a stale
 * `bb.log` call does — produces an unhandled rejection.
 */
export function detach(
  work: () => Promise<unknown>,
  onError?: (error: unknown) => void,
): void {
  void (async () => {
    try {
      await work();
    } catch (error: unknown) {
      try {
        onError?.(error);
      } catch {
        // The error reporter itself failed; there is nothing above us that
        // can be told, and throwing here would defeat the whole point.
      }
    }
  })();
}
