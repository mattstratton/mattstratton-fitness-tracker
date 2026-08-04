import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveMarkType, resolveBarStatus } from '../lib/charting.js'
import type { Point } from '../lib/queries.js'

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
