// Parser for Liftosaur's Liftohistory text format, ported from
// sync_liftosaur.py. Records look like:
//
//   2026-07-17 23:48:39 +00:00 / program: "GZCLP: Blacknoir version" / dayName: "Day 4" / exercises: {
//     Deadlift / 3x5 215lb / warmup: 1x5 107.5lb / target: 2x5 215lb, 1x5+ 215lb
//   }
//
// Each performed group (NxR WEIGHT) expands to N Lifting Sets. Warmups are
// discarded; targets are kept so a missed AMRAP can be told apart from a
// genuine failure.
import { createHash } from 'node:crypto'

import { KG_TO_LBS, localDay, parseInstant } from '../domain.js'
import type { LiftingRecord, LiftingSet } from '../domain.js'

// "3x5 215lb", "1x13 88.75lb", "2x5 60kg @8", "3x12" (bodyweight)
const SET_GROUP_RE = /^(\d+)x(\d+)(?:\s+([\d.]+)\s*(lb|kg))?(?:\s+@[\d.]+)?$/
// Same, but reps may carry a trailing "+" for AMRAP ("1x5+ 215lb"), and a rest
// timer ("90s") may follow the weight on T3 accessory targets.
const TARGET_GROUP_RE =
  /^(\d+)x(\d+)(\+)?(?:\s+([\d.]+)\s*(lb|kg))?(?:\s+@[\d.]+)?(?:\s+\d+s)?$/

const PROGRAM_RE = /program:\s*"([^"]*)"/
const DAY_NAME_RE = /dayName:\s*"([^"]*)"/

export type ParsedSet = { reps: number; weightLbs: number | null }
export type ParsedTarget = { reps: number; isAmrap: boolean }

function toLbs(amount: string | undefined, unit: string | undefined): number | null {
  if (amount === undefined) return null
  const n = Number(amount)
  if (!Number.isFinite(n)) return null
  // Liftosaur writes "0lb" for bodyweight movements -- 52 sets across plank,
  // crunch, hanging leg raise, inverted row, bodyweight squat. That means
  // exactly what NULL already means here: no external load. Keeping both would
  // give one concept two representations, so every "did I add weight?" query
  // would need `> 0` instead of `IS NOT NULL`, and AVG(weight_lbs) would
  // quietly average real loads against zeroes.
  if (n === 0) return null
  return unit === 'kg' ? n * KG_TO_LBS : n
}

/** '2x5 125lb, 1x6 125lb' -> three sets. */
export function parseSets(segment: string): ParsedSet[] {
  const out: ParsedSet[] = []
  for (const group of segment.split(',')) {
    const m = SET_GROUP_RE.exec(group.trim())
    if (!m) continue
    const count = Number(m[1])
    const reps = Number(m[2])
    const weightLbs = toLbs(m[3], m[4])
    for (let i = 0; i < count; i++) out.push({ reps, weightLbs })
  }
  return out
}

/** '2x5 215lb, 1x5+ 215lb' -> three targets, the last an AMRAP. */
export function parseTarget(segment: string): ParsedTarget[] {
  const out: ParsedTarget[] = []
  for (const group of segment.split(',')) {
    const m = TARGET_GROUP_RE.exec(group.trim())
    if (!m) continue
    const count = Number(m[1])
    const reps = Number(m[2])
    const isAmrap = m[3] === '+'
    for (let i = 0; i < count; i++) out.push({ reps, isAmrap })
  }
  return out
}

export type LiftosaurRecord = { id: number; text: string }

export function parseRecord(record: LiftosaurRecord): {
  record: LiftingRecord
  sets: LiftingSet[]
} {
  const { id: recordId, text } = record
  const splitAt = text.indexOf('exercises:')
  const header = splitAt === -1 ? text : text.slice(0, splitAt)
  const body = splitAt === -1 ? '' : text.slice(splitAt + 'exercises:'.length)

  // Liftosaur always emits +00:00 and never a local offset, which is precisely
  // why the Observed Day is pinned to HOME_TZ rather than inferred.
  const startedAt = parseInstant(header.split(' / ')[0]?.trim() ?? '')
  if (startedAt === null) {
    throw new Error(`unparseable Liftosaur timestamp in record ${recordId}`)
  }

  const parsed: LiftingRecord = {
    recordId,
    performedOn: localDay(startedAt),
    startedAt,
    program: PROGRAM_RE.exec(header)?.[1] ?? null,
    dayName: DAY_NAME_RE.exec(header)?.[1] ?? null,
    textHash: createHash('sha256').update(text).digest('hex'),
  }

  const sets: LiftingSet[] = []
  for (const rawLine of body.trim().replace(/^\{|\}$/g, '').trim().split('\n')) {
    const segments = rawLine.trim().split(' / ').map((s) => s.trim())
    if (segments.length < 2) continue
    const exercise = segments[0]
    if (!exercise) continue

    const rest = segments.slice(1)
    const performed = rest.find((s) => !s.startsWith('warmup:') && !s.startsWith('target:'))
    if (performed === undefined) continue

    const targetSegment = rest.find((s) => s.startsWith('target:'))
    const targets = targetSegment
      ? parseTarget(targetSegment.slice(targetSegment.indexOf(':') + 1))
      : []

    parseSets(performed).forEach((set, i) => {
      const target = targets[i]
      sets.push({
        recordId,
        performedOn: parsed.performedOn,
        exercise,
        setIndex: i,
        reps: set.reps,
        weightLbs: set.weightLbs,
        targetReps: target?.reps ?? null,
        isAmrap: target?.isAmrap ?? null,
      })
    })
  }

  return { record: parsed, sets }
}
