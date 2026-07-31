// Load every HAE export in exports/ into Tiger Cloud.
//
//   DATABASE_URL=... node scripts/backfill.ts [exportDir]
//
// A manual, local, one-shot step -- not something the API serves. It runs
// against 87MB of JSON with no request timeout to respect, can be re-run freely
// while iterating, and imports the SAME parser module the push endpoint uses so
// the two can never drift.
//
// IDEMPOTENT, and it has to be: `observations` has no unique constraint (an
// append-only Report log is allowed to restate a value), so a naive re-run
// would silently double every row. Each file's date range is cleared of prior
// backfill rows before loading. Live 'hae' Reports are never touched.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { makePool } from '../lib/db.ts'
import { parseHaePayload } from '../lib/parse/hae.ts'
import type { HealthWorkout, Observation } from '../lib/domain.ts'

const EXPORT_DIR = process.argv[2] ?? 'exports'
const BATCH = 2000

const pool = makePool()

async function insertObservations(rows: Observation[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const values: unknown[] = []
    const tuples = chunk.map((o, n) => {
      values.push(o.observedOn, o.metric, o.value, o.unit, o.source, o.recordedBy, o.reportedAt)
      const b = n * 7
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`
    })
    await pool.query(
      `INSERT INTO observations (observed_on, metric, value, unit, source, recorded_by, reported_at)
       VALUES ${tuples.join(',')}`,
      values,
    )
  }
}

async function upsertWorkouts(rows: HealthWorkout[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const values: unknown[] = []
    const tuples = chunk.map((w, n) => {
      values.push(w.startedAt, w.type, w.endedAt, w.durationMin, w.energyKcal)
      const b = n * 5
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`
    })
    // Workouts DO have a natural key, unlike observations, so re-running just
    // refreshes them. This is also what collapses the same session exported
    // under two timezone offsets -- no _utc_key helper required.
    await pool.query(
      `INSERT INTO health_workouts (started_at, type, ended_at, duration_min, energy_kcal)
       VALUES ${tuples.join(',')}
       ON CONFLICT (started_at, type) DO UPDATE SET
         ended_at = excluded.ended_at,
         duration_min = excluded.duration_min,
         energy_kcal = excluded.energy_kcal`,
      values,
    )
  }
}

const files = readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.json')).sort()
if (files.length === 0) {
  console.error(`no .json files in ${EXPORT_DIR}/`)
  process.exit(1)
}

const startedAt = new Date()
let totalObs = 0
let totalWorkouts = 0

for (const file of files) {
  const path = join(EXPORT_DIR, file)
  // Report Time for a backfill is when we loaded it. Every live Report arrives
  // later, so last(value, reported_at) lets real data supersede the backfill
  // without any special-casing.
  const { observations, workouts } = parseHaePayload(
    JSON.parse(readFileSync(path, 'utf8')),
    { reportedAt: startedAt, source: 'hae_backfill' },
  )

  if (observations.length > 0) {
    const days = observations.map((o) => o.observedOn).sort()
    const from = days[0]!
    const to = days[days.length - 1]!
    const cleared = await pool.query(
      `DELETE FROM observations
       WHERE source = 'hae_backfill' AND observed_on BETWEEN $1 AND $2`,
      [from, to],
    )
    await insertObservations(observations)
    console.log(
      `${file.padEnd(46)} ${from}..${to}  +${observations.length} obs` +
        (cleared.rowCount ? ` (cleared ${cleared.rowCount})` : ''),
    )
  }

  if (workouts.length > 0) await upsertWorkouts(workouts)
  totalObs += observations.length
  totalWorkouts += workouts.length
}

console.log(`\nloaded ${totalObs.toLocaleString()} observations, ${totalWorkouts.toLocaleString()} workouts`)

// The continuous aggregate only materialises on its schedule, so force it now;
// otherwise the first verification query reads through real-time aggregation
// and tells you nothing about whether materialisation works.
console.log('refreshing observations_daily...')
await pool.query(`CALL refresh_continuous_aggregate('observations_daily', NULL, NULL)`)

const { rows } = await pool.query<{ label: string; n: string }>(`
  SELECT 'observations' AS label, count(*)::text AS n FROM observations
  UNION ALL SELECT 'distinct metrics', count(DISTINCT metric)::text FROM observations
  UNION ALL SELECT 'observations_daily', count(*)::text FROM observations_daily
  UNION ALL SELECT 'health_workouts', count(*)::text FROM health_workouts
  UNION ALL SELECT 'unit anomalies', count(*)::text FROM unit_anomalies
  UNION ALL SELECT 'unclassified workout types', count(*)::text FROM unclassified_workout_types
`)
console.log()
for (const r of rows) console.log(`  ${r.label.padEnd(28)} ${r.n}`)

await pool.end()
