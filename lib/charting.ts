// Pure chart data-prep: how to render a series, never how it looks.
//
// Mirrors lib/signals/ -- no SQL, no fetch, no clock reads. Everything a
// caller needs (today's date, a regression result, the current targets) is
// passed in explicitly so this stays fixture-testable.
import type { Point } from './queries.js'

export type MarkType = 'line' | 'bar'

/** Below this coverage, disconnected dots read as confetti -- bars from a
 *  baseline are more legible for a sparse series. */
const SPARSE_THRESHOLD = 0.5

export function resolveMarkType(points: Point[], windowDays: number): MarkType {
  if (windowDays <= 0) return 'line'
  return points.length / windowDays < SPARSE_THRESHOLD ? 'bar' : 'line'
}

export type BarStatus = 'hit' | 'miss' | 'neutral'
export type BarDirection = 'atLeast' | { signedExpected: number }

/**
 * Whether a single value counts as a hit against a target.
 *
 * 'atLeast' is protein's rule: hitting or exceeding is always good,
 * regardless of phase (mirrors proteinAdherence). { signedExpected } is
 * calories' rule: direction comes from the phase's expected weekly rate,
 * the same trick calorieAdherence uses -- a cut wants at-or-under, a bulk
 * wants at-or-over, maintenance wants a tolerance band.
 */
export function resolveBarStatus(
  value: number,
  target: number | null,
  direction: BarDirection,
): BarStatus {
  if (target === null) return 'neutral'
  if (direction === 'atLeast') return value >= target ? 'hit' : 'miss'
  if (direction.signedExpected < 0) return value <= target ? 'hit' : 'miss'
  if (direction.signedExpected > 0) return value >= target ? 'hit' : 'miss'
  const tolerance = target * 0.05
  return Math.abs(value - target) <= tolerance ? 'hit' : 'miss'
}
