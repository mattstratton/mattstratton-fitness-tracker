// Pull Liftosaur history into Tiger Cloud.
//
//   node scripts/sync-liftosaur.ts
//
// Thin wrapper: the logic lives in lib/liftosaur.ts so the Vercel cron runs
// exactly the same code path.
import { loadEnv, makePool } from '../lib/db.ts'
import { logIngestRun, syncLiftosaur } from '../lib/liftosaur.ts'

loadEnv()
const apiKey = process.env['LIFTOSAUR_API_KEY']
if (!apiKey) {
  console.error('LIFTOSAUR_API_KEY is not set (Liftosaur app -> Settings -> API Keys)')
  process.exit(1)
}

const pool = makePool()
const startedAt = new Date()

try {
  const r = await syncLiftosaur(pool, apiKey)
  await logIngestRun(pool, 'liftosaur', startedAt, 'ok', r, r.setsWritten, r.recordsSeen)
  console.log(
    `liftosaur: ${r.recordsSeen} records seen, ${r.recordsChanged} changed ` +
    `(${r.setsWritten} sets written), ${r.recordsPruned} pruned`,
  )
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  // Log the failure before exiting, so a run that found nothing is
  // distinguishable from a run that never happened.
  await logIngestRun(pool, 'liftosaur', startedAt, 'error', { message })
  console.error(`ERROR [liftosaur]: ${message}`)
  process.exitCode = 1
} finally {
  await pool.end()
}
