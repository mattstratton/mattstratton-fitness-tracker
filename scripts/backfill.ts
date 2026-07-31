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
import { writeObservations, writeWorkouts } from '../lib/ingest.ts'
import { parseHaePayload } from '../lib/parse/hae.ts'

const EXPORT_DIR = process.argv[2] ?? 'exports'
const pool = makePool()

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
    await writeObservations(pool, observations)
    console.log(
      `${file.padEnd(46)} ${from}..${to}  +${observations.length} obs` +
        (cleared.rowCount ? ` (cleared ${cleared.rowCount})` : ''),
    )
  }

  if (workouts.length > 0) await writeWorkouts(pool, workouts)
  totalObs += observations.length
  totalWorkouts += workouts.length
}

console.log(`\nloaded ${totalObs.toLocaleString()} observations, ${totalWorkouts.toLocaleString()} workouts`)

// Materialise everything EXCEPT today, deliberately.
//
// Refreshing with (NULL, NULL) materialises today's bucket too -- and once a
// bucket is materialised, real-time aggregation stops consulting raw rows for
// it. Any Report arriving later that day then stays invisible until the next
// scheduled refresh, so a push at 08:00 would not reach a query at 08:05. Today
// is precisely the day a Restatement is most likely and most consequential.
//
// Leaving today unmaterialised lets real-time aggregation serve it live from
// raw rows, always current. The scheduled policy has the same boundary: a bucket
// ending at midnight tonight is never "older than end_offset", so the policy
// alone would never have materialised it either. This call was the only thing
// that did.
console.log('refreshing observations_daily (all buckets before today)...')
await pool.query(
  `CALL refresh_continuous_aggregate('observations_daily', NULL, today_local())`,
)

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
