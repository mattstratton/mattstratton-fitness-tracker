import { test } from 'node:test'
import assert from 'node:assert/strict'

import { calorieAdherence, proteinAdherence, loggingGaps } from '../lib/signals/nutrition.js'
import { weightTrend, deficitReality } from '../lib/signals/body.js'
import { overreaching } from '../lib/signals/recovery.js'
import { stalling, recentMisses, toSessions } from '../lib/signals/lifting.js'
import { freshness } from '../lib/signals/freshness.js'
import { parseTiers } from '../lib/signals/tiers.js'
import { MAINTAIN, BULK } from '../lib/config.js'
import type { Targets } from '../lib/config.js'
import type { LiftingSetRow, NutritionDay, RecoveryDay } from '../lib/signals/types.js'

const day = (n: number) => `2026-07-${String(n).padStart(2, '0')}`

// The settled cut targets from nutrition-strategy.md, as of the migration to
// nutrition_targets (db/migrations/0009). A local fixture, not a production
// constant, on purpose -- these are values a test needs, not a live default.
const CUT: Targets = { phase: 'cut', proteinG: 198, calories: 1660, expected: -1.0, concerning: 1.5 }

// MAINTAIN/BULK ship with calories: null ("not being steered"). These variants
// exist purely so calorieAdherence's direction logic can be exercised for
// phases that DO have a number to grade against.
const BULK_WITH_CALORIES: Targets = { ...BULK, calories: 3200 }
const MAINTAIN_WITH_CALORIES: Targets = { ...MAINTAIN, calories: 2200 }

// ---- protein ---------------------------------------------------------------

function nutrition(protein: Array<number | null>): NutritionDay[] {
  return protein.map((p, i) => ({ observedOn: day(i + 1), calories: p === null ? null : 1600, proteinG: p }))
}

test('protein: hitting the target most days is ok', () => {
  const s = proteinAdherence(nutrition([200, 210, 199, 205, 198, 150, 220]), CUT)
  assert.equal(s.status, 'ok')
  assert.match(s.headline, /6\/7 days hit 198g/)
})

test('protein: the average can look fine while the shape is bad', () => {
  // Average is 198 -- exactly on target -- but four of seven days missed. The
  // average alone would say "fine"; the hit-rate says otherwise.
  const s = proteinAdherence(nutrition([260, 260, 260, 150, 150, 150, 156]), CUT)
  const avg = Math.round((260 * 3 + 150 * 3 + 156) / 7)
  assert.equal(avg, 198)
  assert.equal(s.status, 'act', 'a 3/7 hit rate must be actionable even at target average')
})

