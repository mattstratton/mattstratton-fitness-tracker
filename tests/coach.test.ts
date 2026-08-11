/**
 * Tests for the coaching chat's pure layer (#8).
 *
 * No network and no database: what is testable here is the tool boundary's
 * shape, the SSE framing, the auth predicate, and whether the prompt still says
 * the things that keep answers honest. Whether the model gives a *good* answer is
 * not unit-testable and is verified by the trap probes in
 * docs/superpowers/specs/2026-08-11-coach-chat-design.md instead.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isAuthorizedApiSession } from '../lib/coach/guard.js'
import { buildRuntimeContext, buildSystemPrompt } from '../lib/coach/prompt.js'
import { decodeChunk, encodeEvent } from '../lib/coach/stream.js'
import type { CoachEvent } from '../lib/coach/stream.js'
import {
  COACH_TOOLS, COACH_TOOL_NAMES, COACH_TOOL_SPECS,
  clampDays, groupSets, likePattern, roundNumbers,
} from '../lib/coach/tools.js'
import type { Targets } from '../lib/config.js'
import type { FreshnessRow, LiftingSetRow } from '../lib/signals/types.js'

// ---- the tool surface -------------------------------------------------------

// Written out in full deliberately. Adding or removing a tool that the chat can
// reach should be a decision someone made on purpose, not a diff nobody noticed.
const EXPECTED_TOOLS = [
  'get_signals',
  'list_metrics',
  'get_metric_series',
  'get_today',
  'get_nutrition',
  'get_training_sessions',
  'list_exercises',
  'get_lifting_sets',
  'get_weight_trend',
  'get_energy_balance',
  'get_recovery',
  'get_latest_sleep',
  'get_next_workout',
]

test('tools: the exposed set is exactly what is intended', () => {
  assert.deepEqual([...COACH_TOOL_NAMES].sort(), [...EXPECTED_TOOLS].sort())
})

test('tools: names are unique', () => {
  assert.equal(new Set(COACH_TOOL_NAMES).size, COACH_TOOL_NAMES.length)
})

test('tools: every tool is runnable', () => {
  for (const tool of COACH_TOOLS) {
    assert.equal(typeof tool.run, 'function', `${tool.name} has no run`)
  }
})

test('tools: every tool describes itself well enough to be chosen correctly', () => {
  for (const spec of COACH_TOOL_SPECS) {
    // Thin descriptions are the documented cause of poor tool selection, and for
    // several of these the description is where a trap is spelled out.
    assert.ok(
      spec.description.length > 120,
      `${spec.name}'s description is too thin to steer a choice`,
    )
    assert.equal(spec.inputSchema['type'], 'object', `${spec.name} schema is not an object`)
    assert.equal(
      spec.inputSchema['additionalProperties'],
      false,
      `${spec.name} accepts unknown properties`,
    )
  }
})

// The traps this whole design exists to foreclose. If one of these ever fails,
// the answer is not to change the test.
test('tools: nothing exposes health_workouts, which double-counts every session', () => {
  // Apple shadow-copies every Liftosaur session. A tool over that view answers
  // "how much did I train" with roughly double the truth.
  for (const name of COACH_TOOL_NAMES) {
    assert.doesNotMatch(name, /health_workout/, `${name} exposes health_workouts`)
  }
  assert.ok(COACH_TOOL_NAMES.includes('get_training_sessions'), 'the reconciled view must be reachable')
})

test('tools: no tool can write anything', () => {
  // Read-only is the security posture, not an oversight: an LLM with unattended
  // write access to a training program is explicitly not the goal (#8).
  for (const name of COACH_TOOL_NAMES) {
    assert.doesNotMatch(name, /^(set|save|update|apply|delete|insert|write|edit|create)_/, `${name} looks like a write`)
  }
})

test('tools: energy balance advertises its own unreliability', () => {
  const tool = COACH_TOOL_SPECS.find((t) => t.name === 'get_energy_balance')
  assert.ok(tool)
  // It overstates the deficit by ~2.6x, so the description has to carry both the
  // caveat and where the real magnitude comes from.
  assert.match(tool.description, /2\.6/)
  assert.match(tool.description, /get_weight_trend/)
})

test('tools: get_lifting_sets says what reps: 0 means', () => {
  const tool = COACH_TOOL_SPECS.find((t) => t.name === 'get_lifting_sets')
  assert.ok(tool)
  assert.match(tool.description, /FAILED/)
})

test('tools: get_today is the only one that admits to returning today', () => {
  const tool = COACH_TOOL_SPECS.find((t) => t.name === 'get_today')
  assert.ok(tool)
  assert.match(tool.description, /ONLY TOOL THAT RETURNS TODAY/)
})

// ---- clampDays --------------------------------------------------------------

test('clampDays: falls back when the model omits or garbles the window', () => {
  assert.equal(clampDays(undefined, 14, 400), 14)
  assert.equal(clampDays(Number.NaN, 14, 400), 14)
  assert.equal(clampDays(Number.POSITIVE_INFINITY, 14, 400), 14)
})

test('clampDays: bounds both ends and truncates', () => {
  assert.equal(clampDays(9999, 14, 400), 400)
  assert.equal(clampDays(0, 14, 400), 1)
  assert.equal(clampDays(-30, 14, 400), 1)
  assert.equal(clampDays(7.9, 14, 400), 7)
})

// ---- likePattern ------------------------------------------------------------

test('likePattern: wraps the term for a substring match', () => {
  assert.equal(likePattern('bench'), '%bench%')
})

test('likePattern: escapes wildcards so they match literally', () => {
  // Without this, an exercise name containing _ quietly matches any character.
  assert.equal(likePattern('a_b'), '%a\\_b%')
  assert.equal(likePattern('50%'), '%50\\%%')
})

// ---- groupSets --------------------------------------------------------------

function set(over: Partial<LiftingSetRow>): LiftingSetRow {
  return {
    performedOn: '2026-08-01', recordId: 1, exercise: 'Squat', setIndex: 0,
    reps: 5, weightLbs: 200, targetReps: 5, isAmrap: false, ...over,
  }
}

test('groupSets: collapses sets into one group per exercise per session', () => {
  const groups = groupSets([
    set({ setIndex: 0 }),
    set({ setIndex: 1 }),
    set({ setIndex: 0, exercise: 'Bench Press' }),
  ])
  assert.equal(groups.length, 2)
  assert.equal(groups[0]!.exercise, 'Squat')
  assert.equal(groups[0]!.sets.length, 2)
  assert.equal(groups[1]!.exercise, 'Bench Press')
})

test('groupSets: two sessions of the same exercise stay separate', () => {
  // Same exercise, same date, different record -- two sessions in one day is
  // rare but real, and merging them would fabricate a single longer session.
  const groups = groupSets([set({ recordId: 1 }), set({ recordId: 2 })])
  assert.equal(groups.length, 2)
})

test('groupSets: counts reps: 0 as a failed set, not as missing data', () => {
  const groups = groupSets([set({ setIndex: 0 }), set({ setIndex: 1, reps: 0 }), set({ setIndex: 2, reps: 0 })])
  assert.equal(groups.length, 1)
  assert.equal(groups[0]!.failedSets, 2)
  // And the zeros are still there to be read, not filtered out as noise.
  assert.equal(groups[0]!.sets.length, 3)
})

test('groupSets: an empty log groups to nothing rather than throwing', () => {
  assert.deepEqual(groupSets([]), [])
})

// ---- roundNumbers -----------------------------------------------------------

test('roundNumbers: strips float accumulation noise from the views', () => {
  // Real values, straight out of the nutrition view and observations_daily.
  assert.equal(roundNumbers(1370.9033333354562), 1370.9)
  assert.equal(roundNumbers(271.6469919206364), 271.65)
})

test('roundNumbers: walks nested structures and leaves everything else alone', () => {
  const input = {
    days: 7,
    label: 'protein',
    missing: null,
    points: [{ observedOn: '2026-08-01', value: 20.970000000074002 }],
  }
  assert.deepEqual(roundNumbers(input), {
    days: 7,
    label: 'protein',
    missing: null,
    points: [{ observedOn: '2026-08-01', value: 20.97 }],
  })
})

test('roundNumbers: leaves integers exactly as they are', () => {
  // Record ids and step counts must not acquire a decimal point.
  assert.equal(roundNumbers(3430), 3430)
  assert.equal(roundNumbers(-1), -1)
})

// ---- the SSE framing --------------------------------------------------------

test('stream: an event round-trips', () => {
  const event: CoachEvent = { t: 'text', delta: 'down 1.1 lb/wk' }
  const { events, buffer } = decodeChunk('', encodeEvent(event))
  assert.deepEqual(events, [event])
  assert.equal(buffer, '')
})

test('stream: a delta containing newlines survives', () => {
  // SSE terminates a message at a blank line, so this is the case that would
  // split one event into two malformed ones if the payload were not JSON.
  const event: CoachEvent = { t: 'text', delta: 'line one\n\nline two' }
  const { events } = decodeChunk('', encodeEvent(event))
  assert.deepEqual(events, [event])
})

test('stream: several events in one chunk all decode', () => {
  const wire = encodeEvent({ t: 'tool', name: 'get_signals' }) +
    encodeEvent({ t: 'text', delta: 'ok' }) +
    encodeEvent({ t: 'done' })
  const { events } = decodeChunk('', wire)
  assert.equal(events.length, 3)
  assert.deepEqual(events[2], { t: 'done' })
})

test('stream: an event split across chunks is buffered, not lost', () => {
  const wire = encodeEvent({ t: 'text', delta: 'hello' })
  const cut = Math.floor(wire.length / 2)

  const first = decodeChunk('', wire.slice(0, cut))
  assert.deepEqual(first.events, [], 'half an event is not an event')

  const second = decodeChunk(first.buffer, wire.slice(cut))
  assert.deepEqual(second.events, [{ t: 'text', delta: 'hello' }])
  assert.equal(second.buffer, '')
})

test('stream: a malformed frame is skipped rather than killing the turn', () => {
  // Dropping one status line beats throwing mid-answer.
  const { events } = decodeChunk('', 'data: {not json\n\n' + encodeEvent({ t: 'done' }))
  assert.deepEqual(events, [{ t: 'done' }])
})

// ---- the auth boundary ------------------------------------------------------

const PROD = { NODE_ENV: 'production', DEV_BYPASS_AUTH: undefined }
const ALLOWED = 'matt.stratton@gmail.com'

test('guard: the allowed address gets in', () => {
  assert.equal(isAuthorizedApiSession({ user: { email: ALLOWED } }, PROD), true)
})

test('guard: no session is refused', () => {
  // /api is excluded from proxy.ts's matcher, so an anonymous POST reaches the
  // route handler. This is the check that stops it.
  assert.equal(isAuthorizedApiSession(null, PROD), false)
  assert.equal(isAuthorizedApiSession(undefined, PROD), false)
  assert.equal(isAuthorizedApiSession({}, PROD), false)
  assert.equal(isAuthorizedApiSession({ user: null }, PROD), false)
  assert.equal(isAuthorizedApiSession({ user: { email: null } }, PROD), false)
  assert.equal(isAuthorizedApiSession({ user: { email: '' } }, PROD), false)
})

test('guard: a signed-in stranger is refused', () => {
  assert.equal(isAuthorizedApiSession({ user: { email: 'someone@else.com' } }, PROD), false)
})

test('guard: the address is matched case-insensitively', () => {
  assert.equal(isAuthorizedApiSession({ user: { email: 'Matt.Stratton@Gmail.com' } }, PROD), true)
})

test('guard: the dev bypass needs BOTH signals', () => {
  assert.equal(isAuthorizedApiSession(null, { NODE_ENV: 'development', DEV_BYPASS_AUTH: '1' }), true)
  // Set in production, which is what Vercel always runs: still refused.
  assert.equal(isAuthorizedApiSession(null, { NODE_ENV: 'production', DEV_BYPASS_AUTH: '1' }), false)
  // Development but not opted in: still refused.
  assert.equal(isAuthorizedApiSession(null, { NODE_ENV: 'development', DEV_BYPASS_AUTH: undefined }), false)
  assert.equal(isAuthorizedApiSession(null, { NODE_ENV: 'development', DEV_BYPASS_AUTH: '0' }), false)
})

// ---- the prompt -------------------------------------------------------------
//
// These assert that the correctness rules are STILL IN the prompt. The failure
// mode of a prompt is not a crash: it is someone trimming it for tokens and
// removing the sentence that was preventing a confidently wrong answer.

test('prompt: carries the Partial Day rule', () => {
  const prompt = buildSystemPrompt()
  assert.match(prompt, /Partial Day/)
  assert.match(prompt, /1241 kcal/, 'the concrete incident is what makes the rule stick')
})

test('prompt: keeps unknown distinct from ok', () => {
  assert.match(buildSystemPrompt(), /`unknown` when there is not enough data|"Unknown" is not "fine"/)
})

test('prompt: forbids prescribing macros, because MacroFactor owns that', () => {
  const prompt = buildSystemPrompt()
  assert.match(prompt, /MACROFACTOR IS AUTHORITATIVE ON MACROS/)
  assert.match(prompt, /Never propose a calorie target/)
})

test('prompt: states the read-only boundary', () => {
  assert.match(buildSystemPrompt(), /You are \*\*read-only\*\*/)
})

