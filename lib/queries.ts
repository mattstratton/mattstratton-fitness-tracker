// The fetch layer. Loads what the pure signal functions need and nothing more.
//
// Kept separate so lib/signals/* stays free of SQL and testable against
// fixtures. Almost everything here is read-only; saveTargets is the one
// exception, for the /settings page.
import { getPool } from './db.js'
import type { Phase, Targets } from './config.js'
import { nextWorkoutDay, parseProgramDays } from './liftoscriptProgram.js'
import { activityTrend } from './signals/activity.js'
import { deficitReality, weightTrend } from './signals/body.js'
import { freshness } from './signals/freshness.js'
import { recentMisses, stalling } from './signals/lifting.js'
import { calorieAdherence, loggingGaps, proteinAdherence } from './signals/nutrition.js'
import { overreaching } from './signals/recovery.js'
import { parseTiers } from './signals/tiers.js'
import type { LiftingSetRow, Signal } from './signals/types.js'

const day = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v)
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[]
}

/** Raw fetch of the live Liftoscript program source, bypassing a proper MCP
 *  client (there isn't one wired up server-side). Returns undefined on any
 *  failure -- a missing hint must degrade, never break the page. Shared by
 *  liftosaurTiers() and loadNextWorkoutPreview(), which both need the same
 *  program text for different purposes. */
async function fetchLiftoscriptProgram(): Promise<{ name: string; text: string } | undefined> {
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
    const parsed = JSON.parse(text) as { name?: string; text?: string }
    if (!parsed.text) return undefined
    return { name: parsed.name ?? '', text: parsed.text }
  } catch {
    return undefined
  }
}

/** Exercise → tier, from the live program. Returns undefined if unreachable:
 *  a missing hint must degrade the stall rule, never break the page. */
async function liftosaurTiers(): Promise<Map<string, 't1' | 't2' | 't3'> | undefined> {
  const program = await fetchLiftoscriptProgram()
  return program ? parseTiers(program.text) : undefined
}

export type NextWorkoutPreview = {
  dayName: string
  exercises: Array<{ tier: 't1' | 't2' | 't3' | null; name: string; weightLbs: number | null; sets: string | null }>
}

/**
 * The next day in the live program's rotation, with its prescribed
 * exercises/weights -- the derived fallback for the "next workout" preview,
 * since run_playground doesn't work (docs/migration-log.md: every argument
 * shape returns `exercises: {}` even though `stats` is correct).
 *
 * Wrapped in a single try/catch: this inherits liftosaurTiers()'s "a missing
 * hint must degrade, never break the page" contract for the new SQL query
 * here too, not just the fetch.
 */
export async function loadNextWorkoutPreview(): Promise<NextWorkoutPreview | undefined> {
  try {
    const program = await fetchLiftoscriptProgram()
    if (!program) return undefined
    const days = parseProgramDays(program.text)
    if (days.length === 0) return undefined

    // lifting_records.day_name, not training_sessions.label -- the view can
    // still show Apple Health's generic fallback label for a session the
    // sync-liftosaur cron hasn't picked up yet. Filtered by the CURRENT
    // program's name so a travel-week interruption (a real thing that has
    // happened) resumes the cycle where it left off instead of restarting it.
    const r = await rows<Record<string, unknown>>(
      `SELECT day_name FROM lifting_records WHERE program = $1 ORDER BY started_at DESC LIMIT 1`,
      [program.name],
    )
    const lastDayName = r[0] ? (r[0]['day_name'] as string | null) : null
    const next = nextWorkoutDay(days, lastDayName)
    if (!next) return undefined

    return {
      dayName: next.name,
      exercises: next.exercises.map((e) => ({
        tier: e.tier, name: e.name, weightLbs: e.weightLbs, sets: e.sets,
      })),
    }
  } catch {
    return undefined
  }
}

export type TargetRow = Targets & { id: number; effectiveOn: string; note: string | null }

/** Current nutrition targets: the latest row whose effective_on has arrived. */
export async function loadTargets(): Promise<Targets> {
  const r = await rows<Record<string, unknown>>(
    `SELECT phase, protein_g, calories, expected, concerning FROM nutrition_targets
     WHERE effective_on <= today_local() ORDER BY effective_on DESC, created_at DESC LIMIT 1`,
  )
  const t = r[0]!
  return {
    phase: t['phase'] as Phase,
    proteinG: Number(t['protein_g']),
    calories: num(t['calories']),
    expected: Number(t['expected']),
    concerning: Number(t['concerning']),
  }
}

