// Pure session-display shaping: how to lay out a set log, never how it looks.
//
// Mirrors lib/charting.ts -- no SQL, no fetch, no clock reads. Not under
// lib/signals/: this produces no Signal (no status/headline), just a display
// shape for /workouts' history section.
import type { LiftingSetRow } from './signals/types.js'

export type SessionSetGroup = {
  recordId: number
  exercises: Array<{ exercise: string; sets: LiftingSetRow[] }>
}

/**
 * Folds an already-ordered flat set list (record_id, exercise, set_index --
 * see loadLiftingSetsForRecords) into one group per session, one entry per
 * exercise within it. Preserves input order rather than re-sorting: this
 * function trusts the SQL ORDER BY, it doesn't recompute one.
 *
 * lifting_sets only preserves set order WITHIN an exercise -- there's no
 * stored signal for which exercise came first in a session. Exercises land
 * in whatever order the query returns them (alphabetical, per
 * loadLiftingSetsForRecords' ORDER BY record_id, exercise, set_index); this
 * is a real, permanent limitation of the schema, not something this
 * function works around.
 */
export function groupSessionSets(sets: LiftingSetRow[]): SessionSetGroup[] {
  const groups: SessionSetGroup[] = []
  const byRecord = new Map<number, SessionSetGroup>()
  const byExercise = new Map<string, { exercise: string; sets: LiftingSetRow[] }>()

  for (const set of sets) {
    let group = byRecord.get(set.recordId)
    if (!group) {
      group = { recordId: set.recordId, exercises: [] }
      byRecord.set(set.recordId, group)
      groups.push(group)
    }
    const key = `${set.recordId}|${set.exercise}`
    let exerciseGroup = byExercise.get(key)
    if (!exerciseGroup) {
      exerciseGroup = { exercise: set.exercise, sets: [] }
      byExercise.set(key, exerciseGroup)
      group.exercises.push(exerciseGroup)
    }
    exerciseGroup.sets.push(set)
  }

  return groups
}

export type SetClassification = 'hit' | 'short' | 'failed' | 'amrap-hit' | 'untargeted'

/**
 * Same reps-vs-target/AMRAP judgment lib/signals/lifting.ts's recentMisses
 * and stalling already encode, centralized once so the display layer
 * doesn't reimplement it. `reps: 0` is a failed set, not missing data.
 */
export function classifySet(set: LiftingSetRow): SetClassification {
  // A 0-rep set is a failed attempt, full stop -- it doesn't matter whether
  // there was a target to miss (recentMisses counts zeros independently of
  // target for the same reason).
  if (set.reps === 0) return 'failed'
  if (set.targetReps === null) return 'untargeted'
  if (set.isAmrap === true) return set.reps >= set.targetReps ? 'amrap-hit' : 'short'
  return set.reps >= set.targetReps ? 'hit' : 'short'
}
