/** One generation-wide interlock: no expiry can free a live actor. */
const lanes = new Set<string>();
let legacyRuns = 0;
const idleProbes=new Set<()=>boolean>();
export function registerLegacyNativeIdleProbe(probe:()=>boolean):()=>void {idleProbes.add(probe);return ()=>{idleProbes.delete(probe);};}
export function assertLegacyNativeIdle():void {
  if(legacyRuns || [...idleProbes].some(probe=>!probe()))throw new Error('Legacy native execution or live session is still active. Close it before opening Atlas lanes.');
}
export function assertLegacyNativeAllowed(): void {
  if (lanes.size) throw new Error('Atlas owns a fenced native lane. Use its exact-device resource route.');
}
export function enterNativeLane(deviceId: string): void {
  deviceId=deviceId.toUpperCase();
  assertLegacyNativeIdle();
  if (lanes.has(deviceId)) throw new Error('Native device or legacy executor is busy.');
  lanes.add(deviceId);
}
export function leaveNativeLane(deviceId: string): void { lanes.delete(deviceId.toUpperCase()); }
export function enterLegacyNative(): () => void {
  assertLegacyNativeAllowed();
  legacyRuns++;
  let released = false;
  return () => {if (!released) {released = true; legacyRuns--;}};
}

/** Hold the legacy interlock for the complete promise, including its error path. */
export function interlockHandlers<T extends object>(handlers: T): T {
  return new Proxy(handlers, {get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      const release = enterLegacyNative();
      try { return await value.apply(target, args); } finally { release(); }
    };
  }});
}
