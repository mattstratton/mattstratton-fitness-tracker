// Run a query against this repo's database and print a readable table.
//
//   npm run q "SELECT * FROM data_freshness"
//   npm run q -- --json "SELECT * FROM energy_reality_check"
//
// Deliberately NOT the Tiger MCP. That is user-level configuration on a machine
// also used for work, so depending on it would mean either re-pointing it every
// time or leaving a work session able to reach personal health data. This reads
// DATABASE_URL from this repo's .env, so which database it talks to is decided
// by which directory you are in -- which is the only scoping that can't drift.
import { makePool } from '../lib/db.js'

const args = process.argv.slice(2)
const asJson = args[0] === '--json'
const sql = (asJson ? args.slice(1) : args).join(' ').trim()

if (!sql) {
  console.error('usage: npm run q -- [--json] "SELECT ..."')
  process.exit(1)
}

// Read-only by default. A coaching session has no business writing, and a typo
// in a generated query shouldn't be able to.
const WRITE = /^\s*(insert|update|delete|drop|alter|truncate|create|grant|revoke)\b/i
if (WRITE.test(sql) && !process.env['ALLOW_WRITES']) {
  console.error('refusing to run a write. Set ALLOW_WRITES=1 if you really mean it.')
  process.exit(1)
}

const pool = makePool()
try {
  const res = await pool.query(sql)
  if (asJson) {
    console.log(JSON.stringify(res.rows, null, 2))
  } else if (res.rows.length === 0) {
    console.log('(0 rows)')
  } else {
    const cols = Object.keys(res.rows[0] as object)
    const fmt = (v: unknown) =>
      v === null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
    const widths = cols.map((c) =>
      Math.max(c.length, ...res.rows.map((r) => fmt((r as Record<string, unknown>)[c]).length)),
    )
    console.log(cols.map((c, i) => c.padEnd(widths[i]!)).join('  '))
    console.log(widths.map((w) => '-'.repeat(w)).join('  '))
    for (const row of res.rows) {
      console.log(
        cols.map((c, i) => fmt((row as Record<string, unknown>)[c]).padEnd(widths[i]!)).join('  '),
      )
    }
    console.log(`(${res.rows.length} row${res.rows.length === 1 ? '' : 's'})`)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
} finally {
  await pool.end()
}
