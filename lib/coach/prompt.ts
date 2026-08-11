/**
 * System prompt and runtime-context assembly for the coaching chat.
 *
 * Pure functions over already-fetched data, for the same reason lib/signals/* is:
 * no database, no clock reads, no network. That makes the prompt assertable in
 * tests -- and tests/coach.test.ts does assert that the correctness rules are
 * still in it, because the failure mode of a prompt is that someone trims it for
 * tokens and quietly removes the sentence that was preventing a wrong answer.
 */
import type { Targets } from '../config.js'
import { COACH_SECTIONS } from './context.js'
import type { FreshnessRow } from '../signals/types.js'

/**
 * The static system prompt.
 *
 * Static is the point: it is the cached prefix. Tools render before system, so a
 * single cache breakpoint on this block covers the tool definitions too, and
 * anything that varies per request or per day must stay OUT of it -- see
 * buildRuntimeContext below. A date interpolated in here would invalidate the
 * cache every midnight and, worse, on every deploy boundary.
 */
export function buildSystemPrompt(): string {
  return [
    'You are Matty\'s training and nutrition coach, answering questions against his own data.',
    'Everything you say about that data comes from the tools below, never from memory.',
    ...COACH_SECTIONS,
  ].join('\n\n')
}

export type RuntimeContext = {
  today: string
  targets: Targets
  exerciseMinutesTarget: number
  freshness: FreshnessRow[]
}

/**
 * The per-conversation facts, rendered as a text block.
 *
 * Prepended to the FIRST user turn rather than folded into the system prompt or
 * fetched via a tool. Three reasons, in order of how much they matter:
 *
 * 1. It sits after the cached system+tools prefix, so caching survives.
 * 2. It saves a round trip on the first question -- targets and freshness are
 *    needed for most answers, so fetching them eagerly is cheaper than a tool
 *    call the model has to decide to make.
 * 3. It puts freshness in front of the model unprompted, which is the first thing
 *    the /coach skill does and the thing most likely to be skipped otherwise.
 *
 * Targets arrive here from the database (loadTargets / loadExerciseTarget) and are
 * never hardcoded anywhere in lib/coach -- that is what keeps the prompt honest
 * when they change at /settings.
 */
export function buildRuntimeContext(ctx: RuntimeContext): string {
  const t = ctx.targets
  const calories = t.calories === null
    ? 'not being steered by calories in this phase'
    : `${t.calories} kcal`
  const direction = t.expected < 0 ? 'loss' : t.expected > 0 ? 'gain' : 'hold'

  // Freshness is grouped rather than dumped: "automatic and broken" and
  // "user-driven and quiet" are different situations with different responses,
  // and a flat list invites treating them the same.
  const broken = ctx.freshness.filter((f) => f.automatic && (f.status === 'stale' || f.status === 'missing'))
  const quiet = ctx.freshness.filter((f) => !f.automatic && (f.status === 'stale' || f.status === 'missing'))

  const lines = [
    '<runtime_context>',
    `Today is ${ctx.today} (America/Chicago). Today is a Partial Day: exclude it from every average and trend.`,
    '',
    'Current targets, as configured in this app right now:',
    `- Phase: ${t.phase}`,
    `- Protein: ${t.proteinG} g/day`,
    `- Calories: ${calories}`,
    `- Expected weight change: ${t.expected} lb/week (${direction}); ${t.concerning} lb/week in that direction is fast enough to be a problem in itself`,
    `- Exercise minutes: ${ctx.exerciseMinutesTarget} min/day`,
    '',
    'Data freshness:',
  ]

  if (broken.length === 0 && quiet.length === 0) {
    lines.push('- Every source is fresh.')
  } else {
    for (const f of broken) {
      lines.push(
        `- BROKEN PIPELINE: ${f.label} is ${f.status}` +
          `${f.ageDays === null ? '' : ` (${f.ageDays}d old)`}. This is an automatic source, so ` +
          'it should never go stale. Mention it before coaching on anything that depends on it.',
      )
    }
    for (const f of quiet) {
      lines.push(
        `- ${f.label} is ${f.status}${f.ageDays === null ? '' : ` (${f.ageDays}d old)`}. ` +
          'User-driven, so this is probably travel or a missed entry rather than a fault.',
      )
    }
  }

  lines.push('</runtime_context>')
  return lines.join('\n')
}
