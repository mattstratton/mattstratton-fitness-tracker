// POST /api/hae -- Health Auto Export's REST destination.
//
// Configure in HAE: Automation -> export destination "REST API", URL this
// endpoint, and a header `Authorization: Bearer <HAE_INGEST_TOKEN>`.
//
// Replaces the entire iCloud pipeline: no files, no launchd, no brctl, no mtime
// ordering, and no laptop. See docs/adr/0004.
import { getPool } from '../lib/db.js'
import { json, requireBearer } from '../lib/http.js'
import { writeObservations, writeWorkouts } from '../lib/ingest.js'
import { logIngestRun } from '../lib/liftosaur.js'
import { parseHaePayload } from '../lib/parse/hae.js'

// Non-framework Vercel Functions export a default object with `fetch`, and
// dispatch on the method themselves. Named GET/POST exports are a Next.js
// convention and do not apply here. maxDuration lives in vercel.json.
export default { fetch: handle }

export async function handle(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405)
  }
  const denied = requireBearer(request, 'HAE_INGEST_TOKEN')
  if (denied) return denied

  // Report Time is the moment we received it. Under the old file-based pipeline
  // this had to be inferred from iCloud mtimes, which are unreliable; here it is
  // simply true. It is what orders Restatements.
  const reportedAt = new Date()
  const pool = getPool()

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    await logIngestRun(pool, 'hae', reportedAt, 'error', { message: 'body was not JSON' })
    return json({ error: 'body was not JSON' }, 400)
  }

  try {
    const { observations, workouts, uncatalogued } = parseHaePayload(payload, {
      reportedAt,
      source: 'hae',
    })

    // A payload that parses to nothing is NOT an error -- HAE sends empty
    // arrays for a metric whose HealthKit permission has been revoked, which is
    // exactly the failure that went unnoticed for five days. It is recorded as a
    // successful run that found nothing, and data_freshness is what catches it.
    await writeObservations(pool, observations)
    await writeWorkouts(pool, workouts)

    const metrics = new Set(observations.map((o) => o.metric))
    await logIngestRun(
      pool, 'hae', reportedAt, 'ok',
      { observations: observations.length, workouts: workouts.length, uncatalogued },
      // Count workouts too. HAE splits its exports by data type, so a workouts
      // automation posts a payload with no `metrics` key at all -- logging
      // rows_written: 0 for it would make a successful run look like the
      // delivered-nothing failure this table exists to expose.
      observations.length + workouts.length, metrics.size,
    )

    return json({
      ok: true,
      observations: observations.length,
      workouts: workouts.length,
      metrics: metrics.size,
      // Informational: these still landed, under their own names.
      uncatalogued,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logIngestRun(pool, 'hae', reportedAt, 'error', { message })
    console.error('hae ingest failed:', message)
    // 500 so HAE retries rather than considering the export delivered.
    return json({ error: message }, 500)
  }
}
