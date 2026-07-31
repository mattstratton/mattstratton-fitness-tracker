import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseHaePayload } from '../lib/parse/hae.ts'

const REPORTED_AT = new Date('2026-07-31T12:00:00Z')

function obs(payload: unknown) {
  return parseHaePayload(payload, { reportedAt: REPORTED_AT, source: 'hae' }).observations
}

test('renames known metrics to canonical names and units', () => {
  const out = obs({
    data: {
      metrics: [
        { name: 'dietary_energy', units: 'kcal', data: [{ date: '2026-07-30 00:00:00 -0500', qty: 1660 }] },
      ],
    },
  })
  assert.deepEqual(out, [
    { observedOn: '2026-07-30', metric: 'calories', value: 1660, unit: 'kcal', recordedBy: null, source: 'hae', reportedAt: REPORTED_AT },
  ])
})

test('an UNKNOWN metric lands under its own name instead of being dropped', () => {
  // The whole point of docs/adr/0002. The old pipeline binned these into a
  // variable called `unknown` and threw 57 metrics away.
  const out = obs({
    data: { metrics: [{ name: 'toothbrushing', units: 's', data: [{ date: '2026-02-18 00:00:00 -0600', qty: 92 }] }] },
  })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.metric, 'toothbrushing')
  assert.equal(out[0]!.unit, 's')
})

test('converts weight from kg but leaves lb alone', () => {
  const kg = obs({ data: { metrics: [{ name: 'weight_body_mass', units: 'kg', data: [{ date: '2026-07-30 00:00:00 -0500', qty: 100 }] }] } })
  assert.equal(kg[0]!.metric, 'weight_lbs')
  assert.equal(kg[0]!.unit, 'lb')
  assert.ok(Math.abs(kg[0]!.value - 220.462) < 0.01)

  const lb = obs({ data: { metrics: [{ name: 'weight_body_mass', units: 'lb', data: [{ date: '2026-07-30 00:00:00 -0500', qty: 214.2 }] }] } })
  assert.equal(lb[0]!.value, 214.2)
})

test('heart_rate splits Min/Max/Avg into three metrics', () => {
  const out = obs({
    data: {
      metrics: [
        { name: 'heart_rate', units: 'count/min', data: [{ date: '2026-07-30 00:00:00 -0500', Min: 48, Max: 171, Avg: 74.2 }] },
      ],
    },
  })
  assert.deepEqual(
    out.map((o) => [o.metric, o.value]).sort(),
    [['heart_rate_avg', 74.2], ['heart_rate_max', 171], ['heart_rate_min', 48]].sort(),
  )
})

test('sleep stages come out in MINUTES, not the hours HAE sends', () => {
  // The 60x bug: SQLite converted asleep/inBed to minutes but dumped stages raw
  // in hours into the same row.
  const out = obs({
    data: {
      metrics: [
        {
          name: 'sleep_analysis',
          units: 'hr',
          data: [{ date: '2026-07-27 00:00:00 -0500', totalSleep: 7.0, inBed: 7.5, core: 5.057931966682275, deep: 0.5555603079332245, rem: 1.4428211040298144, awake: 0.19900178581476213 }],
        },
      ],
    },
  })
  const byMetric = Object.fromEntries(out.map((o) => [o.metric, o.value]))
  assert.equal(byMetric['sleep_asleep_min'], 420)
  assert.equal(byMetric['sleep_in_bed_min'], 450)
  assert.ok(Math.abs(byMetric['sleep_core_min']! - 303.48) < 0.01)
  assert.ok(out.every((o) => o.unit === 'min'))
  // ...and the stages must roughly sum to the sleep total, which they never
  // could when one side was hours and the other minutes.
  const stages = ['sleep_core_min', 'sleep_deep_min', 'sleep_rem_min'].reduce((a, k) => a + byMetric[k]!, 0)
  assert.ok(Math.abs(stages - byMetric['sleep_asleep_min']!) < 60, `stages ${stages} vs total ${byMetric['sleep_asleep_min']}`)
})

test('prefers totalSleep over the unreliable asleep field', () => {
  const out = obs({
    data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [{ date: '2026-07-27 00:00:00 -0500', totalSleep: 7.0, asleep: 0.2 }] }] },
  })
  assert.equal(out.find((o) => o.metric === 'sleep_asleep_min')!.value, 420)
})

test('a daily metric keeps HAE\'s own day label rather than being re-bucketed', () => {
  // HAE's `date` on a daily metric is a DAY LABEL that HealthKit already
  // aggregated in the phone's local day -- not an instant. Converting it to
  // America/Chicago would shift a travel day backwards and silently re-file it.
  // You cannot re-bucket someone else's daily aggregate; you can only take it.
  const out = obs({
    data: { metrics: [{ name: 'step_count', units: 'count', data: [{ date: '2026-07-26 00:00:00 -0400', qty: 9001 }] }] },
  })
  assert.equal(out[0]!.observedOn, '2026-07-26')
})

test('skips points with no value, and an empty metric yields nothing', () => {
  const out = obs({
    data: {
      metrics: [
        { name: 'step_count', units: 'count', data: [{ date: '2026-07-30 00:00:00 -0500' }] },
        // The July failure: permission dropped, so HAE exported an empty array
        // while its neighbours carried data. Must produce zero rows, not a zero.
        { name: 'weight_body_mass', units: 'lb', data: [] },
      ],
    },
  })
  assert.deepEqual(out, [])
})

test('tolerates a payload with no top-level data wrapper', () => {
  const out = obs({ metrics: [{ name: 'step_count', units: 'count', data: [{ date: '2026-07-30 00:00:00 -0500', qty: 5 }] }] })
  assert.equal(out.length, 1)
})

