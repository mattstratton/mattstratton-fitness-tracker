// Pure sleep-display logic: how to describe a night, never how to judge one.
//
// Mirrors lib/signals/ and lib/charting.ts -- no SQL, no fetch, no clock
// reads. Sleep has ~7% coverage (CLAUDE.md) and is deliberately unmonitored --
// there is no Signal here and never should be. Callers decide what to show;
// this only formats.

export const RECENT_SLEEP_DAYS = 3

/** Whether a night is recent enough to show on the glance page as if current.
 *  Mirrors overreaching()'s own RECENT_DAYS=3 for resting HR/HRV. */
export function isSleepRecent(ageDays: number, maxAgeDays = RECENT_SLEEP_DAYS): boolean {
  return ageDays <= maxAgeDays
}

/** loadLatestSleep excludes today, so ageDays is always >= 1 here. */
export function describeSleepAge(ageDays: number): string {
  return ageDays === 1 ? 'last night' : `${ageDays} nights ago`
}

export function formatSleepDuration(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/** Stage breakdown as a joinable list, e.g. "core 5h 3m, deep 34m, REM 1h
 *  26m, awake 12m" -- omits any stage HAE didn't report rather than showing
 *  a fabricated zero. Null when none of the four stages are present. */
export function describeSleepStages(
  sleep: { coreMin: number | null; deepMin: number | null; remMin: number | null; awakeMin: number | null },
): string | null {
  const stages = [
    sleep.coreMin !== null ? `core ${formatSleepDuration(sleep.coreMin)}` : null,
    sleep.deepMin !== null ? `deep ${formatSleepDuration(sleep.deepMin)}` : null,
    sleep.remMin !== null ? `REM ${formatSleepDuration(sleep.remMin)}` : null,
    sleep.awakeMin !== null ? `awake ${formatSleepDuration(sleep.awakeMin)}` : null,
  ].filter((s): s is string => s !== null)
  return stages.length > 0 ? stages.join(', ') : null
}
