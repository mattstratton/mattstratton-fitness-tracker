// Pure parser for a live Liftoscript program's `## Day N` blocks -- a durable
// hint for "what's prescribed next," not a Liftoscript interpreter. Mirrors
// lib/signals/tiers.ts's contract: degrades to `[]`/`null` for anything it
// doesn't recognize (a non-GZCL program, an unrecognized day name), never
// throws. `run_playground` was tried first and confirmed not to work --
// every argument shape returns `exercises: {}` even though the same
// response's `stats` block is correct (docs/migration-log.md). This is the
// documented fallback: derive it from the program text plus the last
// performed day.
//
// Verified against Matty's real "GZCLP: Blacknoir version" program
// (`viohtrec`), not assumed. Two real quirks that shaped this parser:
//
// - Exercise lines are reuse references, not literal set schemes: a line
//   like `t1: Squat / ...t1_modified / 207.5lb / warmup: ...` gets its sets
//   scheme ("2x5, 1x5+") from a SEPARATE `t1_modified / used: none / ...`
//   template line -- and that template is defined textually AFTER the day
//   that references it (Day 1 references `t1_modified`, defined inside the
//   Day 4 block). A single top-to-bottom scan can't resolve that; this
//   parser collects templates in one pass, then walks days in a second.
// - An exercise that has progressed past its template's default variation
//   repeats ALL the template's variations inline, marking the current one
//   with a leading `!` (e.g. Day 2's Overhead Press). An exercise still on
//   the default variation has no inline variations at all. So: prefer an
//   inline `!`-marked candidate, else the first inline candidate, else fall
//   back to the template's own (`!`-marked, else first) variation.
import { KG_TO_LBS } from './domain.js'

export type ProgramExercise = {
  tier: 't1' | 't2' | 't3' | null
  name: string
  weightLbs: number | null
  /** e.g. "2x5, 1x5+"; null when no set scheme could be resolved. */
  sets: string | null
  warmup: string | null
}
export type ProgramDay = { index: number; name: string; exercises: ProgramExercise[] }

const TIER_RE = /^(t[123]):\s*(.+)$/
const WEIGHT_RE = /^(\d+(?:\.\d+)?)(lb|kg)$/
const WARMUP_RE = /^warmup:\s*(.*)$/
const DAY_HEADER_RE = /^##\s*(.+)$/
const TEMPLATE_REF_RE = /^\.\.\.(\S+)$/
// Broadened deliberately beyond an exact "2x5"-only match: a CONTAINS check,
// not anchored to the whole segment, so it also recognizes inline,
// multi-clause, percentage-based schemes (a hypothetical future non-GZCL
// program written like "1x5 65%, 1x5 75%, 1x5+ 85%"), not just Blacknoir's
// bare template-reuse tokens.
const SET_SCHEME_CANDIDATE_RE = /\d+x\d+\+?/

function splitSegments(line: string): string[] {
  return line.split(' / ').map((s) => s.trim())
}

function isSetSchemeCandidate(segment: string): boolean {
  return SET_SCHEME_CANDIDATE_RE.test(segment)
}

/** `!`-marked wins (the current variation); else the first candidate. */
function pickSets(candidates: string[]): string | null {
  if (candidates.length === 0) return null
  const marked = candidates.find((c) => c.startsWith('!'))
  const chosen = marked ?? candidates[0]!
  return chosen.replace(/^!\s*/, '')
}

/** Every `used: none` template line, keyed by its identifier (e.g. "t1_modified"). */
function parseTemplates(lines: string[]): Map<string, string | null> {
  const templates = new Map<string, string | null>()
  for (const rawLine of lines) {
    const segments = splitSegments(rawLine.trim())
    if (segments.length < 2) continue
    if (!segments.includes('used: none')) continue
    const name = segments[0]!
    templates.set(name, pickSets(segments.filter(isSetSchemeCandidate)))
  }
  return templates
}

export function parseProgramDays(programText: string): ProgramDay[] {
  const lines = programText.split('\n')
  const templates = parseTemplates(lines)

  const days: ProgramDay[] = []
  let current: ProgramDay | null = null

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('//')) continue

    const header = DAY_HEADER_RE.exec(line)
    if (header) {
      current = { index: days.length, name: header[1]!.trim(), exercises: [] }
      days.push(current)
      continue
    }
    if (!current) continue

    const segments = splitSegments(line)
    if (segments.length < 2) continue
    // A template definition living inside this day's block (e.g. Day 4
    // carries GZCLP's t1_modified/t2_modified/t3_modified) -- not an
    // exercise performed on this day.
    if (segments.includes('used: none')) continue

    const first = segments[0]!
    const tierMatch = TIER_RE.exec(first)
    const tier = (tierMatch?.[1] as 't1' | 't2' | 't3' | undefined) ?? null
    const name = (tierMatch?.[2] ?? first).trim()

    let weightLbs: number | null = null
    let warmup: string | null = null
    let templateRef: string | null = null
    const inlineCandidates: string[] = []

    for (const seg of segments.slice(1)) {
      const weightMatch = WEIGHT_RE.exec(seg)
      if (weightMatch) {
        const amount = Number(weightMatch[1])
        weightLbs = weightMatch[2] === 'kg' ? amount * KG_TO_LBS : amount
        continue
      }
      const warmupMatch = WARMUP_RE.exec(seg)
      if (warmupMatch) {
        const value = warmupMatch[1]!.trim()
        warmup = value.toLowerCase() === 'none' ? null : value
        continue
      }
      const templateMatch = TEMPLATE_REF_RE.exec(seg)
      if (templateMatch) {
        templateRef = templateMatch[1]!
        continue
      }
      if (isSetSchemeCandidate(seg)) inlineCandidates.push(seg)
    }

    const sets = inlineCandidates.length > 0
      ? pickSets(inlineCandidates)
      : templateRef !== null
        ? templates.get(templateRef) ?? null
        : null

    current.exercises.push({ tier, name, weightLbs, sets, warmup })
  }

  return days
}

/**
 * Which day comes next in the cycle. Name/position-based, not "Day N"
 * numeric parsing -- works identically for this program's sequential names
 * and a hypothetical non-numeric rotation (A1/A2/B1/B2) without special-
 * casing either.
 */
export function nextWorkoutDay(days: ProgramDay[], lastDayName: string | null): ProgramDay | null {
  if (days.length === 0) return null
  if (lastDayName === null) return days[0]!
  const i = days.findIndex((d) => d.name === lastDayName)
  if (i === -1) return days[0]! // unrecognized/changed program -> restart the cycle
  return days[(i + 1) % days.length]!
}