test('protein: unlogged days are excluded, not counted as zero', () => {
  const s = proteinAdherence(nutrition([200, null, null, 210, null, null, 205]), CUT)
  assert.equal(s.status, 'ok', '3/3 logged days hit the target')
  assert.match(s.detail ?? '', /4 of the last 7 days weren't logged/)
})

test('protein: nothing logged is unknown, never a shortfall', () => {
  const s = proteinAdherence(nutrition([null, null, null]), CUT)
  assert.equal(s.status, 'unknown')
  assert.match(s.detail ?? '', /logging gap, not a shortfall/)
})

test('logging: separates "did not log" from "did not eat enough"', () => {
  // The real shape of this dataset: 21 of 90 days.
  const s = loggingGaps(nutrition([100, null, null, null, null]))
  assert.equal(s.status, 'act')
  assert.match(s.headline, /4 of 5 days unlogged/)
})

// ---- calories ---------------------------------------------------------------

function calories(values: Array<number | null>): NutritionDay[] {
  return values.map((c, i) => ({ observedOn: day(i + 1), calories: c, proteinG: c === null ? null : 150 }))
}

test('calories: on a cut, staying at or under target most days is ok', () => {
  const s = calorieAdherence(calories([1600, 1650, 1660, 1500, 1700, 1620, 1400]), CUT)
  assert.equal(s.status, 'ok')
  assert.match(s.headline, /6\/7 days within target/)
})

test('calories: on a cut, going over target is the miss', () => {
  const s = calorieAdherence(calories([1900, 2000, 1950, 2100]), CUT)
  assert.equal(s.status, 'act')
})

test('calories: on a bulk, going under target is the miss', () => {
  const s = calorieAdherence(calories([2600, 2700, 2800, 2900]), BULK_WITH_CALORIES)
  assert.equal(s.status, 'act')
})

test('calories: on a bulk, staying at or over target is ok', () => {
  const s = calorieAdherence(calories([3200, 3300, 3400, 3250]), BULK_WITH_CALORIES)
  assert.equal(s.status, 'ok')
})

test('calories: on maintenance, only meaningful drift either way misses', () => {
  // Target 2200, 5% tolerance is +/-110.
  const s = calorieAdherence(calories([2200, 2600, 2900, 1800]), MAINTAIN_WITH_CALORIES)
  assert.equal(s.status, 'act', '1/4 within the band')
})

test('calories: a phase not being steered by calories is unknown, not graded', () => {
  const s = calorieAdherence(calories([1600, 1700]), MAINTAIN)
  assert.equal(s.status, 'unknown')
  assert.match(s.headline, /not being steered/i)
})

test('calories: nothing logged is unknown, never a miss', () => {
  const s = calorieAdherence(calories([null, null, null]), CUT)
  assert.equal(s.status, 'unknown')
  assert.match(s.detail ?? '', /logging gap, not a miss/)
})

// ---- weight & deficit ------------------------------------------------------

test('weight: flags short and long windows disagreeing in sign', () => {
  const s = weightTrend([
    { days: 14, weighIns: 8, lbsPerWeek: 0.4 },
    { days: 90, weighIns: 40, lbsPerWeek: -0.6 },
  ], CUT)
  assert.equal(s.status, 'watch')
  assert.match(s.detail ?? '', /90-day trend goes the other way/)
})

test('weight: losing faster than 1.5 lb/week is worth watching', () => {
  const s = weightTrend([{ days: 14, weighIns: 9, lbsPerWeek: -2.1 }], CUT)
  assert.equal(s.status, 'watch')
  assert.match(s.detail ?? '', /lean mass/)
})

test('weight: too few weigh-ins is unknown, not ok', () => {
  assert.equal(weightTrend([{ days: 14, weighIns: 1, lbsPerWeek: null }], CUT).status, 'unknown')
})

test('deficit: ignores a well-formed but poorly covered window', () => {
  // The real 90-day row: confident numbers over 21% coverage. Must be refused.
  const s = deficitReality([
    { windowDays: 90, coveragePct: 21, avgNetKcal: -1568, impliedLbsPerWeek: -3.14, actualLbsPerWeek: -0.64, overstatementFactor: 4.9 },
  ], CUT)
  assert.equal(s.status, 'unknown')
  assert.match(s.detail ?? '', /60% is the bar/)
})

test('deficit: leads with the scale and names the overstatement', () => {
  const s = deficitReality([
    { windowDays: 14, coveragePct: 93, avgNetKcal: -1784, impliedLbsPerWeek: -3.57, actualLbsPerWeek: -1.35, overstatementFactor: 2.64 },
  ], CUT)
  assert.equal(s.status, 'ok')
  assert.match(s.headline, /675 kcal\/day, from the scale/)
  assert.match(s.detail ?? '', /2\.6x the scale/)
})

// ---- recovery --------------------------------------------------------------

function recovery(rhr: number[], hrv: number[]): RecoveryDay[] {
  return rhr.map((v, i) => ({ observedOn: day(i + 1), restingHr: v, hrvMs: hrv[i] ?? null }))
}

/** A baseline that wobbles, because real physiology does and flat data has an
 *  SD of zero, which the rule correctly refuses to draw conclusions from. */
function wobble(n: number, mean: number, spread = 2): number[] {
  return Array.from({ length: n }, (_, i) => mean + ((i % 5) - 2) * (spread / 2))
}

test('recovery: three suppressed days on both markers is actionable', () => {
  const rhr = [...wobble(25, 55), 62, 63, 62]
  const hrv = [...wobble(25, 60), 40, 39, 41]
  const s = overreaching(recovery(rhr, hrv))
  assert.equal(s.status, 'act')
  assert.match(s.detail ?? '', /resting HR/)
  assert.match(s.detail ?? '', /HRV/)
})

test('recovery: one bad night is not overreaching', () => {
  const rhr = [...wobble(25, 55), 55, 55, 70]
  const hrv = [...wobble(28, 60)]
  assert.equal(overreaching(recovery(rhr, hrv)).status, 'ok')
})

test('recovery: a zero-variance baseline is unknown, not "normal"', () => {
  // Flat data means something is wrong upstream, not that recovery is perfect.
  const s = overreaching(recovery(Array(30).fill(55), Array(30).fill(60)))
  assert.equal(s.status, 'unknown')
})

test('recovery: too little watch data is unknown, not ok', () => {
  const s = overreaching(recovery([55, 56, 57, 58], [60, 61, 62, 63]))
  assert.equal(s.status, 'unknown')
})

test('recovery: the recent window cannot drag its own baseline', () => {
  // If the suppressed days were included in the baseline they would raise the
  // mean and mask themselves. Long flat history, then a clear 3-day jump.
  const rhr = [...wobble(40, 50), 60, 61, 60]
  const hrv = [...wobble(43, 60)]
  assert.equal(overreaching(recovery(rhr, hrv)).status, 'watch')
})

// ---- lifting ---------------------------------------------------------------

function set(o: Partial<LiftingSetRow> & { recordId: number; reps: number }): LiftingSetRow {
  return {
    performedOn: day(o.recordId), exercise: 'Squat', setIndex: 0,
    weightLbs: 215, targetReps: 5, isAmrap: false, ...o,
  }
}

test('lifting: same weight missed twice is a stall', () => {
  const s = stalling([
    set({ recordId: 1, reps: 5 }),
    set({ recordId: 2, reps: 3 }),
    set({ recordId: 3, reps: 4 }),
  ])
  assert.equal(s.status, 'act')
  assert.match(s.detail ?? '', /Squat at 215lb \(2 sessions\)/)
})

test('lifting: misses at DIFFERENT weights are progression, not a stall', () => {
  const s = stalling([
    set({ recordId: 1, reps: 3, weightLbs: 215 }),
    set({ recordId: 2, reps: 3, weightLbs: 225 }),
  ])
  assert.equal(s.status, 'ok')
})

test('lifting: a good session between misses resets the run', () => {
  const s = stalling([
    set({ recordId: 1, reps: 3 }),
    set({ recordId: 2, reps: 5 }),
    set({ recordId: 3, reps: 3 }),
  ])
  assert.equal(s.status, 'ok')
})

test('lifting: exceeding an AMRAP target is success, not a miss', () => {
  const s = stalling([
    set({ recordId: 1, reps: 9, targetReps: 5, isAmrap: true }),
    set({ recordId: 2, reps: 8, targetReps: 5, isAmrap: true }),
  ])
  assert.equal(s.status, 'ok')
})

test('lifting: reps 0 is a failed set, not missing data', () => {
  const s = recentMisses([set({ recordId: 1, reps: 0 }), set({ recordId: 1, setIndex: 1, reps: 5 })])
  assert.match(s.headline, /1 failed/)
})

test('lifting: bodyweight work with no target cannot stall', () => {
  const s = stalling([
    set({ recordId: 1, reps: 12, exercise: 'Plank', weightLbs: null, targetReps: null }),
    set({ recordId: 2, reps: 10, exercise: 'Plank', weightLbs: null, targetReps: null }),
  ])
  assert.equal(s.status, 'unknown')
})

test('lifting: sessions collapse per exercise per record, keeping the top weight', () => {
  const sessions = toSessions([
    set({ recordId: 1, reps: 5, weightLbs: 185, setIndex: 0 }),
    set({ recordId: 1, reps: 5, weightLbs: 215, setIndex: 1 }),
  ])
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0]!.topWeight, 215)
  assert.equal(sessions[0]!.missed, false)
})

