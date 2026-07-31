// Parser for Health Auto Export payloads. Shared by the push endpoint and the
// backfill loader so the two can never drift.
//
//   {"data": {"metrics": [{"name","units","data":[{"date","qty"}]}],
//             "workouts": [{"name","start","end","duration",...}]}}
//
// Some exports omit the "data" wrapper; automation config files reuse the same
// filename pattern but list metric names as bare strings. Both are handled.
import { KG_TO_LBS, parseInstant } from '../domain.js'
import type { HealthWorkout, Observation } from '../domain.js'

/**
 * HAE name -> canonical name. RENAMES ONLY: anything absent passes through
 * under its own name. That is deliberate (docs/adr/0002) -- an unrecognised
 * metric must land, not vanish. Enabling a new one in the iPhone app should
 * require no change here.
 */
const RENAME: Record<string, string> = {
  dietary_energy: 'calories',
  protein: 'protein_g',
  carbohydrates: 'carbs_g',
  total_fat: 'fat_g',
  fiber: 'fiber_g',
  saturated_fat: 'saturated_fat_g',
  dietary_sugar: 'dietary_sugar_g',
  dietary_water: 'water_floz',
  caffeine: 'caffeine_mg',
  sodium: 'sodium_mg',
  potassium: 'potassium_mg',
  calcium: 'calcium_mg',
  iron: 'iron_mg',
  magnesium: 'magnesium_mg',
  zinc: 'zinc_mg',
  weight_body_mass: 'weight_lbs',
  body_fat_percentage: 'body_fat_pct',
  lean_body_mass: 'lean_mass_lbs',
  body_mass_index: 'bmi',
  step_count: 'steps',
  active_energy: 'active_energy_kcal',
  basal_energy_burned: 'basal_energy_kcal',
  apple_exercise_time: 'exercise_minutes',
  resting_heart_rate: 'resting_hr',
  heart_rate_variability: 'hrv_ms',
  blood_oxygen_saturation: 'blood_oxygen_pct',
  apple_sleeping_wrist_temperature: 'wrist_temp_f',
}

export type ParseOptions = {
  /** Report Time. The HTTP receipt time for a push; the load time for a backfill. */
  reportedAt: Date
  source: 'hae' | 'hae_backfill'
}

