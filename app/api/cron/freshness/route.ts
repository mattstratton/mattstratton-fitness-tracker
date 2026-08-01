// GET /api/cron/freshness -- is the data actually current?
//
// The whole reason this exists: sync_log reported ok every hour for five days
// while an iOS update had silently dropped HealthKit read permission for weight.
// Every run genuinely succeeded and genuinely delivered nothing. So this asks
// about data recency and never looks at run status.
//
// Also reachable by hand, and `npm run q "SELECT * FROM data_freshness"` does
// the same locally.
import { getPool } from '../../../../lib/db.js'
import { json, requireBearer } from '../../../../lib/http.js'

type FreshnessRow = {
  label: string
  latest: string | null
  age_days: number | null
  status: 'fresh' | 'partial' | 'stale' | 'missing'
  automatic: boolean
  max_age_days: number
}

export const maxDuration = 60

export async function GET(request: Request): Promise<Response> {
  const denied = requireBearer(request, 'CRON_SECRET')
  if (denied) return denied

  const { rows } = await getPool().query<FreshnessRow>('SELECT * FROM data_freshness')

  // Automatic sources are Watch-written, so a gap is always a broken pipeline.
  // User-driven ones need Matty to log food or stand on a scale, so a gap may
  // just be travel -- those warn and never fail.
  const broken = rows.filter((r) => r.automatic && (r.status === 'stale' || r.status === 'missing'))
  const warnings = rows.filter((r) => !r.automatic && (r.status === 'stale' || r.status === 'missing'))

  return json(
    {
      ok: broken.length === 0,
      broken: broken.map((r) => `${r.label} (${r.age_days ?? '-'}d, expected within ${r.max_age_days}d)`),
      warnings: warnings.map((r) => `${r.label} (${r.age_days ?? '-'}d)`),
      sources: rows,
    },
    // Non-2xx so Vercel marks the cron run as failed and it surfaces somewhere,
    // rather than a silent "success" that reports a broken pipeline in its body.
    broken.length === 0 ? 200 : 503,
  )
}
