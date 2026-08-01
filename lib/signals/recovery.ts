import type { RecoveryDay, Signal } from './types.js'

const RECENT_DAYS = 3
const MIN_BASELINE_DAYS = 20
const SD_THRESHOLD = 1.5

function meanSd(values: number[]): { mean: number; sd: number } {
  const mean = values.reduce((a, v) => a + v, 0) / values.length
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length
  return { mean, sd: Math.sqrt(variance) }
}

/**
 * Overreaching: resting heart rate up, or HRV down, against the person's own
 * baseline — sustained, not for one night.
 *
 * Both metrics are compared to a 60-day baseline that EXCLUDES the recent
 * window. Including it would let a genuine multi-day suppression drag the
 * baseline down to meet itself, which is precisely the case we want to catch.
 *
 * Requires all of the last three days to be adverse. A single bad night is a
 * bad night; three in a row on a deficit is a pattern.
 */
export function overreaching(days: RecoveryDay[]): Signal {
  const base = { id: 'recovery', title: 'Recovery' } as const
  // Oldest first, so "recent" is the tail.
  const sorted = [...days].sort((a, b) => a.observedOn.localeCompare(b.observedOn))
  const recent = sorted.slice(-RECENT_DAYS)
  const baseline = sorted.slice(0, -RECENT_DAYS)

  if (recent.length < RECENT_DAYS) {
    return { ...base, status: 'unknown', headline: 'Not enough recent recovery data' }
  }

  const flags: string[] = []
  let usable = false

  // RHR: adverse means HIGH.
  const rhrBase = baseline.map((d) => d.restingHr).filter((v): v is number => v !== null)
  const rhrRecent = recent.map((d) => d.restingHr).filter((v): v is number => v !== null)
  if (rhrBase.length >= MIN_BASELINE_DAYS && rhrRecent.length === RECENT_DAYS) {
    const { mean, sd } = meanSd(rhrBase)
    // A zero-variance baseline is not a calm baseline, it is broken data --
    // real physiology always wobbles. Marking it usable would let the signal
    // report "markers normal" when it cannot actually judge anything.
    if (sd > 0) usable = true
    if (sd > 0 && rhrRecent.every((v) => v > mean + SD_THRESHOLD * sd)) {
      flags.push(
        `resting HR ${Math.round(rhrRecent.reduce((a, v) => a + v, 0) / RECENT_DAYS)} vs a ${Math.round(mean)} baseline`,
      )
    }
  }

  // HRV: adverse means LOW.
  const hrvBase = baseline.map((d) => d.hrvMs).filter((v): v is number => v !== null)
  const hrvRecent = recent.map((d) => d.hrvMs).filter((v): v is number => v !== null)
  if (hrvBase.length >= MIN_BASELINE_DAYS && hrvRecent.length === RECENT_DAYS) {
    const { mean, sd } = meanSd(hrvBase)
    if (sd > 0) usable = true
    if (sd > 0 && hrvRecent.every((v) => v < mean - SD_THRESHOLD * sd)) {
      flags.push(
        `HRV ${Math.round(hrvRecent.reduce((a, v) => a + v, 0) / RECENT_DAYS)}ms vs a ${Math.round(mean)}ms baseline`,
      )
    }
  }

  if (!usable) {
    // Watch-wear is ~40%, so this is a common and honest outcome.
    return {
      ...base,
      status: 'unknown',
      headline: 'Not enough watch data for a baseline',
      detail: `Needs ${MIN_BASELINE_DAYS}+ baseline days and ${RECENT_DAYS} consecutive recent ones.`,
    }
  }

  if (flags.length === 0) {
    return { ...base, status: 'ok', headline: 'Recovery markers normal' }
  }

  return {
    ...base,
    // Both markers agreeing is a much stronger signal than either alone.
    status: flags.length > 1 ? 'act' : 'watch',
    headline: `${RECENT_DAYS} days of suppressed recovery`,
    detail: `${flags.join('; ')}. On a deficit this usually means back off volume or eat more, before it becomes a missed session.`,
  }
}
