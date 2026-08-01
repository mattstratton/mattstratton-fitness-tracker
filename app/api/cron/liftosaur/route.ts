// GET /api/cron/liftosaur -- scheduled pull of Liftosaur history.
//
// Liftosaur is a pull, not a push, so it needs a scheduler. This is the only
// piece of the old launchd agent that survives, and it survives as a cron.
import { getPool } from '../../../../lib/db.js'
import { json, requireBearer } from '../../../../lib/http.js'
import { logIngestRun, syncLiftosaur } from '../../../../lib/liftosaur.js'

export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  // Vercel sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations.
  // Without this the route is a public URL that hammers the Liftosaur API.
  const denied = requireBearer(request, 'CRON_SECRET')
  if (denied) return denied

  const apiKey = process.env['LIFTOSAUR_API_KEY']
  if (!apiKey) return json({ error: 'LIFTOSAUR_API_KEY is not set' }, 500)

  const pool = getPool()
  const startedAt = new Date()
  try {
    const r = await syncLiftosaur(pool, apiKey)
    await logIngestRun(pool, 'liftosaur', startedAt, 'ok', r, r.setsWritten, r.recordsSeen)
    return json({ ok: true, ...r })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logIngestRun(pool, 'liftosaur', startedAt, 'error', { message })
    console.error('liftosaur sync failed:', message)
    return json({ error: message }, 500)
  }
}
