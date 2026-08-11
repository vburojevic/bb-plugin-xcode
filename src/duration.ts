/**
 * How long something took, in whole seconds.
 *
 * One implementation, shared by the activity row, the history panel and the
 * CLI. There used to be two, and they had already drifted: the CLI had no
 * hours branch and rounded the seconds component while the frontend floored
 * it, so the same run could read `61m 00s` in one place and `1h 01m` in the
 * other.
 *
 * The rules:
 *
 *  - never milliseconds. `4400ms` is not a duration anyone reasons about, and
 *    `0ms` for a toolchain lookup told the reader nothing;
 *  - never a decimal. `4.4s` implies a precision `ps` sampling cannot deliver
 *    — the probe sees a process on a two-second tick, so the tenth was always
 *    invented;
 *  - round UP, so anything that happened at all reads as at least `1s` rather
 *    than vanishing into `0s`;
 *  - roll up into larger units as they fill, and pad the minor component so a
 *    column of durations stays aligned under `tabular-nums`.
 *
 * Rounding up before the rollover is what keeps `59.6s` from rendering as
 * `60s`: it becomes 60 whole seconds, which is one minute and zero seconds.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }

  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${pad(totalSeconds % 60)}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${pad(totalMinutes % 60)}m`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
