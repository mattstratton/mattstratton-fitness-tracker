import type { Tier } from './tiers.js'
import type { LiftingSetRow, Signal } from './types.js'

type Session = {
  performedOn: string
  recordId: number
  exercise: string
  topWeight: number | null
  /** True when any set fell short of its prescribed reps. */
  missed: boolean
  /** True when the session had no target to judge against. */
  untargeted: boolean
}

/**
 * Collapse sets into one result per exercise per session.
 *
 * A set counts as missed when it did fewer reps than prescribed. `reps: 0` is a
 * failed set -- a real training event -- so it is emphatically a miss rather
 * than missing data. An AMRAP set is only missed if it fell BELOW its written
 * number; exceeding it is the point.
 */
export function toSessions(sets: LiftingSetRow[]): Session[] {
  const byKey = new Map<string, Session>()
  for (const s of sets) {
    const key = `${s.recordId}|${s.exercise}`
    let session = byKey.get(key)
    if (!session) {
      session = {
        performedOn: s.performedOn,
        recordId: s.recordId,
        exercise: s.exercise,
        topWeight: null,
        missed: false,
        untargeted: true,
      }
      byKey.set(key, session)
    }
    if (s.weightLbs !== null && (session.topWeight === null || s.weightLbs > session.topWeight)) {
      session.topWeight = s.weightLbs
    }
    if (s.targetReps !== null) {
      session.untargeted = false
      if (s.reps < s.targetReps) session.missed = true
    }
  }
  return [...byKey.values()].sort((a, b) => a.performedOn.localeCompare(b.performedOn))
}

/**
 * A lift that has stalled: the same weight missed in two or more consecutive
 * sessions.
 *
 * This is a decision, not a nudge — GZCLP wants a stage change or a reset, and
 * grinding the same weight a third time is how a linear progression quietly
 * stops being linear. Deliberately requires the SAME weight: missing at 215 and
 * then at 225 is just progression, not a stall.
 */
export function stalling(sets: LiftingSetRow[], tiers?: Map<string, Tier>): Signal {
  const base = { id: 'stalling', title: 'Stalled lifts' } as const
  const sessions = toSessions(sets)
    .filter((s) => !s.untargeted)
    // T3 accessories are MEANT to sit at one weight: GZCLP only bumps them once
    // the AMRAP clears 18 reps. Treating that as a stall reports "Triceps
    // Pushdown stalled" every week, which is how a real stall on a T1 gets
    // ignored. Verified against real data -- this was the rule's only false
    // positive. Without a tier map we can't tell, so nothing is excluded.
    .filter((s) => tiers === undefined || tiers.get(s.exercise) !== 't3')

  if (sessions.length === 0) {
    return { ...base, status: 'unknown', headline: 'No targeted sessions in the window' }
  }

  const byExercise = new Map<string, Session[]>()
  for (const s of sessions) {
    const list = byExercise.get(s.exercise) ?? []
    list.push(s)
    byExercise.set(s.exercise, list)
  }

  const stalled: string[] = []
  for (const [exercise, list] of byExercise) {
    let run = 0
    let runWeight: number | null = null
    for (const s of list) {
      if (s.missed && s.topWeight !== null && s.topWeight === runWeight) {
        run += 1
      } else if (s.missed && s.topWeight !== null) {
        run = 1
        runWeight = s.topWeight
      } else {
        run = 0
        runWeight = null
      }
      if (run >= 2) {
        stalled.push(`${exercise} at ${runWeight}lb (${run} sessions)`)
        break
      }
    }
  }

  if (stalled.length === 0) {
    return { ...base, status: 'ok', headline: 'Nothing stalled' }
  }
  return {
    ...base,
    status: 'act',
    headline: `${stalled.length} lift${stalled.length > 1 ? 's' : ''} stalled`,
    detail: `${stalled.join('; ')}. The LP wants a stage change or a reset rather than a third attempt at the same weight.`,
  }
}

/**
 * Recent failed sets, as context rather than a verdict.
 *
 * Distinct from stalling: one missed session is normal and expected on a cut,
 * and flagging it as actionable would train you to ignore the signal that
 * matters.
 */
export function recentMisses(sets: LiftingSetRow[]): Signal {
  const base = { id: 'misses', title: 'Missed sets' } as const
  const zeros = sets.filter((s) => s.reps === 0)
  const short = sets.filter((s) => s.reps > 0 && s.targetReps !== null && s.reps < s.targetReps)

  if (zeros.length === 0 && short.length === 0) {
    return { ...base, status: 'ok', headline: 'Every set hit its target' }
  }
  return {
    ...base,
    status: 'watch',
    headline: `${zeros.length} failed, ${short.length} short of target`,
    detail: 'Expected on a deficit. Only a repeat at the same weight is a stall.',
  }
}