test('ignores automation config files, whose metrics are strings not objects', () => {
  assert.deepEqual(obs({ data: { metrics: ['Weight & Body Mass', 'Step Count'] } }), [])
})

test('parses workouts, converting seconds to minutes and unwrapping energy', () => {
  const { workouts } = parseHaePayload(
    {
      data: {
        workouts: [
          {
            name: 'Traditional Strength Training',
            start: '2026-07-30 18:58:39 -0500',
            end: '2026-07-30 19:47:02 -0500',
            duration: 2903.276,
            activeEnergyBurned: { units: 'kcal', qty: 288 },
          },
        ],
      },
    },
    { reportedAt: REPORTED_AT, source: 'hae' },
  )
  assert.equal(workouts.length, 1)
  assert.equal(workouts[0]!.type, 'Traditional Strength Training')
  assert.ok(Math.abs(workouts[0]!.durationMin! - 48.39) < 0.01)
  assert.equal(workouts[0]!.energyKcal, 288)
  assert.equal(workouts[0]!.startedAt.toISOString(), '2026-07-30T23:58:39.000Z')
})

test('the same workout in two timezone offsets is one instant', () => {
  // The travel-day duplicate: two automations either side of a zone change.
  // timestamptz keying makes this collapse without any _utc_key helper.
  const a = parseHaePayload({ data: { workouts: [{ name: 'Yoga', start: '2026-07-26 10:33:41 -0500' }] } }, { reportedAt: REPORTED_AT, source: 'hae' })
  const b = parseHaePayload({ data: { workouts: [{ name: 'Yoga', start: '2026-07-26 11:33:41 -0400' }] } }, { reportedAt: REPORTED_AT, source: 'hae' })
  assert.equal(a.workouts[0]!.startedAt.getTime(), b.workouts[0]!.startedAt.getTime())
})

test('deduplicates workouts sharing a natural key within one payload', () => {
  // Real 2016-2018 exports repeat sessions inside a single file, which makes
  // ON CONFLICT DO UPDATE fail: Postgres won't touch one row twice per
  // statement. Last occurrence wins, as with any other Restatement.
  const { workouts } = parseHaePayload(
    {
      data: {
        workouts: [
          { name: 'Yoga', start: '2026-07-26 10:33:41 -0500', activeEnergyBurned: { qty: 100 } },
          { name: 'Yoga', start: '2026-07-26 10:33:41 -0500', activeEnergyBurned: { qty: 111 } },
          // same instant, different type -> genuinely two sessions
          { name: 'Walk', start: '2026-07-26 10:33:41 -0500', activeEnergyBurned: { qty: 50 } },
        ],
      },
    },
    { reportedAt: REPORTED_AT, source: 'hae' },
  )
  assert.equal(workouts.length, 2)
  assert.equal(workouts.find((w) => w.type === 'Yoga')!.energyKcal, 111)
})

test('captures the device or app that recorded a value', () => {
  // The field the first schema discarded -- and the one that explained a 343.5
  // lb weigh-in typed into MyFitnessPal between two Withings scale readings.
  const out = obs({
    data: {
      metrics: [
        { name: 'weight_body_mass', units: 'lb', data: [
          { date: '2021-11-30 00:00:00 -0600', qty: 343.5, source: 'MyFitnessPal' },
          { date: '2021-12-10 00:00:00 -0600', qty: 302.1, source: 'MyFitnessPal | Withings' },
        ] },
      ],
    },
  })
  assert.deepEqual(out.map((o) => o.recordedBy), ['MyFitnessPal', 'MyFitnessPal | Withings'])
})

test('inBed 0 falls back to the inBedStart/inBedEnd span', () => {
  // HAE reports inBed: 0 on most nights while the start/end pair holds the real
  // interval. The old Python survived by accident (`0 or span` is falsy); the
  // first TS port stored the zero and wiped out every in-bed figure. Caught by
  // diffing against the old database, not by any unit test -- hence this one.
  const out = obs({
    data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [{
      date: '2026-07-28 00:00:00 -0500', totalSleep: 8.449, asleep: 0, inBed: 0,
      inBedStart: '2026-07-27 20:12:32 -0500', inBedEnd: '2026-07-28 06:15:01 -0500',
      sleepStart: '2026-07-27 20:12:32 -0500', sleepEnd: '2026-07-28 06:15:01 -0500',
    }] }] },
  })
  const by = Object.fromEntries(out.map((o) => [o.metric, o.value]))
  assert.ok(Math.abs(by['sleep_in_bed_min']! - 602.48) < 0.1, `got ${by['sleep_in_bed_min']}`)
  assert.ok(Math.abs(by['sleep_asleep_min']! - 506.94) < 0.1, `got ${by['sleep_asleep_min']}`)
})

test('totalSleep 0 also falls back to the sleep span', () => {
  const out = obs({
    data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [{
      date: '2026-07-31 00:00:00 -0500', totalSleep: 0, asleep: 0, inBed: 6.495,
      sleepStart: '2026-07-31 00:23:19 -0500', sleepEnd: '2026-07-31 06:53:00 -0500',
    }] }] },
  })
  const by = Object.fromEntries(out.map((o) => [o.metric, o.value]))
  assert.ok(Math.abs(by['sleep_asleep_min']! - 389.68) < 0.1, `got ${by['sleep_asleep_min']}`)
  assert.ok(Math.abs(by['sleep_in_bed_min']! - 389.7) < 0.1, `got ${by['sleep_in_bed_min']}`)
})