// ---- freshness -------------------------------------------------------------

test('freshness: a stale AUTOMATIC source is a broken pipeline', () => {
  const s = freshness([
    { label: 'Steps', latest: day(20), ageDays: 6, status: 'stale', automatic: true, maxAgeDays: 2 },
  ])
  assert.equal(s.status, 'act')
  assert.match(s.detail ?? '', /coached on stale data/)
})

test('freshness: a stale USER-DRIVEN source only warns', () => {
  // The July failure in miniature: weight going stale might just be travel.
  const s = freshness([
    { label: 'Weight', latest: day(20), ageDays: 6, status: 'stale', automatic: false, maxAgeDays: 4 },
  ])
  assert.equal(s.status, 'watch')
})

test('freshness: today being partial is not staleness', () => {
  const s = freshness([
    { label: 'Steps', latest: day(31), ageDays: 0, status: 'partial', automatic: true, maxAgeDays: 2 },
  ])
  assert.equal(s.status, 'ok')
})

// ---- tiers -----------------------------------------------------------------

const PROGRAM = [
  't1: Squat / ...t1_modified / 197.5lb / warmup: 1x5 45lb',
  't2: Bench Press / ...t2_modified / 110lb',
  't3: Triceps Pushdown / ...t3_modified / 37.5lb / warmup: none',
  't2: Squat / ...t2_modified / 155lb / warmup: 1x5 45lb',
  't3_modified / used: none / 3x12, 1x12+ / 60% 90s / progress: custom() {~',
].join('\n')

