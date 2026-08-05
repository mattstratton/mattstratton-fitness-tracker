import type { ActivityDay, ExerciseDay, Signal } from './types.js'

const RECENT_DAYS = 7
const MIN_RECENT_DAYS = 4
const MIN_BASELINE_DAYS = 20
const SD_THRESHOLD = 1.5

const EXERCISE_WINDOW_DAYS = 7
const MIN_EXERCISE_DAYS = 4
const HIGH_ADHERENCE = 0.8
const LOW_ADHERENCE = 0.5

function meanSd(values: number[]): { mean: number; sd: number } {
  const mean = values.reduce((a, v) => a + v, 0) / values.length
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length
  return { mean, sd: Math.sqrt(variance) }
}

/**
 * Recent activity against the person's own baseline. Steps is the one metric
 * in this app with genuinely complete coverage (metric_catalog calls it "the
 * canary for the whole pipeline"), which is what makes a real trend possible
 * here, unlike sleep.
 *
 * Baseline excludes the recent window, same reason overreaching() excludes
 * it for RHR/HRV: a genuine multi-day drop shouldn't get to drag down the
 * number it's being judged against.
 *
 * Unlike overreaching(), this compares the RECENT MEAN to the threshold, not
 * every individual recent day -- steps swings hard day to day by design (a
 * rest day and a long-walk day are both normal), so requiring every day to
 * cross a personal-baseline line would almost never fire. An averaged week is
 * the right grain for "is activity actually down," a single low day isn't.
 *
 * Never `act`: there's no step goal set anywhere in this app and no clear
 * intervention tied to a quiet week the way there is for a stalled lift or a
 * broken pipeline. This is worth knowing, not a decision point.
 */
export function activityTrend(days: ActivityDay[]): Signal {
  const base = { id: 'activity', title: 'Activity' } as const
  const sorted = [...days].sort((a, b) => a.observedOn.localeCompare(b.observedOn))
  const recent = sorted.slice(-RECENT_DAYS)
  const baseline = sorted.slice(0, -RECENT_DAYS)

  if (recent.length < MIN_RECENT_DAYS) {
    return { ...base, status: 'unknown', headline: 'Not enough recent step data' }
  }

  if (baseline.length < MIN_BASELINE_DAYS) {
    return {
      ...base,
      status: 'unknown',
      headline: 'Not enough step history for a baseline',
      detail: `Needs ${MIN_BASELINE_DAYS}+ baseline days.`,
    }
  }

  const { mean, sd } = meanSd(baseline.map((d) => d.steps))
  // A zero-variance baseline is broken data, not a calm one -- real activity
  // always wobbles day to day.
  if (sd === 0) {
    return { ...base, status: 'unknown', headline: 'Not enough step history for a baseline' }
  }

  const recentMean = recent.reduce((a, d) => a + d.steps, 0) / recent.length

  if (recentMean < mean - SD_THRESHOLD * sd) {
    return {
      ...base,
      status: 'watch',
      headline: 'Activity down this week',
      detail: `${Math.round(recentMean)} steps/day vs a ${Math.round(mean)} baseline (typically ±${Math.round(sd)}).`,
    }
  }

  return { ...base, status: 'ok', headline: `${Math.round(recentMean)} steps/day, near baseline` }
}

/**
 * Exercise-minutes adherence against a real, user-set daily target (Apple's
 * own Exercise ring) -- unlike steps, which has no established goal anywhere
 * in this app, exercise minutes is graded like protein/calories: hit-rate
 * against a number, not a personal-baseline comparison. Can genuinely reach
 * `act`, unlike activityTrend, because there's a real goal to fall short of.
 *
 * `days` reflects only days with real automatic data -- a gap is an absent
 * row, never a zero -- so this can be sparser than windowDays if the Watch
 * wasn't worn, though exercise_minutes has near-100% historical coverage.
 */
export function exerciseAdherence(
  days: ExerciseDay[], targetMinutes: number, windowDays = EXERCISE_WINDOW_DAYS,
): Signal {
  const base = { id: 'exercise', title: 'Exercise minutes' } as const

  if (days.length < MIN_EXERCISE_DAYS) {
    return { ...base, status: 'unknown', headline: `Not enough exercise data in the last ${windowDays} days` }
  }

  const hits = days.filter((d) => d.minutes >= targetMinutes).length
  const avg = Math.round(days.reduce((a, d) => a + d.minutes, 0) / days.length)
  const hitRate = hits / days.length
  const status = hitRate >= HIGH_ADHERENCE ? 'ok' : hitRate >= LOW_ADHERENCE ? 'watch' : 'act'

  return {
    ...base,
    status,
    headline: `${hits}/${days.length} days hit ${targetMinutes} min — average ${avg} min`,
    detail:
      days.length < windowDays
        ? `${windowDays - days.length} of the last ${windowDays} days had no exercise-minutes data.`
        : undefined,
  }
}
