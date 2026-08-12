// The fetch layer. Loads what the pure signal functions need and nothing more.
//
// Kept separate so lib/signals/* stays free of SQL and testable against
// fixtures. Almost everything here is read-only; saveTargets is the one
// exception, for the /settings page.
import { getPool } from './db.js'
import type { Phase, Targets } from './config.js'
import { nextWorkoutDay, parseProgramDays } from './liftoscriptProgram.js'
import { activityTrend, exerciseAdherence } from './signals/activity.js'
import { deficitReality, weightTrend } from './signals/body.js'
import { freshness } from './signals/freshness.js'
import { recentMisses, stalling } from './signals/lifting.js'
import { calorieAdherence, loggingGaps, proteinAdherence } from './signals/nutrition.js'
import { overreaching } from './signals/recovery.js'
import { parseTiers } from './signals/tiers.js'
import type { FreshnessRow, LiftingSetRow, Signal } from './signals/types.js'

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

export type ExerciseTargetRow = { id: number; minutesTarget: number; effectiveOn: string; note: string | null }

/** Current exercise-minutes target: the latest row whose effective_on has arrived. */
export async function loadExerciseTarget(): Promise<{ minutesTarget: number }> {
  const r = await rows<Record<string, unknown>>(
    `SELECT minutes_target FROM exercise_targets
     WHERE effective_on <= today_local() ORDER BY effective_on DESC, created_at DESC LIMIT 1`,
  )
  return { minutesTarget: Number(r[0]!['minutes_target']) }
}

/** Recent target changes, most recent first -- for the /settings history list. */
export async function loadExerciseTargetHistory(limit = 10): Promise<ExerciseTargetRow[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT id, minutes_target, effective_on, note
     FROM exercise_targets ORDER BY effective_on DESC, created_at DESC LIMIT $1`,
    [limit],
  )
  return r.map((t) => ({
    id: Number(t['id']),
    minutesTarget: Number(t['minutes_target']),
    effectiveOn: day(t['effective_on']),
    note: t['note'] as string | null,
  }))
}

/** Append a new exercise target row -- never an update, same reasoning as
 *  nutrition_targets/observations (docs/adr/0001). */
export async function saveExerciseTarget(input: { minutesTarget: number; note?: string | null }): Promise<void> {
  await getPool().query(
    `INSERT INTO exercise_targets (minutes_target, note) VALUES ($1, $2)`,
    [input.minutesTarget, input.note ?? null],
  )
}

/**
 * Per-source recency, as `data_freshness` reports it.
 *
 * Extracted out of loadSignals() because the coaching chat needs the same rows
 * for its runtime-context block -- freshness has to be in front of any answer,
 * not fetched only when a signal is being graded. Never judge freshness from
 * `ingest_runs`: that records that a run happened, and the failure this system
 * exists to catch is a run that succeeds and delivers nothing.
 */
export async function loadFreshness(): Promise<FreshnessRow[]> {
  const r = await rows<Record<string, unknown>>('SELECT * FROM data_freshness')
  return r.map((x) => ({
    label: String(x['label']), latest: x['latest'] ? day(x['latest']) : null,
    ageDays: num(x['age_days']), status: x['status'] as FreshnessRow['status'],
    automatic: Boolean(x['automatic']), maxAgeDays: Number(x['max_age_days']),
  }))
}

export async function loadSignals(): Promise<Signal[]> {
  // Nutrition excludes today: it is a Partial Day and its intake is whatever has
  // been logged so far.
  const [nut, rec, wt, er, fr, sets, steps, exerciseMin, tiers, targets, exerciseTarget] = await Promise.all([
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
    loadFreshness(),
    rows<Record<string, unknown>>(
      `SELECT performed_on, record_id, exercise, set_index, reps, weight_lbs, target_reps, is_amrap
       FROM lifting_sets WHERE performed_on > today_local() - 60 ORDER BY performed_on`,
    ),
    rows<Record<string, unknown>>(
      `SELECT observed_on, value FROM observations_daily
       WHERE metric = 'steps' AND observed_on > today_local() - 90 AND observed_on < today_local()
       ORDER BY observed_on`,
    ),
    rows<Record<string, unknown>>(
      `SELECT observed_on, value FROM observations_daily
       WHERE metric = 'exercise_minutes' AND observed_on BETWEEN today_local() - 7 AND today_local() - 1
       ORDER BY observed_on`,
    ),
    liftosaurTiers(),
    loadTargets(),
    loadExerciseTarget(),
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
  const lifting = sets.map((r) => ({
    performedOn: day(r['performed_on']), recordId: Number(r['record_id']),
    exercise: String(r['exercise']), setIndex: Number(r['set_index']), reps: Number(r['reps']),
    weightLbs: num(r['weight_lbs']), targetReps: num(r['target_reps']),
    isAmrap: r['is_amrap'] === null ? null : Boolean(r['is_amrap']),
  }))
  const activity = steps.map((r) => ({ observedOn: day(r['observed_on']), steps: Number(r['value']) }))
  const exerciseMinutes = exerciseMin.map((r) => ({ observedOn: day(r['observed_on']), minutes: Number(r['value']) }))

  // Freshness first: everything below it is coached on whatever it reports.
  return [
    freshness(fr),
    proteinAdherence(nutrition, targets),
    calorieAdherence(nutrition, targets),
    weightTrend(trend, targets),
    deficitReality(energy, targets),
    stalling(lifting, tiers),
    overreaching(recovery),
    activityTrend(activity),
    exerciseAdherence(exerciseMinutes, exerciseTarget.minutesTarget),
    recentMisses(lifting),
    loggingGaps(nutrition),
  ]
}

// ---- Loaders behind the coaching chat's tools -------------------------------
//
// Every windowed loader below EXCLUDES today by construction, and gaps are
// absent rows rather than zeros. That is not tidiness: an LLM handed a window of
// days will average whatever it is given, and the two most likely wrong answers
// this chat can produce are "your average intake is 900 kcal" (today, half
// logged) and "you fasted on Tuesday" (Tuesday, unlogged). Prompt text mitigates
// that; the shape of the data forecloses it. loadToday() is the only route to
// today's numbers and its tool labels them partial. See docs/adr/0006.

export type NutritionDayFull = {
  observedOn: string
  calories: number | null
  proteinG: number | null
  carbsG: number | null
  fatG: number | null
  fiberG: number | null
}

/** Complete days only, most recent last. Unlogged days are simply absent. */
export async function loadNutritionDays(days: number): Promise<NutritionDayFull[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT observed_on, calories, protein_g, carbs_g, fat_g, fiber_g FROM nutrition
     WHERE observed_on > today_local() - $1::int AND observed_on < today_local()
     ORDER BY observed_on`,
    [days],
  )
  return r.map((x) => ({
    observedOn: day(x['observed_on']), calories: num(x['calories']), proteinG: num(x['protein_g']),
    carbsG: num(x['carbs_g']), fatG: num(x['fat_g']), fiberG: num(x['fiber_g']),
  }))
}