test('tiers: parses exercises out of Liftoscript', () => {
  const tiers = parseTiers(PROGRAM)
  assert.equal(tiers.get('Bench Press'), 't2')
  assert.equal(tiers.get('Triceps Pushdown'), 't3')
})

test('tiers: an exercise at two tiers keeps the more demanding one', () => {
  // Squat is T1 on day 1 and T2 on day 3; a T1 stall is the one that matters.
  assert.equal(parseTiers(PROGRAM).get('Squat'), 't1')
})

test('tiers: template definitions are not exercises', () => {
  // `t3_modified / used: none / ...` has no colon and must not register.
  assert.equal(parseTiers(PROGRAM).has('...t3_modified'), false)
  assert.equal([...parseTiers(PROGRAM).keys()].some((k) => k.includes('modified')), false)
})

test('lifting: a T3 sitting at one weight is the program working, not a stall', () => {
  // The real false positive: Triceps Pushdown at 40lb across two sessions.
  // GZCLP only bumps a T3 once the AMRAP clears 18 reps.
  const t3sets = [
    set({ recordId: 1, reps: 10, exercise: 'Triceps Pushdown', weightLbs: 40, targetReps: 12 }),
    set({ recordId: 2, reps: 11, exercise: 'Triceps Pushdown', weightLbs: 40, targetReps: 12 }),
  ]
  assert.equal(stalling(t3sets).status, 'act', 'without tiers it cannot tell')
  // With only T3 sets there is nothing left to judge, which is 'unknown' rather
  // than 'ok' -- claiming "nothing stalled" from an empty set would be a lie.
  assert.equal(stalling(t3sets, parseTiers(PROGRAM)).status, 'unknown')
})

test('lifting: T3s are ignored while real work is still judged', () => {
  // The realistic shape: a T3 parked at one weight next to a healthy T1.
  const mixed = [
    set({ recordId: 1, reps: 10, exercise: 'Triceps Pushdown', weightLbs: 40, targetReps: 12 }),
    set({ recordId: 2, reps: 11, exercise: 'Triceps Pushdown', weightLbs: 40, targetReps: 12 }),
    set({ recordId: 1, reps: 5, exercise: 'Squat', weightLbs: 215 }),
    set({ recordId: 2, reps: 5, exercise: 'Squat', weightLbs: 220 }),
  ]
  assert.equal(stalling(mixed, parseTiers(PROGRAM)).status, 'ok')
  assert.equal(stalling(mixed).status, 'act', 'and without tiers the T3 false-positives')
})

