import { TARGETS } from '../config.js'
import type { Targets } from '../config.js'
import type { NutritionDay, Signal } from './types.js'

/**
 * Protein adherence over a window of COMPLETE days.
 *
 * Reports hit-rate alongside the average, deliberately. Three good days and four
 * missed averages out to something that looks like a mild shortfall, when it is
 * actually four days of muscle loss risk on a GLP-1 cut. The average alone hides
 * the shape.
 *
 * Callers must exclude today: it is a Partial Day and its intake is whatever has
 * been logged so far.
 */
export function proteinAdherence(days: NutritionDay[], targets: Targets = TARGETS): Signal {
  const target = targets.proteinG
  const base = { id: 'protein', title: 'Protein' } as const
  const logged = days.filter((d) => d.proteinG !== null) as Array<NutritionDay & { proteinG: number }>

  if (logged.length === 0) {
    return {
      ...base,
      status: 'unknown',
      headline: `No protein logged in the last ${days.length} days`,
      // An unlogged day is unlogged, never zero. Saying "0g average" here would
      // be the same mistake as treating a gap as a fast.
      detail: 'Nothing to judge — this is a logging gap, not a shortfall.',
    }
  }

  const hits = logged.filter((d) => d.proteinG >= target).length
  const avg = Math.round(logged.reduce((a, d) => a + d.proteinG, 0) / logged.length)
  const hitRate = hits / logged.length

  // A shortfall on a GLP-1 cut is a logistics problem (wider window, shakes),
  // never a reason to lower the target -- so the thresholds are unforgiving.
  const status = hitRate >= 0.8 ? 'ok' : hitRate >= 0.5 ? 'watch' : 'act'

  return {
    ...base,
    status,
    headline: `${hits}/${logged.length} days hit ${target}g — average ${avg}g`,
    detail:
      logged.length < days.length
        ? `${days.length - logged.length} of the last ${days.length} days weren't logged, so this covers ${logged.length}.`
        : undefined,
  }
}

/**
 * How much of the window was logged at all.
 *
 * Separate from adherence on purpose: "you missed protein" and "you didn't log"
 * are different problems with different fixes, and collapsing them tells you to
 * eat more chicken when the actual fix is opening an app.
 */
export function loggingGaps(days: NutritionDay[]): Signal {
  const base = { id: 'logging', title: 'Logging' } as const
  const missing = days.filter((d) => d.calories === null && d.proteinG === null)
  const rate = days.length === 0 ? 0 : missing.length / days.length

  if (missing.length === 0) {
    return { ...base, status: 'ok', headline: `All ${days.length} days logged` }
  }
  return {
    ...base,
    status: rate > 0.4 ? 'act' : 'watch',
    headline: `${missing.length} of ${days.length} days unlogged`,
    detail: `Unlogged: ${missing.map((d) => d.observedOn).join(', ')}. Unlogged is not zero — these are excluded from averages, not counted as fasts.`,
  }
}
