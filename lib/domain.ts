// Shared vocabulary. Terms here are defined in CONTEXT.md; keep them in step.

/**
 * The canonical day boundary. See docs/adr/0003.
 *
 * Every Observed Day in this system is a calendar day in this zone, chosen so
 * the same input yields the same day no matter where the code runs. Never use
 * the host's local time for this -- that bug (a bare `.astimezone()`) is why
 * the ADR exists.
 */
export const HOME_TZ = 'America/Chicago'

export const KG_TO_LBS = 2.2046226218

// en-CA formats as YYYY-MM-DD, and an explicit timeZone makes this independent
// of process.env.TZ.
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: HOME_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The Observed Day an instant belongs to. */
export function localDay(instant: Date): string {
  return dayFormatter.format(instant)
}

// Both sources emit "YYYY-MM-DD HH:MM:SS ±HHMM" (HAE) or "±HH:MM" (Liftosaur).
// Neither is reliably parseable by `new Date()`, so normalise to ISO first.
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{2}):?(\d{2})$/

/** Parse a source timestamp, or null if it isn't one. */
export function parseInstant(raw: string): Date | null {
  const m = INSTANT_RE.exec(raw.trim())
  if (!m) return null
  const at = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8]}`)
  return Number.isNaN(at.getTime()) ? null : at
}

/** One Report: a source told us, at reportedAt, what a Metric was on a day. */
export type Observation = {
  observedOn: string
  metric: string
  value: number
  unit: string
  source: 'hae' | 'hae_backfill'
  /** The device or app that recorded it, straight from HAE's per-point
   *  `source`. Distinct from `source`, which is how it reached us. */
  recordedBy: string | null
  reportedAt: Date
}

export type LiftingRecord = {
  recordId: number
  performedOn: string
  startedAt: Date
  program: string | null
  dayName: string | null
  /** Lets a sync skip records whose text hasn't changed, so old compressed
   *  chunks are never rewritten. See db/migrations/0002. */
  textHash: string
}

export type LiftingSet = {
  recordId: number
  performedOn: string
  exercise: string
  setIndex: number
  /** 0 means attempted and failed -- a real training event, not missing data. */
  reps: number
  weightLbs: number | null
  targetReps: number | null
  isAmrap: boolean | null
}

export type HealthWorkout = {
  startedAt: Date
  type: string
  endedAt: Date | null
  durationMin: number | null
  energyKcal: number | null
}
