// Ported from test_pipeline.py. The Liftohistory parser is the only genuinely
// fiddly code in the pipeline, and these cases encode edge cases discovered the
// hard way: AMRAP markers, a trailing rest-timer on T3 targets, kg conversion,
// and bodyweight sets carrying no weight at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseTarget, parseSets, parseRecord } from '../lib/parse/liftohistory.ts'

test('parseTarget expands groups and flags the AMRAP set', () => {
  assert.deepEqual(parseTarget('2x5 215lb, 1x5+ 215lb'), [
    { reps: 5, isAmrap: false },
    { reps: 5, isAmrap: false },
    { reps: 5, isAmrap: true },
  ])
})

test('parseTarget tolerates a trailing rest-timer suffix', () => {
  // Seen on T3 accessory targets: "3x12 93.75lb 90s"
  assert.deepEqual(parseTarget('3x12 93.75lb 90s, 1x12+ 93.75lb 90s'), [
    { reps: 12, isAmrap: false },
    { reps: 12, isAmrap: false },
    { reps: 12, isAmrap: false },
    { reps: 12, isAmrap: true },
  ])
})

test('parseSets expands NxR groups into one entry per set', () => {
  assert.deepEqual(parseSets('2x5 125lb, 1x6 125lb'), [
    { reps: 5, weightLbs: 125 },
    { reps: 5, weightLbs: 125 },
    { reps: 6, weightLbs: 125 },
  ])
})

test('parseSets converts kg to lb', () => {
  const sets = parseSets('1x5 60kg')
  assert.equal(sets.length, 1)
  assert.ok(Math.abs(sets[0]!.weightLbs! - 132.277) < 0.01, `got ${sets[0]!.weightLbs}`)
})

test('parseSets leaves bodyweight sets without a weight', () => {
  assert.deepEqual(parseSets('3x12'), [
    { reps: 12, weightLbs: null },
    { reps: 12, weightLbs: null },
    { reps: 12, weightLbs: null },
  ])
})

test('parseSets ignores an RPE suffix', () => {
  assert.deepEqual(parseSets('1x5 100lb @8'), [{ reps: 5, weightLbs: 100 }])
})

const RECORD = {
  id: 1,
  text:
    '2026-07-17 23:48:39 +00:00 / program: "GZCLP: Blacknoir version" ' +
    '/ dayName: "Day 4" / exercises: {\n' +
    '  Deadlift / 3x5 215lb / warmup: 1x5 107.5lb / target: 2x5 215lb, 1x5+ 215lb\n' +
    '}',
}

test('parseRecord attaches target reps and the AMRAP flag to each set', () => {
  const { sets } = parseRecord(RECORD)
  assert.equal(sets.length, 3)
  assert.deepEqual(
    sets.map((s) => [s.targetReps, s.isAmrap]),
    [
      [5, false],
      [5, false],
      [5, true],
    ],
  )
})

test('parseRecord discards warmup segments', () => {
  // The warmup is 1x5 107.5lb; if it leaked in we would see four sets, and one
  // at the wrong weight.
  const { sets } = parseRecord(RECORD)
  assert.equal(sets.length, 3)
  assert.ok(sets.every((s) => s.weightLbs === 215))
})

test('parseRecord dates a session by its America/Chicago local day', () => {
  // 23:48 UTC on the 17th is 18:48 Central on the 17th -- same day here, but
  // the point is that the answer must not depend on the machine's timezone.
  const { record } = parseRecord(RECORD)
  assert.equal(record.performedOn, '2026-07-17')
  assert.equal(record.program, 'GZCLP: Blacknoir version')
  assert.equal(record.dayName, 'Day 4')
})

test('a session after 19:00 Central still files under that local day, not the UTC one', () => {
  // 01:30 UTC on the 18th is 20:30 Central on the 17th. Under a naive UTC date
  // this evening session would land a day late and stop lining up with the food
  // logged alongside it.
  const { record } = parseRecord({
    id: 2,
    text: '2026-07-18 01:30:00 +00:00 / program: "GZCLP" / dayName: "Day 1" / exercises: {\n  Squat / 1x5 200lb\n}',
  })
  assert.equal(record.performedOn, '2026-07-17')
})

test('parseRecord is stable regardless of the machine timezone', () => {
  // The old Python used a bare .astimezone(), meaning the machine's *current*
  // zone, while re-pulling all history every sync -- so syncing from Boston
  // would silently re-date the archive. Pin TZ and prove we do not care.
  const before = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const a = parseRecord(RECORD).record.performedOn
    process.env.TZ = 'Asia/Tokyo'
    const b = parseRecord(RECORD).record.performedOn
    assert.equal(a, b)
    assert.equal(a, '2026-07-17')
  } finally {
    if (before === undefined) delete process.env.TZ
    else process.env.TZ = before
  }
})

test('a failed set is reps 0, not a missing row', () => {
  const { sets } = parseRecord({
    id: 3,
    text: '2026-07-20 18:00:00 +00:00 / program: "GZCLP" / dayName: "Day 2" / exercises: {\n  Bench Press / 2x5 145lb, 1x0 145lb\n}',
  })
  assert.equal(sets.length, 3)
  assert.equal(sets[2]!.reps, 0)
})

test('the same record parses identically twice (hash is stable)', () => {
  assert.equal(parseRecord(RECORD).record.textHash, parseRecord(RECORD).record.textHash)
  assert.notEqual(parseRecord(RECORD).record.textHash, parseRecord({ ...RECORD, text: RECORD.text + ' ' }).record.textHash)
})

test('0lb means bodyweight, and is stored the same way as no weight at all', () => {
  // Real data: 52 sets across plank, crunch, hanging leg raise and bodyweight
  // squat arrive as "0lb". A CHECK constraint (weight_lbs > 0) caught this on
  // first contact with Tiger Cloud -- the kind of thing typeless SQLite could
  // never have told us.
  assert.deepEqual(parseSets('3x12 0lb'), [
    { reps: 12, weightLbs: null },
    { reps: 12, weightLbs: null },
    { reps: 12, weightLbs: null },
  ])
  // ...identical to the same movement logged with no weight segment at all
  assert.deepEqual(parseSets('3x12 0lb'), parseSets('3x12'))
})
