/**
 * Staleness discipline.
 *
 * A `bb` handle captured before a reload throws `PluginContextStaleError` on
 * use, and from a detached continuation Node raises that as an
 * `uncaughtException` that takes down the whole bb server — not just this
 * plugin. Every `bb.*` call that can outlive the instance goes through
 * `safely`, and every fire-and-forget goes through `detach`.
 *
 * `void promise` is not enough: it silences the lint, not the rejection.
 */

/** True once the host has disposed the registration set this closure belongs to. */
export type IsDisposed = () => boolean;

/**
 * A `PluginContextStaleError` by name, so no runtime import is needed and a
 * renamed export upstream cannot make this stop matching.
 */
export function isStaleError(error: unknown): boolean {
  return error instanceof Error && error.name === "PluginContextStaleError";
}

/**
 * Run `fn` unless the instance is already disposed, swallowing a stale throw.
 *
 * Returns `undefined` when it did not run or threw — callers that care about
 * the difference should not be using this.
 */
export function safely<T>(isDisposed: IsDisposed, fn: () => T): T | undefined {
  if (isDisposed()) return undefined;
  try {
    return fn();
  } catch (error) {
    if (isStaleError(error)) return undefined;
    throw error;
  }
}

/**
 * Fire-and-forget async work with a terminal error handler that can itself
 * never throw.
 *
 * `onError` is typically `bb.log.error`, which throws when the handle is
 * stale — so the reporting call is wrapped too. This is the exact failure mode
 * that kills the server: a stale error observed inside its own catch.
 */
export function detach(work: () => Promise<unknown>, onError: (error: unknown) => void): void {
  let promise: Promise<unknown>;
  try {
    promise = work();
  } catch (error) {
    report(onError, error);
    return;
  }
  promise.then(undefined, (error: unknown) => report(onError, error));
}

function report(onError: (error: unknown) => void, error: unknown): void {
  if (isStaleError(error)) return;
  try {
    onError(error);
  } catch {
    // The reporter is stale or broken. There is nowhere left to say so, and
    // rethrowing here is the crash we are preventing.
  }
}

/**
 * Wrap a callback the runtime will invoke on its own schedule — a `setTimeout`
 * body, a child-process `exit`/`error` handler, an HTTP server `error`, a
 * WebSocket `close` — so a stale touch inside it cannot escape.
 *
 * These need their own guard rather than relying on a disposed flag, because
 * that flag only flips after a stale error has been *observed*, and the first
 * stale touch inside a timer is the fatal one.
 */
export function guarded<A extends unknown[]>(
  fn: (...args: A) => void,
  onError: (error: unknown) => void,
): (...args: A) => void {
  return (...args: A) => {
    try {
      fn(...args);
    } catch (error) {
      report(onError, error);
    }
  };
}

/** `guarded` for an async callback: rejections are routed the same way. */
export function guardedAsync<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>,
  onError: (error: unknown) => void,
): (...args: A) => void {
  return (...args: A) => {
    detach(() => fn(...args), onError);
  };
}

/** Reject after `ms`, with a message naming what timed out. */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Coalesce bursty calls onto a trailing edge with a floor between runs.
 *
 * Realtime publishes go through one of these with a 300ms floor: the frontend
 * refetches by RPC on any signal, so publishing twice in the same tick buys
 * nothing and costs every connected client a round trip.
 */
export function coalesce(floorMs: number, run: () => void): { schedule(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, floorMs);
      timer.unref?.();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
