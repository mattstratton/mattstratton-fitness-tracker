/**
 * Nutrition and body-composition targets.
 *
 * These were hardcoded inside the signals, which was the more dangerous kind of
 * assumption than anything program-specific: a program change is deliberate and
 * obvious, whereas switching from a cut to maintenance is gradual, and a
 * protein rule still grading against a cutting target — or a weight rule warning
 * about "losing too fast" while you are deliberately gaining — looks authoritative
 * and is simply wrong.
 *
 * The *current* targets now live in the `nutrition_targets` table (see
 * db/migrations/0009_nutrition_targets.sql and lib/queries.ts's loadTargets),
 * editable from /settings, because they turned out to change roughly weekly as
 * MacroFactor re-tunes them — not the twice-a-year cadence this file originally
 * assumed. `MAINTAIN` and `BULK` stay here as presets: known-good starting
 * points for the settings form when switching phase, not live values.
 */
export type Phase = 'cut' | 'maintain' | 'bulk'

export type Targets = {
  phase: Phase
  /** Grams per day. Non-negotiable on a deficit; the fix for a miss is always
   *  logistics — wider window, shakes — never a lower number. */
  proteinG: number
  /** Daily calorie target, or null when not being steered. */
  calories: number | null
  /**
   * Expected weekly weight change in lb, signed: negative is loss.
   *
   * `concerning` is the magnitude past which the rate itself is the problem —
   * too fast a cut costs lean mass, too fast a gain is mostly fat. Direction is
   * taken from `expected`, so the same rule works in every phase.
   */
  expected: number
  concerning: number
}

export const MAINTAIN: Targets = {
  phase: 'maintain',
  proteinG: 170,
  calories: null,
  expected: 0,
  // Drift in either direction matters when the goal is to stay put.
  concerning: 0.75,
}

export const BULK: Targets = {
  phase: 'bulk',
  proteinG: 180,
  calories: null,
  expected: 0.5,
  concerning: 1.0,
}