test('lifting: a T1 stall is still reported when tiers are known', () => {
  const t1sets = [
    set({ recordId: 1, reps: 3, exercise: 'Squat', weightLbs: 215 }),
    set({ recordId: 2, reps: 3, exercise: 'Squat', weightLbs: 215 }),
  ]
  assert.equal(stalling(t1sets, parseTiers(PROGRAM)).status, 'act')
})

test('tiers: a non-GZCL program yields nothing, and nothing breaks', () => {
  // Verified against Matty's real 5/3/1 BBB program, which has no t1:/t2:/t3:
  // labels at all and parses to zero entries. The tier map is a HINT: absent it,
  // stalling judges every exercise, which is exactly its behaviour before tiers
  // existed. Changing programs must degrade, never explode.
  const fiveThreeOne = [
    'Squat / 1x5 65%, 1x5 75%, 1x5+ 85% / progress: custom(increase: 10lb)',
    'Squat, Barbell / 5x10 50% / progress: custom(increase: 5lb)',
  ].join('\n')
  assert.equal(parseTiers(fiveThreeOne).size, 0)

  const sets = [
    set({ recordId: 1, reps: 3, exercise: 'Squat', weightLbs: 215 }),
    set({ recordId: 2, reps: 3, exercise: 'Squat', weightLbs: 215 }),
  ]
  // Same verdict with an empty map as with no map at all.
  assert.equal(stalling(sets, parseTiers(fiveThreeOne)).status, 'act')
  assert.equal(stalling(sets).status, 'act')
})

// ---- phase awareness -------------------------------------------------------

test('phase: the same weight trend reads differently on a cut and a bulk', () => {
  // 1.2 lb/week down. Correct on a cut, and going backwards on a bulk. The
  // hazard this replaces was a hardcoded cutting assumption still grading a
  // bulk months later, looking authoritative and being wrong.
  const rows = [{ days: 14, weighIns: 9, lbsPerWeek: -1.2 }]
  assert.equal(weightTrend(rows, CUT).status, 'ok')

  const bulk = weightTrend(rows, BULK)
  assert.equal(bulk.status, 'watch')
  assert.match(bulk.detail ?? '', /wrong way for a bulk/)
})

test('phase: maintenance flags drift in either direction', () => {
  assert.equal(weightTrend([{ days: 14, weighIns: 9, lbsPerWeek: -1.0 }], MAINTAIN).status, 'watch')
  assert.equal(weightTrend([{ days: 14, weighIns: 9, lbsPerWeek: 1.0 }], MAINTAIN).status, 'watch')
  assert.equal(weightTrend([{ days: 14, weighIns: 9, lbsPerWeek: -0.2 }], MAINTAIN).status, 'ok')
})

test('phase: gaining fast on a bulk is flagged, but not as "wrong way"', () => {
  const s = weightTrend([{ days: 14, weighIns: 9, lbsPerWeek: 1.8 }], BULK)
  assert.equal(s.status, 'watch')
  assert.match(s.detail ?? '', /more than the useful rate/)
})

test('phase: protein grades against the phase target, not a constant', () => {
  const days = nutrition([175, 175, 175, 175])
  assert.equal(proteinAdherence(days, CUT).status, 'act', '175g misses a 198g cut target')
  assert.equal(proteinAdherence(days, MAINTAIN).status, 'ok', '175g clears a 170g maintenance target')
})

test('phase: a bulk calls it a surplus rather than a deficit', () => {
  const rows = [{ windowDays: 14, coveragePct: 90, avgNetKcal: 400, impliedLbsPerWeek: 0.8, actualLbsPerWeek: 0.5, overstatementFactor: 1.6 }]
  assert.equal(deficitReality(rows, BULK).title, 'Surplus')
  assert.equal(deficitReality(rows, CUT).title, 'Deficit')
})
