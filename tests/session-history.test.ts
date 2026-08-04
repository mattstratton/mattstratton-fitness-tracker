import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifySet, groupSessionSets } from '../lib/session-history.js'
import type { LiftingSetRow } from '../lib/signals/types.js'

function set(o: Partial<LiftingSetRow> & { recordId: number; exercise: string; setIndex: number }): LiftingSetRow {
  return {
    performedOn: '2026-08-01', reps: 5, weightLbs: 215, targetReps: 5, isAmrap: false, ...o,
  }
}

// ---- groupSessionSets -------------------------------------------------------

test('groupSessionSets groups by session, then by exercise, preserving input order', () => {
  const groups = groupSessionSets([
    set({ recordId: 1, exercise: 'Squat', setIndex: 0 }),
    set({ recordId: 1, exercise: 'Squat', setIndex: 1 }),
    set({ recordId: 1, exercise: 'Bench Press', setIndex: 0 }),
    set({ recordId: 2, exercise: 'Deadlift', setIndex: 0 }),
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0]!.recordId, 1)
  assert.deepEqual(groups[0]!.exercises.map((e) => e.exercise), ['Squat', 'Bench Press'])
  assert.equal(groups[0]!.exercises[0]!.sets.length, 2)
  assert.equal(groups[1]!.recordId, 2)
})

test('groupSessionSets does not re-sort -- interleaved records still group correctly', () => {
  const groups = groupSessionSets([
    set({ recordId: 1, exercise: 'Squat', setIndex: 0 }),
    set({ recordId: 2, exercise: 'Deadlift', setIndex: 0 }),
    set({ recordId: 1, exercise: 'Squat', setIndex: 1 }),
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups.find((g) => g.recordId === 1)?.exercises[0]?.sets.length, 2)
})

test('groupSessionSets: empty input yields no groups', () => {
  assert.deepEqual(groupSessionSets([]), [])
})

// ---- classifySet -------------------------------------------------------------

test('classifySet: reps 0 is failed, even without a target', () => {
  assert.equal(classifySet(set({ recordId: 1, exercise: 'Squat', setIndex: 0, reps: 0, targetReps: null })), 'failed')
  assert.equal(classifySet(set({ recordId: 1, exercise: 'Squat', setIndex: 0, reps: 0, targetReps: 5 })), 'failed')
})

test('classifySet: no target is untargeted', () => {
  assert.equal(classifySet(set({ recordId: 1, exercise: 'Squat', setIndex: 0, reps: 5, targetReps: null })), 'untargeted')
})

test('classifySet: short of a non-AMRAP target', () => {
  assert.equal(classifySet(set({ recordId: 1, exercise: 'Squat', setIndex: 0, reps: 3, targetReps: 5, isAmrap: false })), 'short')
})

test('classifySet: hitting a non-AMRAP target', () => {
  assert.equal(classifySet(set({ recordId: 1, exercise: 'Squat', setIndex: 0, reps: 5, targetReps: 5, isAmrap: false })), 'hit')
})

test('classifySet: an AMRAP set meeting or exceeding target is amrap-hit, not just hit', () => {
  assert.equal(classifySet(set({ recordId: 1, exercise: 'Squat', setIndex: 0, reps: 8, targetReps: 5, isAmrap: true })), 'amrap-hit')
  assert.equal(classifySet(set({ recordId: 1, exercise: 'Squat', setIndex: 0, reps: 5, targetReps: 5, isAmrap: true })), 'amrap-hit')
})

test('classifySet: an AMRAP set falling short of target is still short', () => {
  assert.equal(classifySet(set({ recordId: 1, exercise: 'Squat', setIndex: 0, reps: 3, targetReps: 5, isAmrap: true })), 'short')
})
