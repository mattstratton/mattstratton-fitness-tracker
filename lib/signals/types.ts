/**
 * A coaching signal.
 *
 * Every signal is a PURE function over data that has already been fetched. No
 * database, no network, no clock reads inside the rule. That's what makes them
 * testable against fixtures, and it's why a later LLM layer can call exactly the
 * same functions as tools rather than re-deriving any of this in a prompt.
 */
export type SignalStatus =
  /** Nothing to do. */
  | 'ok'
  /** Worth knowing, no decision required yet. */
  | 'watch'
  /** A decision is due. */
  | 'act'
  /** Not enough data to say anything honest. Deliberately NOT 'ok'. */
  | 'unknown'

export type Signal = {
  id: string
  title: string
  status: SignalStatus
  /** One line. Shown on the glance view. */
  headline: string
  /** Optional supporting numbers. Shown on the coach view. */
  // Explicit `| undefined` because exactOptionalPropertyTypes is on: several
  // rules compute a detail conditionally and pass undefined when there is none.
  detail?: string | undefined
}

// ---- Input shapes, mirroring the views in db/migrations ---------------------

export type NutritionDay = {
  observedOn: string
  calories: number | null
  proteinG: number | null
}

export type RecoveryDay = {
  observedOn: string
  restingHr: number | null
  hrvMs: number | null
}

/** A gap is an absent row, never a zero -- same convention as every other
 *  single-metric series in this app (see lib/queries.ts's loadSeries). */
export type ActivityDay = { observedOn: string; steps: number }

export type WeightTrendRow = { days: number; weighIns: number; lbsPerWeek: number | null }

export type EnergyRealityRow = {
  windowDays: number
  coveragePct: number
  avgNetKcal: number | null
  impliedLbsPerWeek: number | null
  actualLbsPerWeek: number | null
  overstatementFactor: number | null
}

export type FreshnessRow = {
  label: string
  latest: string | null
  ageDays: number | null
  status: 'fresh' | 'partial' | 'stale' | 'missing'
  automatic: boolean
  maxAgeDays: number
}

/** One performed set, as stored. `reps: 0` is a failed set, not missing data. */
export type LiftingSetRow = {
  performedOn: string
  recordId: number
  exercise: string
  setIndex: number
  reps: number
  weightLbs: number | null
  targetReps: number | null
  isAmrap: boolean | null
}
