import type { Targets } from '../config.js'
import type { EnergyRealityRow, Signal, WeightTrendRow } from './types.js'

/** Below this, avg_net_kcal averages logged days against a trend over all days. */
const MIN_COVERAGE_PCT = 60

/**
 * Weight trend, and whether the short and long windows agree.
 *
 * A 14-day slope that disagrees in SIGN with the 90-day one is the interesting
 * case: it's either the start of a real change or a fortnight of water, and
 * which one it is only becomes clear later. Worth surfacing, not worth acting on.
 */
export function weightTrend(rows: WeightTrendRow[], targets: Targets): Signal {
  const base = { id: 'weight', title: 'Weight' } as const
  const by = (d: number) => rows.find((r) => r.days === d)
  const short = by(14)
  const long = by(90)

  if (!short?.lbsPerWeek) {
    return { ...base, status: 'unknown', headline: 'Not enough weigh-ins to fit a trend' }
  }

  const rate = short.lbsPerWeek
  const dir = rate < 0 ? 'down' : 'up'
  const headline = `${Math.abs(rate).toFixed(2)} lb/week ${dir} over 14 days`

  if (long?.lbsPerWeek && Math.sign(long.lbsPerWeek) !== Math.sign(rate)) {
    return {
      ...base,
      status: 'watch',
      headline,
      detail: `The 90-day trend goes the other way (${long.lbsPerWeek.toFixed(2)} lb/week). Two weeks is short enough to be water; wait before reading anything into it.`,
    }
  }

  // Direction comes from the phase, so one rule covers cut, maintain and bulk.
  // Moving the WRONG WAY is always worth flagging; moving the right way too
  // fast costs lean mass on a cut and adds fat on a bulk.
  const wrongWay = targets.expected !== 0 && Math.sign(rate) !== Math.sign(targets.expected)
  const tooFast = Math.abs(rate) > targets.concerning
  const status = wrongWay || tooFast ? 'watch' : 'ok'

  let detail = `${short.weighIns} weigh-ins in the window. Target is about ${targets.expected.toFixed(1)} lb/week on a ${targets.phase}.`
  if (wrongWay) {
    detail = `Going the wrong way for a ${targets.phase} (target ${targets.expected.toFixed(1)} lb/week).`
  } else if (tooFast) {
    detail =
      targets.phase === 'cut'
        ? `Faster than ${targets.concerning} lb/week tends to come partly out of lean mass. Check protein is holding.`
        : `Faster than ${targets.concerning} lb/week on a ${targets.phase} is more than the useful rate.`
  }
  return { ...base, status, headline, detail }
}

/**
 * Whether the calorie arithmetic matches the scale.
 *
 * energy_balance overstates the deficit by roughly 2.6x, because Apple's basal
 * figure is a formula estimate and watch active energy runs generous — both are
 * real numbers whose *difference* is not a measurement. This signal exists so
 * that gap is visible rather than quietly believed.
 */
export function deficitReality(rows: EnergyRealityRow[], targets: Targets): Signal {
  // On a bulk this is a surplus, not a deficit; the arithmetic is identical and
  // only the word changes.
  const word = targets.expected > 0 ? 'Surplus' : 'Deficit'
  const base = { id: 'deficit', title: word } as const

  // Prefer the widest window that is actually well covered. A 90-day row at 21%
  // coverage produces a confident nonsense number.
  const usable = rows
    .filter((r) => r.coveragePct >= MIN_COVERAGE_PCT && r.actualLbsPerWeek)
    .sort((a, b) => b.windowDays - a.windowDays)[0]

  if (!usable) {
    const best = rows.sort((a, b) => b.coveragePct - a.coveragePct)[0]
    return {
      ...base,
      status: 'unknown',
      headline: `Not enough logged days to judge the ${word.toLowerCase()}`,
      detail: best
        ? `Best coverage is ${best.coveragePct}% over ${best.windowDays} days; ${MIN_COVERAGE_PCT}% is the bar. Comparing an average over logged days against a trend over all days is meaningless below that.`
        : undefined,
    }
  }

  const actual = usable.actualLbsPerWeek!
  const impliedByScale = Math.round((actual * 3500) / 7)
  const factor = usable.overstatementFactor

  return {
    ...base,
    status: 'ok',
    // Lead with the scale. It is the measurement; the calorie maths is an estimate.
    headline: `About ${Math.abs(impliedByScale)} kcal/day, from the scale`,
    detail:
      factor && factor > 1.3
        ? `Apple's numbers say ${Math.abs(Math.round(usable.avgNetKcal ?? 0))} kcal/day — ${factor.toFixed(1)}x the scale. Expected: basal is a formula estimate and watch active energy runs generous. Trust the scale for size, the calorie figure for direction. (${usable.coveragePct}% of ${usable.windowDays} days logged.)`
        : `Calorie maths and scale agree within ${factor?.toFixed(1) ?? '?'}x. (${usable.coveragePct}% of ${usable.windowDays} days logged.)`,
  }
}