export type RecoveryDayFull = {
  observedOn: string
  restingHr: number | null
  hrvMs: number | null
  bloodOxygenPct: number | null
  respiratoryRate: number | null
}

export async function loadRecoveryDays(days: number): Promise<RecoveryDayFull[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT observed_on, resting_hr, hrv_ms, blood_oxygen_pct, respiratory_rate FROM recovery
     WHERE observed_on > today_local() - $1::int AND observed_on < today_local()
     ORDER BY observed_on`,
    [days],
  )
  return r.map((x) => ({
    observedOn: day(x['observed_on']), restingHr: num(x['resting_hr']), hrvMs: num(x['hrv_ms']),
    bloodOxygenPct: num(x['blood_oxygen_pct']), respiratoryRate: num(x['respiratory_rate']),
  }))
}

export type TrainingSessionRow = {
  observedOn: string
  kind: string
  label: string | null
  program: string | null
  durationMin: number | null
  energyKcal: number | null
  setCount: number | null
}

/**
 * The RECONCILED account of training. `health_workouts` is deliberately not
 * reachable from any tool: Apple shadow-copies every Liftosaur session, so
 * counting it answers "how much did I train" with roughly double the truth.
 */
export async function loadTrainingSessions(days: number): Promise<TrainingSessionRow[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT observed_on, kind, label, program, duration_min, energy_kcal, set_count
     FROM training_sessions
     WHERE observed_on > today_local() - $1::int AND observed_on < today_local()
     ORDER BY observed_on DESC, started_at DESC`,
    [days],
  )
  return r.map((x) => ({
    observedOn: day(x['observed_on']), kind: String(x['kind']), label: x['label'] as string | null,
    program: x['program'] as string | null, durationMin: num(x['duration_min']),
    energyKcal: num(x['energy_kcal']), setCount: num(x['set_count']),
  }))
}

