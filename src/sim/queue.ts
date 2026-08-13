/**
 * The stills queue, keyed on the **device UDID** rather than on the project.
 *
 * The contended resource is the device. `stillsDevice` is one shared UDID by
 * design, so two projects rendering at once have different scope keys, both
 * pass a scope-keyed in-flight check, and both drive the same simulator —
 * interleaved installs, cross-contaminated exports, two runs that each look
 * valid. A stranger with forty repos and two agent queues hits that on day one.
 *
 * So: the mutex is the UDID; a second request for an *identical*
 * `(scopeKey, deviceKey)` joins the first rather than queueing behind it; a
 * different scope queues.
 *
 * Every job blocks on a process exit with an `AbortSignal` watchdog. There is
 * no polling of build state anywhere.
 */

export interface JobKey {
  udid: string;
  scopeKey: string;
  deviceKey: string;
}

export interface QueuedJob<T> {
  key: JobKey;
  run: (signal: AbortSignal) => Promise<T>;
}

interface Entry<T> {
  key: JobKey;
  run: (signal: AbortSignal) => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class DeviceQueue {
  /** One chain per device, plus the job currently on it. */
  private running = new Map<string, Entry<unknown>>();
  private waiting = new Map<string, Array<Entry<unknown>>>();
  private controller = new AbortController();

  /**
   * Enqueue, or join an identical job already in flight.
   *
   * Joining rather than queueing matters: a panel and an agent asking for the
   * same render in the same second should produce one build, and the second
   * caller should get the first one's answer rather than a second twelve-minute
   * wait for an identical result.
   */
  enqueue<T>(job: QueuedJob<T>): { promise: Promise<T>; joined: boolean; queued: number } {
    const current = this.running.get(job.key.udid) as Entry<T> | undefined;
    if (current !== undefined && sameWork(current.key, job.key)) {
      return { promise: current.promise, joined: true, queued: 0 };
    }
    const pending = (this.waiting.get(job.key.udid) ?? []) as Array<Entry<T>>;
    const alreadyQueued = pending.find((entry) => sameWork(entry.key, job.key));
    if (alreadyQueued !== undefined) {
      return { promise: alreadyQueued.promise, joined: true, queued: pending.length };
    }

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolveFn, rejectFn) => {
      resolve = resolveFn;
      reject = rejectFn;
    });
    const entry: Entry<T> = { key: job.key, run: job.run, promise, resolve, reject };

    if (current === undefined) {
      this.start(entry as Entry<unknown>);
      return { promise, joined: false, queued: 0 };
    }
    pending.push(entry);
    this.waiting.set(job.key.udid, pending as Array<Entry<unknown>>);
    return { promise, joined: false, queued: pending.length };
  }

  private start(entry: Entry<unknown>): void {
    this.running.set(entry.key.udid, entry);
    entry
      .run(this.controller.signal)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.running.delete(entry.key.udid);
        const pending = this.waiting.get(entry.key.udid) ?? [];
        const next = pending.shift();
        if (next === undefined) {
          this.waiting.delete(entry.key.udid);
          return;
        }
        this.waiting.set(entry.key.udid, pending);
        this.start(next);
      });
  }

  /** How many jobs are waiting on a device, for "queued behind another project". */
  depth(udid: string): number {
    return (this.waiting.get(udid) ?? []).length + (this.running.has(udid) ? 1 : 0);
  }

  isBusy(udid: string): boolean {
    return this.running.has(udid);
  }

  /**
   * Abort everything, for reload teardown.
   *
   * Waiting jobs are rejected rather than silently dropped: a caller awaiting a
   * run that will now never happen deserves to be told, and a reload is a
   * reason.
   */
  abortAll(reason = "Xcode Simulators reloaded while this was queued."): void {
    this.controller.abort();
    for (const pending of this.waiting.values()) {
      for (const entry of pending) entry.reject(new Error(reason));
    }
    this.waiting.clear();
    this.controller = new AbortController();
  }
}

function sameWork(a: JobKey, b: JobKey): boolean {
  return a.scopeKey === b.scopeKey && a.deviceKey === b.deviceKey;
}
