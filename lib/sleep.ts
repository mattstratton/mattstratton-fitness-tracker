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