/** Working sets over a window, optionally for one exercise. `reps = 0` is a
 *  failed set -- a real training event, not missing data. */
export async function loadLiftingSetsByExercise(
  exercise: string | null,
  days: number,
): Promise<LiftingSetRow[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT performed_on, record_id, exercise, set_index, reps, weight_lbs, target_reps, is_amrap
     FROM lifting_sets
     WHERE performed_on > today_local() - $1::int
       AND ($2::text IS NULL OR exercise ILIKE $2)
     ORDER BY performed_on, exercise, set_index`,
    [days, exercise],
  )
  return r.map((x) => ({
    performedOn: day(x['performed_on']), recordId: Number(x['record_id']),
    exercise: String(x['exercise']), setIndex: Number(x['set_index']), reps: Number(x['reps']),
    weightLbs: num(x['weight_lbs']), targetReps: num(x['target_reps']),
    isAmrap: x['is_amrap'] === null ? null : Boolean(x['is_amrap']),
  }))
}

/** Distinct exercise names in the log, so the chat can resolve "squat" to
 *  whatever Liftosaur actually calls it instead of guessing and finding
 *  nothing. */
export async function loadExerciseNames(days: number): Promise<string[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT DISTINCT exercise FROM lifting_sets
     WHERE performed_on > today_local() - $1::int ORDER BY exercise`,
    [days],
  )
  return r.map((x) => String(x['exercise']))
}

export type WeightTrendSummary = {
  windows: Array<{ days: number; weighIns: number; lbsPerWeek: number | null }>
  excludedOutliers: Array<{ observedOn: string; valueLb: number; pctOff: number }>
}

/**
 * Rate of change by regression, plus the readings it threw out.
 *
 * The two travel together on purpose. A single weigh-in is noise -- water,
 * sodium, time of day -- and the outlier list is the evidence that the trend is
 * the honest number rather than a cherry-pick. There is no tool that returns a
 * bare weight reading.
 */
export async function loadWeightTrendSummary(): Promise<WeightTrendSummary> {
  const [wt, out] = await Promise.all([
    rows<Record<string, unknown>>('SELECT * FROM weight_trend ORDER BY days'),
    rows<Record<string, unknown>>(
      `SELECT observed_on, value_lb, pct_off FROM weight_outliers
       WHERE observed_on > today_local() - 90 ORDER BY observed_on DESC`,
    ),
  ])
  return {
    windows: wt.map((x) => ({
      days: Number(x['days']), weighIns: Number(x['weigh_ins']), lbsPerWeek: num(x['lbs_per_week']),
    })),
    excludedOutliers: out.map((x) => ({
      observedOn: day(x['observed_on']), valueLb: Number(x['value_lb']), pctOff: Number(x['pct_off']),
    })),
  }
}

export type EnergyBalanceSummary = {
  caveat: string
  days: Array<{ observedOn: string; caloriesIn: number | null; caloriesOut: number | null; netKcal: number | null }>
  realityCheck: Array<{
    windowDays: number
    daysLogged: number
    coveragePct: number
    avgNetKcal: number | null
    impliedLbsPerWeek: number | null
    actualLbsPerWeek: number | null
    overstatementFactor: number | null
  }>
}

/**
 * Intake vs Apple's expenditure -- and, in the SAME payload, how far that
 * disagrees with the scale.
 *
 * These cannot be fetched separately, because `energy_balance` alone overstates
 * the deficit by roughly 2.6x and reads like a measurement. Apple's basal figure
 * is a formula estimate and watch active energy runs generous; their difference
 * is arithmetic on two guesses. Use it for DIRECTION and `weight_trend` for
 * MAGNITUDE. Rows with low `coveragePct` mean days weren't logged, not that
 * nothing was eaten.
 */
