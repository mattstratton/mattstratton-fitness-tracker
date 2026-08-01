// The fetch layer. Loads what the pure signal functions need and nothing more.
//
// Kept separate so lib/signals/* stays free of SQL and testable against
// fixtures. Everything here is read-only.
import { getPool } from './db.js'
import { TARGETS } from './config.js'
import { deficitReality, weightTrend } from './signals/body.js'
import { freshness } from './signals/freshness.js'
import { recentMisses, stalling } from './signals/lifting.js'
import { loggingGaps, proteinAdherence } from './signals/nutrition.js'
import { overreaching } from './signals/recovery.js'
import { parseTiers } from './signals/tiers.js'
import type { Signal } from './signals/types.js'

const day = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[]
}

/** Exercise → tier, from the live program. Returns undefined if unreachable:
 *  a missing hint must degrade the stall rule, never break the page. */
async function liftosaurTiers(): Promise<Map<string, 't1' | 't2' | 't3'> | undefined> {
  const key = process.env['LIFTOSAUR_API_KEY']
  if (!key) return undefined
  try {
    const res = await fetch('https://www.liftosaur.com/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'get_program', arguments: { id: 'current' } },
      }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { result?: { content?: Array<{ text?: string }> } }
    const text = body.result?.content?.[0]?.text
    if (!text) return undefined
    return parseTiers(JSON.parse(text).text as string)
  } catch {
    return undefined
  }
}

export async function loadSignals(): Promise<Signal[]> {
  // Nutrition excludes today: it is a Partial Day and its intake is whatever has
  // been logged so far.
  const [nut, rec, wt, er, fr, sets, tiers] = await Promise.all([
    rows<Record<string, unknown>>(
      `SELECT observed_on, calories, protein_g FROM nutrition
       WHERE observed_on BETWEEN today_local() - 7 AND today_local() - 1 ORDER BY 1`,
    ),
    rows<Record<string, unknown>>(
      `SELECT observed_on, resting_hr, hrv_ms FROM recovery
       WHERE observed_on > today_local() - 63 ORDER BY 1`,
    ),
    rows<Record<string, unknown>>('SELECT * FROM weight_trend'),
    rows<Record<string, unknown>>('SELECT * FROM energy_reality_check'),
    rows<Record<string, unknown>>('SELECT * FROM data_freshness'),
    rows<Record<string, unknown>>(
      `SELECT performed_on, record_id, exercise, set_index, reps, weight_lbs, target_reps, is_amrap
       FROM lifting_sets WHERE performed_on > today_local() - 60 ORDER BY performed_on`,
    ),
    liftosaurTiers(),
  ])

  const nutrition = nut.map((r) => ({
    observedOn: day(r['observed_on']), calories: num(r['calories']), proteinG: num(r['protein_g']),
  }))
  const recovery = rec.map((r) => ({
    observedOn: day(r['observed_on']), restingHr: num(r['resting_hr']), hrvMs: num(r['hrv_ms']),
  }))
  const trend = wt.map((r) => ({
    days: Number(r['days']), weighIns: Number(r['weigh_ins']), lbsPerWeek: num(r['lbs_per_week']),
  }))
  const energy = er.map((r) => ({
    windowDays: Number(r['window_days']), coveragePct: Number(r['coverage_pct']),
    avgNetKcal: num(r['avg_net_kcal']), impliedLbsPerWeek: num(r['implied_lbs_per_week']),
    actualLbsPerWeek: num(r['actual_lbs_per_week']), overstatementFactor: num(r['overstatement_factor']),
  }))
  const fresh = fr.map((r) => ({
    label: String(r['label']), latest: r['latest'] ? day(r['latest']) : null,
    ageDays: num(r['age_days']), status: r['status'] as 'fresh' | 'partial' | 'stale' | 'missing',
    automatic: Boolean(r['automatic']), maxAgeDays: Number(r['max_age_days']),
  }))
  const lifting = sets.map((r) => ({
    performedOn: day(r['performed_on']), recordId: Number(r['record_id']),
    exercise: String(r['exercise']), setIndex: Number(r['set_index']), reps: Number(r['reps']),
    weightLbs: num(r['weight_lbs']), targetReps: num(r['target_reps']),
    isAmrap: r['is_amrap'] === null ? null : Boolean(r['is_amrap']),
  }))

  // Freshness first: everything below it is coached on whatever it reports.
  return [
    freshness(fresh),
    proteinAdherence(nutrition, TARGETS),
    weightTrend(trend, TARGETS),
    deficitReality(energy, TARGETS),
    stalling(lifting, tiers),
    overreaching(recovery),
    recentMisses(lifting),
    loggingGaps(nutrition),
  ]
}

export type Point = { observedOn: string; value: number }

/** A metric as a dated series. Gaps are simply absent rows — never zeros. */
export async function loadSeries(metric: string, days: number): Promise<Point[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT observed_on, value FROM observations_daily
     WHERE metric = $1 AND observed_on > today_local() - $2::int ORDER BY observed_on`,
    [metric, days],
  )
  return r.map((x) => ({ observedOn: day(x['observed_on']), value: Number(x['value']) }))
}

export async function loadToday(): Promise<{
  weightLbs: number | null
  proteinG: number | null
  caloriesIn: number | null
  steps: number | null
  lastSession: { observedOn: string; label: string | null; setCount: number | null } | null
}> {
  const [metrics, session] = await Promise.all([
    rows<Record<string, unknown>>(
      `SELECT metric, value FROM observations_daily
       WHERE observed_on = today_local()
         AND metric IN ('weight_lbs','protein_g','calories','steps')`,
    ),
    rows<Record<string, unknown>>(
      `SELECT observed_on, label, set_count FROM training_sessions
       WHERE kind = 'lifting' ORDER BY started_at DESC LIMIT 1`,
    ),
  ])
  const get = (m: string) => num(metrics.find((r) => r['metric'] === m)?.['value'])
  const s = session[0]
  return {
    weightLbs: get('weight_lbs'),
    proteinG: get('protein_g'),
    caloriesIn: get('calories'),
    steps: get('steps'),
    lastSession: s
      ? { observedOn: day(s['observed_on']), label: s['label'] as string | null, setCount: num(s['set_count']) }
      : null,
  }
}