/** Recent target changes, most recent first -- for the /settings history list. */
export async function loadTargetHistory(limit = 10): Promise<TargetRow[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT id, phase, protein_g, calories, expected, concerning, effective_on, note
     FROM nutrition_targets ORDER BY effective_on DESC, created_at DESC LIMIT $1`,
    [limit],
  )
  return r.map((t) => ({
    id: Number(t['id']),
    phase: t['phase'] as Phase,
    proteinG: Number(t['protein_g']),
    calories: num(t['calories']),
    expected: Number(t['expected']),
    concerning: Number(t['concerning']),
    effectiveOn: day(t['effective_on']),
    note: t['note'] as string | null,
  }))
}

/**
 * Append a new nutrition targets row -- never an update, same reasoning as
 * observations (docs/adr/0001). `effective_on` defaults to today_local() in
 * the schema, so this always takes effect immediately.
 */
export async function saveTargets(input: {
  phase: Phase
  proteinG: number
  calories: number | null
  expected: number
  concerning: number
  note?: string | null
}): Promise<void> {
  await getPool().query(
    `INSERT INTO nutrition_targets (phase, protein_g, calories, expected, concerning, note)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.phase, input.proteinG, input.calories, input.expected, input.concerning, input.note ?? null],
  )
}

export async function loadSignals(): Promise<Signal[]> {
  // Nutrition excludes today: it is a Partial Day and its intake is whatever has
  // been logged so far.
  const [nut, rec, wt, er, fr, sets, steps, tiers, targets] = await Promise.all([
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
    rows<Record<string, unknown>>(
      `SELECT observed_on, value FROM observations_daily
       WHERE metric = 'steps' AND observed_on > today_local() - 90 AND observed_on < today_local()
       ORDER BY observed_on`,
    ),
    liftosaurTiers(),
    loadTargets(),
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
  const activity = steps.map((r) => ({ observedOn: day(r['observed_on']), steps: Number(r['value']) }))

  // Freshness first: everything below it is coached on whatever it reports.
  return [
    freshness(fresh),
    proteinAdherence(nutrition, targets),
    calorieAdherence(nutrition, targets),
    weightTrend(trend, targets),
    deficitReality(energy, targets),
    stalling(lifting, tiers),
    overreaching(recovery),
    activityTrend(activity),
    recentMisses(lifting),
    loggingGaps(nutrition),
  ]
}

export type Point = { observedOn: string; value: number }

export type SleepNight = {
  observedOn: string
  ageDays: number
  asleepMin: number | null
  inBedMin: number | null
  coreMin: number | null
  deepMin: number | null
  remMin: number | null
  awakeMin: number | null
}

/** Most recent night on record, however old, with its age in days. Sleep has
 *  ~7% coverage so "most recent" can be stale for a while -- this never hides
 *  or judges that; callers decide what to do with ageDays. */
export async function loadLatestSleep(): Promise<SleepNight | null> {
  const r = await rows<Record<string, unknown>>(
    `SELECT observed_on, (today_local() - observed_on) AS age_days,
            asleep_min, in_bed_min, core_min, deep_min, rem_min, awake_min
     FROM sleep
     WHERE asleep_min IS NOT NULL AND observed_on < today_local()
     ORDER BY observed_on DESC LIMIT 1`,
  )
  const row = r[0]
  if (!row) return null
  return {
    observedOn: day(row['observed_on']),
    ageDays: Number(row['age_days']),
    asleepMin: num(row['asleep_min']),
    inBedMin: num(row['in_bed_min']),
    coreMin: num(row['core_min']),
    deepMin: num(row['deep_min']),
    remMin: num(row['rem_min']),
    awakeMin: num(row['awake_min']),
  }
}

/** A metric as a dated series. Gaps are simply absent rows — never zeros. */
export async function loadSeries(metric: string, days: number): Promise<Point[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT observed_on, value FROM observations_daily
     WHERE metric = $1 AND observed_on > today_local() - $2::int AND observed_on < today_local()
     ORDER BY observed_on`,
    [metric, days],
  )
  return r.map((x) => ({ observedOn: day(x['observed_on']), value: Number(x['value']) }))
}

/** Today's date, for the chart's "today (partial)" marker -- charts must not
 *  read the clock themselves, so this is the one place that does. */
export async function loadTodayDate(): Promise<string> {
  const r = await rows<Record<string, unknown>>(`SELECT today_local() AS d`)
  return day(r[0]!['d'])
}

/**
 * Regression for the weight chart's trend overlay, over the EXACT window
 * the chart is displaying -- not weight_trend's fixed 14/28/90-day windows,
 * which have no intercept and can't draw a line over an arbitrary range.
 * Excludes the same outliers weight_trend does. Null when there are too few
 * points to fit a trend (mirrors weight_trend's own HAVING count(*) >= 3).
 */
export async function loadWeightTrendLine(
  days: number,
): Promise<{ slope: number; intercept: number; referenceDate: string } | null> {
  const r = await rows<Record<string, unknown>>(
    `SELECT
       regr_slope(o.value, (o.observed_on - today_local())::int) AS slope,
       regr_intercept(o.value, (o.observed_on - today_local())::int) AS intercept,
       count(*) AS n,
       today_local() AS reference_date
     FROM observations_daily o
     WHERE o.metric = 'weight_lbs'
       AND o.observed_on > today_local() - $1::int
       -- Strictly less than today: today is a Partial Day everywhere else in
       -- this app, and observations_daily is specifically unreliable for it.
       AND o.observed_on < today_local()
       AND NOT EXISTS (
         SELECT 1 FROM weight_outliers x WHERE x.observed_on = o.observed_on
       )`,
    [days],
  )
  const row = r[0]
  if (!row || Number(row['n']) < 3 || row['slope'] === null) return null
  return {
    slope: Number(row['slope']),
    intercept: Number(row['intercept']),
    referenceDate: day(row['reference_date']),
  }
}

export type LiftingSessionSummary = {
  recordId: number
  observedOn: string
  startedAt: string
  program: string | null
  label: string | null
  durationMin: number | null
  energyKcal: number | null
  setCount: number
}

/** Recent lifting sessions with real metadata -- training_sessions doesn't
 *  expose record_id directly, so this joins back to lifting_records on
 *  started_at (exact, not fuzzy: the view passes r.started_at through
 *  unchanged for lifting rows). Flat LIMIT, no pagination -- matches
 *  /settings' loadTargetHistory(limit = 10) precedent for a history list in
 *  this single-user app. */
export async function loadRecentLiftingSessions(limit = 20): Promise<LiftingSessionSummary[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT r.record_id, ts.observed_on, ts.started_at, ts.program, ts.label,
            ts.duration_min, ts.energy_kcal, ts.set_count
     FROM lifting_records r
     JOIN training_sessions ts ON ts.kind = 'lifting' AND ts.started_at = r.started_at
     ORDER BY r.started_at DESC
     LIMIT $1`,
    [limit],
  )
  return r.map((row) => ({
    recordId: Number(row['record_id']),
    observedOn: day(row['observed_on']),
    startedAt: String(row['started_at']),
    program: row['program'] as string | null,
    label: row['label'] as string | null,
    durationMin: num(row['duration_min']),
    energyKcal: num(row['energy_kcal']),
    setCount: Number(row['set_count']),
  }))
}

/** Full ordered set log for a batch of sessions -- the /workouts history
 *  section's set-by-set detail. Short-circuits on an empty array rather than
 *  sending `= ANY('{}')` to the pool. */
export async function loadLiftingSetsForRecords(recordIds: number[]): Promise<LiftingSetRow[]> {
  if (recordIds.length === 0) return []
  const r = await rows<Record<string, unknown>>(
    `SELECT performed_on, record_id, exercise, set_index, reps, weight_lbs, target_reps, is_amrap
     FROM lifting_sets
     WHERE record_id = ANY($1::bigint[])
     ORDER BY record_id, exercise, set_index`,
    [recordIds],
  )
  return r.map((row) => ({
    performedOn: day(row['performed_on']), recordId: Number(row['record_id']),
    exercise: String(row['exercise']), setIndex: Number(row['set_index']), reps: Number(row['reps']),
    weightLbs: num(row['weight_lbs']), targetReps: num(row['target_reps']),
    isAmrap: row['is_amrap'] === null ? null : Boolean(row['is_amrap']),
  }))
}

export async function loadToday(): Promise<{
  weightLbs: number | null
  proteinG: number | null
  caloriesIn: number | null
  steps: number | null
  lastSession: { observedOn: string; label: string | null; setCount: number | null; recordId: number } | null
}> {
  const [metrics, session] = await Promise.all([
    // Today comes from the RAW Report log, not observations_daily.
    //
    // Once the continuous aggregate has materialised a bucket it stops
    // consulting raw rows for it, so a Report arriving later the same day is
    // invisible until the next refresh. That produced a real wrong answer: the
    // page said 688 kcal while MacroFactor and the raw log both said 1556.
    //
    // The refresh policy is now wide enough that today should never be
    // materialised (see 0008), but "today is correct" is too important to rest
    // on a watermark rule that has already been misjudged twice. Reading raw
    // makes it true by construction, and last(value, reported_at) is exactly
    // what DISTINCT ON ... ORDER BY reported_at DESC computes.
    rows<Record<string, unknown>>(
      `SELECT DISTINCT ON (metric) metric, value FROM observations
       WHERE observed_on = today_local()
         AND metric IN ('weight_lbs','protein_g','calories','steps')
       ORDER BY metric, reported_at DESC`,
    ),
    // training_sessions doesn't expose record_id directly (see
    // loadRecentLiftingSessions) -- same lifting_records join, needed here so
    // the glance page's "Last session" line can link to the right session.
    rows<Record<string, unknown>>(
      `SELECT r.record_id, ts.observed_on, ts.label, ts.set_count
       FROM lifting_records r
       JOIN training_sessions ts ON ts.kind = 'lifting' AND ts.started_at = r.started_at
       ORDER BY r.started_at DESC LIMIT 1`,
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
      ? {
          observedOn: day(s['observed_on']), label: s['label'] as string | null,
          setCount: num(s['set_count']), recordId: Number(s['record_id']),
        }
      : null,
  }
}
