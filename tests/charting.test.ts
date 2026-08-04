import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveMarkType, resolveBarStatus, axisTicks, computeTrendBand, windowStartDate,
} from '../lib/charting.js'
import type { Point } from '../lib/queries.js'
import type { Targets } from '../lib/config.js'

const day = (n: number) => `2026-07-${String(n).padStart(2, '0')}`

test('resolveMarkType: exactly 50% coverage is a line, not a bar', () => {
  const points: Point[] = Array.from({ length: 45 }, (_, i) => ({ observedOn: day(i + 1), value: 100 }))
  assert.equal(resolveMarkType(points, 90), 'line')
})

test('resolveMarkType: just under 50% coverage is a bar', () => {
  const points: Point[] = Array.from({ length: 44 }, (_, i) => ({ observedOn: day(i + 1), value: 100 }))
  assert.equal(resolveMarkType(points, 90), 'bar')
})

test('resolveMarkType: well above threshold is a line', () => {
  const points: Point[] = Array.from({ length: 85 }, (_, i) => ({ observedOn: day(i + 1), value: 100 }))
  assert.equal(resolveMarkType(points, 90), 'line')
})

test('resolveBarStatus: atLeast hits at or above target', () => {
  assert.equal(resolveBarStatus(198, 198, 'atLeast'), 'hit')
  assert.equal(resolveBarStatus(199, 198, 'atLeast'), 'hit')
  assert.equal(resolveBarStatus(197, 198, 'atLeast'), 'miss')
})

test('resolveBarStatus: signed negative (cut) wants at-or-under', () => {
  const direction = { signedExpected: -1.0 }
  assert.equal(resolveBarStatus(1660, 1660, direction), 'hit')
  assert.equal(resolveBarStatus(1600, 1660, direction), 'hit')
  assert.equal(resolveBarStatus(1700, 1660, direction), 'miss')
})

test('resolveBarStatus: signed positive (bulk) wants at-or-over', () => {
  const direction = { signedExpected: 0.5 }
  assert.equal(resolveBarStatus(3200, 3200, direction), 'hit')
  assert.equal(resolveBarStatus(3300, 3200, direction), 'hit')
  assert.equal(resolveBarStatus(3100, 3200, direction), 'miss')
})

test('resolveBarStatus: signed zero (maintain) wants a 5% tolerance band', () => {
  const direction = { signedExpected: 0 }
  assert.equal(resolveBarStatus(2200, 2200, direction), 'hit')
  assert.equal(resolveBarStatus(2250, 2200, direction), 'hit')
  assert.equal(resolveBarStatus(2600, 2200, direction), 'miss')
})

test('resolveBarStatus: a null target is neutral, never a fabricated miss', () => {
  assert.equal(resolveBarStatus(1900, null, { signedExpected: -1.0 }), 'neutral')
})

test('axisTicks: x tick count scales with window length', () => {
  const points30: Point[] = Array.from({ length: 30 }, (_, i) => ({ observedOn: day(i + 1), value: 100 }))
  assert.equal(axisTicks(points30, 30).x.length, 3)
})

test('axisTicks: y ticks are rounded to clean steps, not raw min/max', () => {
  const points: Point[] = [{ observedOn: day(1), value: 213 }, { observedOn: day(2), value: 287 }]
  const ticks = axisTicks(points, 90)
  assert.deepEqual(ticks.y, [200, 220, 240, 260, 280, 300])
})

test('axisTicks: empty points yields no ticks', () => {
  assert.deepEqual(axisTicks([], 90), { x: [], y: [] })
})

test('axisTicks: windowStart spaces dates across the window, not the data extent', () => {
  // Data clustered in the last week of a 30-day window. Without windowStart the
  // labels bunch into that week; with it they span the whole plotted range.
  const clustered: Point[] = [
    { observedOn: '2026-07-25', value: 100 },
    { observedOn: '2026-07-31', value: 110 },
  ]
  assert.deepEqual(axisTicks(clustered, 30).x, ['2026-07-25', '2026-07-28', '2026-07-31'])
  assert.deepEqual(
    axisTicks(clustered, 30, '2026-07-02').x,
    ['2026-07-02', '2026-07-17', '2026-08-01'],
  )
})

test('windowStartDate: the window opens windowDays before today', () => {
  assert.equal(windowStartDate('2026-08-01', 30), '2026-07-02')
})

test('computeTrendBand: null regression yields no overlay', () => {
  const points: Point[] = [{ observedOn: day(1), value: 275 }, { observedOn: day(2), value: 274 }]
  const target: Targets = { phase: 'cut', proteinG: 198, calories: 1660, expected: -1.0, concerning: 1.5 }
  assert.equal(computeTrendBand(points, null, target), null)
})

test('computeTrendBand: trend line follows the regression, band widens by concerning', () => {
  const points: Point[] = [{ observedOn: day(1), value: 275 }, { observedOn: day(8), value: 274 }]
  // slope -1 lb/week = -1/7 lb/day, anchored so day(1) (referenceDate) = 275
  const regression = { slope: -1 / 7, intercept: 275, referenceDate: day(1) }
  const target: Targets = { phase: 'cut', proteinG: 198, calories: 1660, expected: -1.0, concerning: 1.5 }
  const result = computeTrendBand(points, regression, target)
  assert.ok(result)
  assert.equal(result.trendLine[0].value, 275)
  assert.equal(Math.round(result.trendLine[1].value * 100) / 100, 274)
  assert.equal(result.band[0].value, 275)
  assert.equal(Math.round(result.band[2].value * 100) / 100, 275.5)
})