export async function loadEnergyBalance(days: number): Promise<EnergyBalanceSummary> {
  const [eb, erc] = await Promise.all([
    rows<Record<string, unknown>>(
      `SELECT observed_on, calories_in, calories_out, net_kcal FROM energy_balance
       WHERE observed_on > today_local() - $1::int AND observed_on < today_local()
       ORDER BY observed_on`,
      [days],
    ),
    rows<Record<string, unknown>>('SELECT * FROM energy_reality_check ORDER BY window_days'),
  ])
  return {
    caveat:
      'energy_balance overstates the deficit by roughly 2.6x: Apple basal is a formula estimate ' +
      'and watch active energy runs generous, so net_kcal is arithmetic on two guesses, not a ' +
      'measurement. Use it for direction only and take magnitude from get_weight_trend. Ignore ' +
      'realityCheck rows with low coveragePct -- those are logging gaps, not fasting.',
    days: eb.map((x) => ({
      observedOn: day(x['observed_on']), caloriesIn: num(x['calories_in']),
      caloriesOut: num(x['calories_out']), netKcal: num(x['net_kcal']),
    })),
    realityCheck: erc.map((x) => ({
      windowDays: Number(x['window_days']), daysLogged: Number(x['days_logged']),
      coveragePct: Number(x['coverage_pct']), avgNetKcal: num(x['avg_net_kcal']),
      impliedLbsPerWeek: num(x['implied_lbs_per_week']), actualLbsPerWeek: num(x['actual_lbs_per_week']),
      overstatementFactor: num(x['overstatement_factor']),
    })),
  }
}

export type MetricIndexRow = {
  metric: string
  displayName: string | null
  canonicalUnit: string | null
  attention: string | null
  /** False when the metric has data but no `metric_catalog` entry -- see below. */
  catalogued: boolean
  /** Days with an Observation in the last 365. Coverage, before conclusions. */
  days365: number
  /** Most recent Observed Day, all-time. Present-but-stale is visible here. */
  latest: string
}

/**
 * Every metric that actually has data, with its unit when one is known.
 *
 * Driven from `observations_daily`, LEFT JOINed onto `metric_catalog` -- not the
 * other way round. The catalog covers 38 of the 81 metrics on record; the other
 * 43 land under their own names anyway (the HAE parser reports them as
 * `uncatalogued` and stores them regardless, see app/api/hae/route.ts). Reading
 * the catalog as the metric index would therefore have hidden
 * `walking_running_distance`, `flights_climbed`, `physical_effort`,
 * `time_in_daylight` and the entire micronutrient panel -- all currently
 * updating -- and the chat would have answered "I don't have that" about data
 * sitting right there. Uncatalogued metrics have no canonical unit or attention
 * grade, which is worth saying out loud rather than hiding.
 *
 * `days365` and `latest` ride along so coverage can be judged BEFORE a
 * conclusion is drawn. Sleep is the standing example of why, and of why the
 * figure belongs here rather than in prose: its coverage moved from 6.6% of a
 * year to 70% of a month as watch-wear changed, and the copy of the old number
 * that lived in the coach prompt got repeated to the user long after it stopped
 * being true. This function is the answer to "how much of X do I have".
 */
export async function loadMetricIndex(): Promise<MetricIndexRow[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT d.metric, c.display_name, c.canonical_unit, c.attention,
            (c.metric IS NOT NULL) AS catalogued,
            count(*) FILTER (WHERE d.observed_on > today_local() - 365) AS days_365,
            max(d.observed_on) AS latest
     FROM observations_daily d
     LEFT JOIN metric_catalog c ON c.metric = d.metric
     GROUP BY d.metric, c.metric, c.display_name, c.canonical_unit, c.attention
     ORDER BY d.metric`,
  )
  return r.map((x) => ({
    metric: String(x['metric']), displayName: x['display_name'] as string | null,
    canonicalUnit: x['canonical_unit'] as string | null,
    attention: x['attention'] as string | null, catalogued: Boolean(x['catalogued']),
    days365: Number(x['days_365']), latest: day(x['latest']),
  }))
}

/**
 * Whether a metric name exists at all, regardless of window.
 *
 * Lets the chat tell "you typed `weight` and the metric is `weight_lbs`" apart
 * from "that metric exists but has nothing in the last 30 days". Returning an
 * empty series for both would let a typo be reported as an absence of data, which
 * is the most plausible way this chat could state something false with total
 * confidence.
 */
export async function metricExists(metric: string): Promise<boolean> {
  const r = await rows<Record<string, unknown>>(
    `SELECT 1 FROM observations_daily WHERE metric = $1 LIMIT 1`,
    [metric],
  )
  return r.length > 0
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

/** Most recent night on record, however old, with its age in days. Sleep
 *  coverage swings with watch-wear, so "most recent" can be last night or last
 *  month -- this never hides or judges that; callers decide what to do with
 *  ageDays. */
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
