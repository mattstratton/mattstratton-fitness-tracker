// Diff Tiger Cloud against the SQLite pipeline it replaces.
//
//   node scripts/diff-oracle.ts [path/to/fitness.db]
//
// `fitness.db` is the last known-good reference for the HAE parser, and it stops
// being one the moment the old pipeline is deleted. So this runs while both
// exist.
//
// It will NOT come back clean, and shouldn't: the old pipeline stored sleep
// stages in hours, dropped 57 metrics, and never captured basal or active
// energy. The bar is not "zero differences" -- it is "every difference is one we
// intended". Anything else is a parser regression.
//
// Reads SQLite with node:sqlite, in core since Node 22. No dependency.
import { DatabaseSync } from 'node:sqlite'

import { makePool } from '../lib/db.ts'

const SQLITE_PATH = process.argv[2] ?? 'fitness.db'
const TOLERANCE = 0.01

// Today is a Partial Day in both stores, captured at different moments, so it
// differs by construction and says nothing about the parser. Reported, never
// counted as a failure.
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())

// SQLite location -> canonical metric. Everything the old schema actually held.
const METRIC_MAP: Array<{ sql: string; metric: string; note?: string }> = [
  { sql: 'SELECT date, calories   AS v FROM nutrition WHERE calories   IS NOT NULL', metric: 'calories' },
  { sql: 'SELECT date, protein_g  AS v FROM nutrition WHERE protein_g  IS NOT NULL', metric: 'protein_g' },
  { sql: 'SELECT date, carbs_g    AS v FROM nutrition WHERE carbs_g    IS NOT NULL', metric: 'carbs_g' },
  { sql: 'SELECT date, fat_g      AS v FROM nutrition WHERE fat_g      IS NOT NULL', metric: 'fat_g' },
  { sql: 'SELECT date, steps      AS v FROM activity  WHERE steps      IS NOT NULL', metric: 'steps' },
  { sql: 'SELECT date, active_energy_kcal AS v FROM activity WHERE active_energy_kcal IS NOT NULL', metric: 'active_energy_kcal' },
  { sql: 'SELECT date, exercise_minutes   AS v FROM activity WHERE exercise_minutes   IS NOT NULL', metric: 'exercise_minutes' },
  { sql: "SELECT date, value AS v FROM body_metrics WHERE metric='weight_lbs'", metric: 'weight_lbs' },
  { sql: "SELECT date, value AS v FROM body_metrics WHERE metric='body_fat_percentage'", metric: 'body_fat_pct' },
  { sql: "SELECT date, value AS v FROM body_metrics WHERE metric='lean_body_mass'", metric: 'lean_mass_lbs' },
  { sql: 'SELECT date, asleep_minutes AS v FROM sleep WHERE asleep_minutes IS NOT NULL', metric: 'sleep_asleep_min' },
  { sql: 'SELECT date, in_bed_minutes AS v FROM sleep WHERE in_bed_minutes IS NOT NULL', metric: 'sleep_in_bed_min' },
]

const db = new DatabaseSync(SQLITE_PATH, { readOnly: true })
const pool = makePool()

type Row = { date: string; v: number }
let totalCompared = 0
let totalMatched = 0
let partialDay = 0
const problems: string[] = []

console.log(`${'metric'.padEnd(20)} ${'days'.padStart(5)} ${'match'.padStart(6)} ${'differ'.padStart(7)} ${'only in SQLite'.padStart(15)}`)

for (const { sql, metric } of METRIC_MAP) {
  const oracle = new Map<string, number>()
  for (const r of db.prepare(sql).all() as unknown as Row[]) oracle.set(r.date, Number(r.v))
  if (oracle.size === 0) continue

  const days = [...oracle.keys()].sort()
  const { rows } = await pool.query<{ observed_on: Date; value: string }>(
    `SELECT observed_on, value FROM observations_daily
     WHERE metric = $1 AND observed_on BETWEEN $2 AND $3`,
    [metric, days[0], days[days.length - 1]],
  )
  const mine = new Map(
    rows.map((r) => [r.observed_on.toISOString().slice(0, 10), Number(r.value)]),
  )

  let matched = 0
  let differed = 0
  let missing = 0
  for (const [day, want] of oracle) {
    const got = mine.get(day)
    if (day === TODAY) {
      if (got !== undefined && Math.abs(got - want) > TOLERANCE) partialDay++
      continue
    }
    if (got === undefined) {
      missing++
      // The old pipeline saw a value we don't. That is always worth explaining.
      problems.push(`${metric} ${day}: SQLite has ${want}, Tiger Cloud has nothing`)
      continue
    }
    totalCompared++
    if (Math.abs(got - want) <= TOLERANCE) {
      matched++
      totalMatched++
    } else {
      differed++
      if (problems.length < 40) {
        problems.push(`${metric} ${day}: SQLite ${want} vs Tiger Cloud ${got}`)
      }
    }
  }
  console.log(
    `${metric.padEnd(20)} ${String(oracle.size).padStart(5)} ${String(matched).padStart(6)} ` +
    `${String(differed).padStart(7)} ${String(missing).padStart(15)}`,
  )
}

// Workouts: keyed on the instant, so a genuine match proves the timezone
// normalisation agrees with the old _utc_key repair.
const oracleWorkouts = db
  .prepare('SELECT id, start_ts, type FROM workouts')
  .all() as unknown as Array<{ start_ts: string; type: string }>
const { rows: mineWorkouts } = await pool.query<{ started_at: Date; type: string }>(
  `SELECT started_at, type FROM health_workouts
   WHERE observed_on >= (SELECT min(substr(x,1,10))::date FROM (SELECT $1::text AS x) t)`,
  [oracleWorkouts.map((w) => w.start_ts).sort()[0] ?? '2026-01-01'],
)
const mineKeys = new Set(mineWorkouts.map((w) => `${w.started_at.toISOString()}|${w.type}`))
const missingWorkouts = oracleWorkouts.filter((w) => {
  const iso = new Date(w.start_ts.replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2')).toISOString()
  return !mineKeys.has(`${iso}|${w.type}`)
})

console.log(`\nworkouts: ${oracleWorkouts.length} in SQLite, ${missingWorkouts.length} not found in Tiger Cloud`)
for (const w of missingWorkouts.slice(0, 5)) console.log(`  missing: ${w.start_ts} ${w.type}`)

console.log(`\n${totalMatched}/${totalCompared} values matched within ${TOLERANCE}` +
  ` (${partialDay} same-day difference(s) on ${TODAY} ignored -- Partial Day, differs by construction)`)
if (problems.length > 0) {
  console.log(`\n${problems.length} difference(s) -- each must be an intended change, not a regression:`)
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`)
} else {
  console.log('no differences')
}

db.close()
await pool.end()
process.exitCode = totalCompared > 0 && totalMatched === totalCompared && missingWorkouts.length === 0 ? 0 : 1