export type ParsedPayload = {
  observations: Observation[]
  workouts: HealthWorkout[]
  /** Metric names with no catalog entry. Informational only -- they are stored. */
  uncatalogued: string[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * The Observed Day for a daily metric.
 *
 * Take HAE's own day label verbatim. Its `date` is not an instant: HealthKit
 * already aggregated the day in the phone's local zone, so "2026-07-26
 * 00:00:00 -0400" means "the 26th", not "05:00Z". Converting it to HOME_TZ
 * would shift travel days backwards and re-file them. You cannot re-bucket
 * someone else's daily aggregate -- you can only accept it. (Instants that
 * genuinely are instants, like workout starts, DO get converted.)
 */
function dayLabel(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length < 10) return null
  const day = raw.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

/**
 * Hours between two HAE timestamps, or null.
 *
 * Needed because HAE frequently reports `inBed: 0` and sometimes `totalSleep: 0`
 * while the corresponding start/end pair holds the real interval. The old Python
 * survived this by accident -- `a or b or span(...)` treats 0 as falsy -- and the
 * first TypeScript port read the field directly and dutifully stored zero,
 * wiping out every in-bed figure. Caught by diffing against the old database.
 */
function spanHours(point: Record<string, unknown>, startKey: string, endKey: string): number | null {
  const a = typeof point[startKey] === 'string' ? parseInstant(point[startKey] as string) : null
  const b = typeof point[endKey] === 'string' ? parseInstant(point[endKey] as string) : null
  if (a === null || b === null) return null
  const hours = (b.getTime() - a.getTime()) / 3_600_000
  return hours > 0 ? hours : null
}

/** A duration field, falling back to its start/end pair when zero or absent. */
function duration(
  point: Record<string, unknown>, field: string, startKey: string, endKey: string,
): number | null {
  const direct = num(point[field])
  // Zero is treated as "not reported", not as "slept for no time".
  if (direct !== null && direct > 0) return direct
  return spanHours(point, startKey, endKey)
}

// Sleep arrives as hours by default; every field is scaled the same way.
const SLEEP_FIELDS: Array<[source: string, metric: string]> = [
  ['core', 'sleep_core_min'],
  ['deep', 'sleep_deep_min'],
  ['rem', 'sleep_rem_min'],
  ['awake', 'sleep_awake_min'],
]

export function parseHaePayload(payload: unknown, opts: ParseOptions): ParsedPayload {
  const observations: Observation[] = []
  const uncatalogued: string[] = []
  const workouts: HealthWorkout[] = []

  if (!isRecord(payload)) return { observations, workouts, uncatalogued }
  const data = isRecord(payload['data']) ? payload['data'] : payload

  const emit = (
    observedOn: string, metric: string, value: number, unit: string, recordedBy: string | null,
  ) => {
    observations.push({
      observedOn, metric, value, unit, recordedBy,
      source: opts.source, reportedAt: opts.reportedAt,
    })
  }

  const metrics = Array.isArray(data['metrics']) ? data['metrics'] : []
  for (const raw of metrics) {
    // Automation config files list metric names as plain strings.
    if (!isRecord(raw)) continue
    const haeName = typeof raw['name'] === 'string' ? raw['name'] : ''
    if (!haeName) continue
    const units = typeof raw['units'] === 'string' ? raw['units'] : ''
    const points = Array.isArray(raw['data']) ? raw['data'] : []
    // Reshaped metrics are handled below rather than renamed, so they are not
    // pass-throughs even though they aren't in RENAME.
    if (!(haeName in RENAME) && haeName !== 'sleep_analysis' && haeName !== 'heart_rate') {
      uncatalogued.push(haeName)
    }

    for (const point of points) {
      if (!isRecord(point)) continue
      const day = dayLabel(point['date'] ?? point['start'])
      if (day === null) continue
      const by = typeof point['source'] === 'string' ? point['source'] : null

      if (haeName === 'sleep_analysis') {
        // Scale every field identically. `asleep` has been unreliable (0 on
        // some nights, a small bogus value on others), so totalSleep wins.
        const toMin = units === 'min' ? 1 : 60
        const total = duration(point, 'totalSleep', 'sleepStart', 'sleepEnd')
          ?? duration(point, 'asleep', 'sleepStart', 'sleepEnd')
        if (total !== null) emit(day, 'sleep_asleep_min', total * toMin, 'min', by)
        const inBed = duration(point, 'inBed', 'inBedStart', 'inBedEnd')
        if (inBed !== null) emit(day, 'sleep_in_bed_min', inBed * toMin, 'min', by)
        // Stages keep their literal values: `awake: 0` is a real answer, and
        // they have no start/end pair to fall back to anyway.
        for (const [field, metric] of SLEEP_FIELDS) {
          const v = num(point[field])
          if (v !== null) emit(day, metric, v * toMin, 'min', by)
        }
        continue
      }

      if (haeName === 'heart_rate') {
        for (const [field, suffix] of [['Min', 'min'], ['Max', 'max'], ['Avg', 'avg']] as const) {
          const v = num(point[field])
          if (v !== null) emit(day, `heart_rate_${suffix}`, v, units || 'count/min', by)
        }
        continue
      }

      const qty = num(point['qty'])
      if (qty === null) continue

      if (haeName === 'weight_body_mass' || haeName === 'lean_body_mass') {
        const value = units === 'kg' ? qty * KG_TO_LBS : qty
        emit(day, RENAME[haeName]!, value, 'lb', by)
        continue
      }

      emit(day, RENAME[haeName] ?? haeName, qty, units, by)
    }
  }

  // Keyed by the natural key so a payload cannot contain the same workout
  // twice. Real exports do: the 2016-2018 archive repeats sessions within a
  // single file, and Postgres refuses to let ON CONFLICT DO UPDATE touch one
  // row twice in a statement. Last occurrence wins, matching how a Restatement
  // is resolved everywhere else.
  const byKey = new Map<string, HealthWorkout>()
  const rawWorkouts = Array.isArray(data['workouts']) ? data['workouts'] : []
  for (const raw of rawWorkouts) {
    if (!isRecord(raw)) continue
    // A workout start IS a real instant, unlike a daily metric's day label, so
    // it is parsed as one. timestamptz then makes the same session exported
    // under two different offsets collapse to one row on its own.
    const startedAt = typeof raw['start'] === 'string' ? parseInstant(raw['start']) : null
    if (startedAt === null) continue

    const energyRaw = raw['activeEnergyBurned']
    const energyKcal = isRecord(energyRaw) ? num(energyRaw['qty']) : num(energyRaw)
    const durationRaw = raw['duration']
    const durationSec = isRecord(durationRaw) ? num(durationRaw['qty']) : num(durationRaw)

    const type =
      (typeof raw['name'] === 'string' && raw['name']) ||
      (typeof raw['workoutName'] === 'string' && raw['workoutName']) ||
      'Unknown'

    byKey.set(`${startedAt.toISOString()}|${type}`, {
      startedAt,
      type,
      endedAt: typeof raw['end'] === 'string' ? parseInstant(raw['end']) : null,
      durationMin: durationSec === null ? null : durationSec / 60,
      energyKcal,
    })
  }
  workouts.push(...byKey.values())

  return { observations, workouts, uncatalogued }
}
