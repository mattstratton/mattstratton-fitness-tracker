// Apply db/migrations/*.sql in order, once each.
//
//   DATABASE_URL=... node scripts/migrate.ts
//
// Deliberately tiny. There is no down-migration and no framework: this schema
// is greenfield, and a rollback here means dropping the database and re-running
// the backfill, which takes under a minute.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { makePool } from '../lib/db.ts'

const DIR = 'db/migrations'
const pool = makePool()

await pool.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`)

const applied = new Set(
  (await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations')).rows.map(
    (r) => r.filename,
  ),
)

let ran = 0
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()) {
  if (applied.has(file)) {
    console.log(`  skip  ${file}`)
    continue
  }
  const sql = readFileSync(join(DIR, file), 'utf8')
  // Some statements refuse to run inside a transaction -- notably CREATE
  // MATERIALIZED VIEW ... WITH (timescaledb.continuous). Those files opt out
  // and accept that a mid-file failure leaves partial state.
  const transactional = !sql.includes('migrate:no-transaction')
  const client = await pool.connect()
  try {
    if (transactional) await client.query('BEGIN')
    await client.query(sql)
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
    if (transactional) await client.query('COMMIT')
    console.log(`  apply ${file}${transactional ? '' : '  (no transaction)'}`)
    ran++
  } catch (err) {
    if (transactional) await client.query('ROLLBACK')
    console.error(`  FAIL  ${file}\n${err instanceof Error ? err.message : String(err)}`)
    if (!transactional) console.error('  ^ ran outside a transaction: state may be partial')
    process.exitCode = 1
    break
  } finally {
    client.release()
  }
}

console.log(ran === 0 ? 'nothing to apply' : `${ran} migration(s) applied`)
await pool.end()
