import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  RECENT_SLEEP_DAYS, describeSleepAge, describeSleepStages, formatSleepDuration, isSleepRecent,
} from '../lib/sleep.js'

test('formatSleepDuration drops a zero minutes remainder', () => {
  assert.equal(formatSleepDuration(420), '7h')
})

test('formatSleepDuration keeps a nonzero minutes remainder', () => {
  assert.equal(formatSleepDuration(410), '6h 50m')
})

test('formatSleepDuration handles under an hour', () => {
  assert.equal(formatSleepDuration(59), '0h 59m')
})

test('isSleepRecent is true within the recent-days threshold', () => {
  assert.equal(isSleepRecent(RECENT_SLEEP_DAYS), true)
})

test('isSleepRecent is false just past the recent-days threshold', () => {
  assert.equal(isSleepRecent(RECENT_SLEEP_DAYS + 1), false)
})

test('isSleepRecent honours a custom threshold', () => {
  assert.equal(isSleepRecent(5, 7), true)
  assert.equal(isSleepRecent(8, 7), false)
})

test('describeSleepAge special-cases one night ago', () => {
  assert.equal(describeSleepAge(1), 'last night')
})

test('describeSleepAge counts nights otherwise', () => {
  assert.equal(describeSleepAge(5), '5 nights ago')
})

test('describeSleepStages joins whichever stages are present', () => {
  assert.equal(
    describeSleepStages({ coreMin: 303, deepMin: 41, remMin: 86, awakeMin: 12 }),
    'core 5h 3m, deep 0h 41m, REM 1h 26m, awake 0h 12m',
  )
})

test('describeSleepStages omits a stage HAE did not report, not a fabricated zero', () => {
  assert.equal(
    describeSleepStages({ coreMin: 303, deepMin: null, remMin: 86, awakeMin: null }),
    'core 5h 3m, REM 1h 26m',
  )
})

test('describeSleepStages is null when no stage data exists at all', () => {
  assert.equal(
    describeSleepStages({ coreMin: null, deepMin: null, remMin: null, awakeMin: null }),
    null,
  )
})
