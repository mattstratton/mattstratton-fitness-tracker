import { test } from 'node:test'
import assert from 'node:assert/strict'

import { nextWorkoutDay, parseProgramDays } from '../lib/liftoscriptProgram.js'
import type { ProgramDay } from '../lib/liftoscriptProgram.js'

// Trimmed from Matty's real, live "GZCLP: Blacknoir version" program
// (viohtrec), fetched via the Liftosaur MCP -- not invented. Day 1
// references t1_modified/t2_modified/t3_modified, which are only DEFINED
// inside Day 4's block, further down in the text: a genuine forward
// reference. Comment lines (single and triple slash) are real noise this
// program actually contains, kept here to prove they're correctly skipped.
const GZCLP_EXCERPT = `
# Week 1
## Day 1
// **T1**. It starts with **85% of 5RM** (or approximately **75% or 1RM**).
// You can adjust your 1RM by clicking the **edit** icon, and setting the **1 Rep Max** value.

// ! **T1**.
t1: Squat / ...t1_modified / 207.5lb / warmup: 1x5 45lb, 1x5 50%, 1x5 80%

// **T2**. Start with **55% of 1RM**.
t2: Bench Press / ...t2_modified / 115lb

// ...t3_modified
t3: Lat Pulldown / ...t3_modified / 93.75lb / warmup: none

// ...t3_modified
t3: Triceps Pushdown / ...t3_modified / 42.5lb / warmup: none

## Day 2
t1: Overhead Press / ...t1_modified / 2x5, 1x5+ / ! 3x3, 1x3+ / 4x2, 1x2+ / 1x5 (5RM Test) / 97.5lb / progress: custom(increase: 2.5lb) { ...t1_modified }

## Day 4
t1: Deadlift / ...t1_modified / 245lb / warmup: 1x5 50%, 1x5 80%

t2: Overhead Press / ...t2_modified / 75lb / warmup: 1x5 50%, 1x5 80% / progress: custom(increase: 2.5lb) { ...t2_modified }

t3: Lat Pulldown / ...t3_modified / 93.75lb

t3: Incline Curl / ...t3_modified / 20lb / warmup: none

t1_modified / used: none / 2x5, 1x5+ / 3x3, 1x3+ / 4x2, 1x2+ / 1x5 (5RM Test) / 75% / progress: custom(increase: 10lb) {~
  if (descriptionIndex == 1) {
    descriptionIndex = 2
  }
~}

t2_modified / used: none / 4x8 / 4x6 / 4x4 / 55% / progress: custom(stage1weight: 0lb, increase: 5lb, stage3increase: 10lb) {~
  if (descriptionIndex == 1) {
    descriptionIndex = 2
  }
~}

/// Other variations of T1 and T3:
/// To use them, reuse those templates in your other exercises.
t3_modified / used: none / 3x12, 1x12+ / 60% 90s / progress: custom() {~
  if (completedReps[ns] >= 18) {
    weights = completedWeights[ns] + 5lb
  }
~}
`

test('parseProgramDays finds all day blocks with their real names', () => {
  const days = parseProgramDays(GZCLP_EXCERPT)
  assert.deepEqual(days.map((d) => d.name), ['Day 1', 'Day 2', 'Day 4'])
})

test('resolves a forward-referenced template (Day 1 references a template defined in Day 4)', () => {
  const days = parseProgramDays(GZCLP_EXCERPT)
  const squat = days[0]!.exercises.find((e) => e.name === 'Squat')
  assert.deepEqual(squat, { tier: 't1', name: 'Squat', weightLbs: 207.5, sets: '2x5, 1x5+', warmup: '1x5 45lb, 1x5 50%, 1x5 80%' })
})

test('an inline "!"-marked variation wins over the template default', () => {
  const days = parseProgramDays(GZCLP_EXCERPT)
  const ohp = days[1]!.exercises.find((e) => e.name === 'Overhead Press')
  assert.deepEqual(ohp, { tier: 't1', name: 'Overhead Press', weightLbs: 97.5, sets: '3x3, 1x3+', warmup: null })
})

test('warmup: none normalizes to null, not the literal string', () => {
  const days = parseProgramDays(GZCLP_EXCERPT)
  const lp = days[0]!.exercises.find((e) => e.name === 'Lat Pulldown')
  assert.equal(lp?.warmup, null)
})

test('a template definition line inside a day block is not itself an exercise', () => {
  const days = parseProgramDays(GZCLP_EXCERPT)
  const day4Names = days[2]!.exercises.map((e) => e.name)
  assert.deepEqual(day4Names, ['Deadlift', 'Overhead Press', 'Lat Pulldown', 'Incline Curl'])
})

test('a program with no ## Day headers parses to nothing, not a guess', () => {
  // Real 5/3/1 BBB program text (same shape as the fixture already proven
  // against parseTiers in tests/signals.test.ts) -- no day headers, no tier
  // labels at all.
  const fiveThreeOne = [
    'Squat / 1x5 65%, 1x5 75%, 1x5+ 85% / progress: custom(increase: 10lb)',
    'Squat, Barbell / 5x10 50% / progress: custom(increase: 5lb)',
  ].join('\n')
  assert.deepEqual(parseProgramDays(fiveThreeOne), [])
})

test('broadened matching resolves an inline, template-free, percentage-based scheme', () => {
  // Synthetic: a day-headered program (unlike the templateless 5/3/1 BBB
  // fixture above) that writes its sets scheme inline, 5/3/1-style, with no
  // template reuse at all -- proves the CONTAINS match (not exact-match-only)
  // covers a future non-Blacknoir program, not just today's template style.
  const dayHeadered531 = [
    '## Day 1',
    'Squat / 1x5 65%, 1x5 75%, 1x5+ 85% / progress: custom(increase: 10lb)',
  ].join('\n')
  const days = parseProgramDays(dayHeadered531)
  assert.deepEqual(days[0]!.exercises[0], {
    tier: null, name: 'Squat', weightLbs: null, sets: '1x5 65%, 1x5 75%, 1x5+ 85%', warmup: null,
  })
})

// ---- nextWorkoutDay ---------------------------------------------------------

const DAYS: ProgramDay[] = [
  { index: 0, name: 'Day 1', exercises: [] },
  { index: 1, name: 'Day 2', exercises: [] },
  { index: 2, name: 'Day 3', exercises: [] },
  { index: 3, name: 'Day 4', exercises: [] },
]

test('nextWorkoutDay: first-ever session starts at day 0', () => {
  assert.equal(nextWorkoutDay(DAYS, null)?.name, 'Day 1')
})

test('nextWorkoutDay: normal rotation moves to the next day', () => {
  assert.equal(nextWorkoutDay(DAYS, 'Day 3')?.name, 'Day 4')
})

test('nextWorkoutDay: wraps around from the last day back to the first', () => {
  assert.equal(nextWorkoutDay(DAYS, 'Day 4')?.name, 'Day 1')
})

test('nextWorkoutDay: an unrecognized or changed program name restarts the cycle, not a crash', () => {
  // Real scenario: Matty was briefly on "Hotel Travel Week" between GZCLP
  // sessions -- its day name doesn't exist in the GZCLP day list.
  assert.equal(nextWorkoutDay(DAYS, 'Day 1: Hotel Full Body')?.name, 'Day 1')
})

test('nextWorkoutDay: no days at all yields null', () => {
  assert.equal(nextWorkoutDay([], null), null)
  assert.equal(nextWorkoutDay([], 'Day 1'), null)
})