test('prompt: carries the remaining data traps', () => {
  const prompt = buildSystemPrompt()
  assert.match(prompt, /gap is not a zero/i)
  assert.match(prompt, /reps: 0` means the set was/)
  assert.match(prompt, /2\.6x/)
  assert.match(prompt, /single weigh-in is noise/)
  assert.match(prompt, /7% coverage/)
})

test('prompt: forbids numbers that did not come from a tool', () => {
  assert.match(buildSystemPrompt(), /Never state a number you did not get from a tool/)
})

test('prompt: hardcodes no target values', () => {
  // Targets change roughly weekly at /settings and reach the model through the
  // runtime context. A number baked in here would contradict the app within a
  // fortnight while sounding authoritative.
  const prompt = buildSystemPrompt()
  assert.doesNotMatch(prompt, /1660/, 'a calorie target is hardcoded in the prompt')
  assert.doesNotMatch(prompt, /198\s*g/, 'a protein target is hardcoded in the prompt')
})

// ---- the runtime context ----------------------------------------------------

const CUT: Targets = { phase: 'cut', proteinG: 198, calories: 1660, expected: -1.0, concerning: 1.5 }

function fresh(over: Partial<FreshnessRow>): FreshnessRow {
  return {
    label: 'Steps', latest: '2026-08-10', ageDays: 1, status: 'fresh',
    automatic: true, maxAgeDays: 2, ...over,
  }
}

test('runtime context: renders the targets it was handed', () => {
  const text = buildRuntimeContext({
    today: '2026-08-11', targets: CUT, exerciseMinutesTarget: 30, freshness: [fresh({})],
  })
  assert.match(text, /Today is 2026-08-11/)
  assert.match(text, /Protein: 198 g\/day/)
  assert.match(text, /Calories: 1660 kcal/)
  assert.match(text, /-1 lb\/week \(loss\)/)
  assert.match(text, /30 min\/day/)
  assert.match(text, /Every source is fresh/)
})

test('runtime context: says so when a phase is not steered by calories', () => {
  const text = buildRuntimeContext({
    today: '2026-08-11',
    targets: { phase: 'maintain', proteinG: 170, calories: null, expected: 0, concerning: 0.75 },
    exerciseMinutesTarget: 30,
    freshness: [],
  })
  assert.match(text, /not being steered by calories/)
  assert.match(text, /\(hold\)/)
})

test('runtime context: a stale AUTOMATIC source is called a broken pipeline', () => {
  // This is the distinction that matters: an automatic source going stale means
  // ingest is broken, whereas a user-driven gap is usually just travel.
  const text = buildRuntimeContext({
    today: '2026-08-11', targets: CUT, exerciseMinutesTarget: 30,
    freshness: [fresh({ label: 'Steps', status: 'stale', ageDays: 6, automatic: true })],
  })
  assert.match(text, /BROKEN PIPELINE: Steps is stale \(6d old\)/)
  assert.doesNotMatch(text, /Every source is fresh/)
})

test('runtime context: a stale USER-DRIVEN source is not raised as a fault', () => {
  const text = buildRuntimeContext({
    today: '2026-08-11', targets: CUT, exerciseMinutesTarget: 30,
    freshness: [fresh({ label: 'Weight', status: 'stale', ageDays: 4, automatic: false })],
  })
  assert.doesNotMatch(text, /BROKEN PIPELINE/)
  assert.match(text, /probably travel or a missed entry/)
})

test('runtime context: repeats that today is partial', () => {
  const text = buildRuntimeContext({
    today: '2026-08-11', targets: CUT, exerciseMinutesTarget: 30, freshness: [],
  })
  assert.match(text, /Today is a Partial Day/)
})
