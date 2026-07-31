// Dry-run the HAE parser over everything in exports/ without touching a
// database. Useful as a smoke test before a backfill, and for re-measuring the
// numbers quoted in docs/migration-log.md.
//
//   node scripts/scan-exports.ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { parseHaePayload } from '../lib/parse/hae.ts'

const EXPORT_DIR = process.argv[2] ?? 'exports'

const files = readdirSync(EXPORT_DIR).filter((f) => f.endsWith('.json')).sort()
if (files.length === 0) {
  console.error(`no .json files in ${EXPORT_DIR}/`)
  process.exit(1)
}

const perMetric = new Map<string, number>()
const perYear = new Map<string, number>()
const units = new Map<string, Set<string>>()
const uncatalogued = new Set<string>()
let totalObs = 0
let totalWorkouts = 0
const workoutTypes = new Map<string, number>()

console.log(`${'file'.padEnd(34)} ${'size'.padStart(7)} ${'obs'.padStart(8)} ${'workouts'.padStart(9)}`)
for (const file of files) {
  const path = join(EXPORT_DIR, file)
  const parsed = parseHaePayload(JSON.parse(readFileSync(path, 'utf8')), {
    reportedAt: new Date(statSync(path).mtime),
    source: 'hae_backfill',
  })

  for (const o of parsed.observations) {
    perMetric.set(o.metric, (perMetric.get(o.metric) ?? 0) + 1)
    perYear.set(o.observedOn.slice(0, 4), (perYear.get(o.observedOn.slice(0, 4)) ?? 0) + 1)
    if (!units.has(o.metric)) units.set(o.metric, new Set())
    units.get(o.metric)!.add(o.unit)
  }
  for (const w of parsed.workouts) workoutTypes.set(w.type, (workoutTypes.get(w.type) ?? 0) + 1)
  parsed.uncatalogued.forEach((m) => uncatalogued.add(m))

  totalObs += parsed.observations.length
  totalWorkouts += parsed.workouts.length
  const mb = (statSync(path).size / 1e6).toFixed(1) + 'MB'
  console.log(
    `${file.slice(0, 34).padEnd(34)} ${mb.padStart(7)} ${String(parsed.observations.length).padStart(8)} ${String(parsed.workouts.length).padStart(9)}`,
  )
}

console.log(`\nTOTAL  ${totalObs.toLocaleString()} observations, ${totalWorkouts.toLocaleString()} workouts, ${perMetric.size} distinct metrics`)

console.log('\nobservations per year')
for (const y of [...perYear.keys()].sort()) console.log(`  ${y}  ${String(perYear.get(y)).padStart(7)}`)

const drift = [...units.entries()].filter(([, u]) => u.size > 1)
console.log(`\nmetrics with inconsistent units: ${drift.length}`)
for (const [m, u] of drift) console.log(`  !! ${m}: ${[...u].join(', ')}`)

console.log('\nworkout types')
for (const [t, n] of [...workoutTypes.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${t}`)
}

console.log(`\ntop 12 metrics by volume`)
for (const [m, n] of [...perMetric.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`  ${String(n).padStart(6)}  ${m}`)
}

console.log(`\n${uncatalogued.size} metrics pass through under their HAE name (not renamed):`)
console.log('  ' + [...uncatalogued].sort().join(', '))
