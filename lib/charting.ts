// Pure chart data-prep: how to render a series, never how it looks.
//
// Mirrors lib/signals/ -- no SQL, no fetch, no clock reads. Everything a
// caller needs (today's date, a regression result, the current targets) is
// passed in explicitly so this stays fixture-testable.
import type { Point } from './queries.js'
import type { Targets } from './config.js'

export type MarkType = 'line' | 'bar'

/** Below this coverage, disconnected dots read as confetti -- bars from a
 *  baseline are more legible for a sparse series. */
const SPARSE_THRESHOLD = 0.5

/**
 * ONLY call this for metrics that have a hit/miss target to colour bars
 * against -- protein and calories. Bars grow from zero, which is a claim that
 * zero is the meaningful baseline; for weight, resting HR and HRV it isn't
 * (nobody weighs zero), so a bar's height there encodes nothing. Coverage
 * alone can't tell you that: at a 365-day window weight/RHR/HRV all fall under
 * the threshold and would silently become misleading bar charts. The caller
 * decides which metrics may ever be bars; this decides whether they should be.
 */
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

const DAY_MS = 86_400_000
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS)

export type AxisTicks = { x: string[]; y: number[] }

/**
 * The left edge of a chart's window: `windowDays` before `today`. The Chart's
 * x-scale and `axisTicks`' date labels both need this and they MUST agree --
 * when they drifted apart the labels described a different range than the
 * marks were plotted against. One function, imported by both.
 */
export function windowStartDate(today: string, windowDays: number): string {
  return new Date(Date.parse(today) - windowDays * DAY_MS).toISOString().slice(0, 10)
}

/** A "nice" step size (1/2/5 x 10^n) for roughly `targetCount` gridlines. */
function niceStep(range: number, targetCount: number): number {
  const roughStep = range / targetCount
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const residual = roughStep / magnitude
  const step = residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1
  return step * magnitude
}

/**
 * X ticks: a handful of evenly-spaced dates, never one per point -- a tick
 * per point is chaos on a 90-point series. Y ticks: rounded to clean values,
 * not the raw min/max, so the gridlines read as round numbers.
 *
 * `windowStart` should be passed whenever the caller's x-scale spans the whole
 * requested window rather than just the data's own extent -- which the Chart's
 * does. Without it the labels are spaced across `points[0]..points[last]`, so
 * a series clustered in part of the window gets its date labels bunched into
 * that cluster while most of the axis goes unlabeled. Optional only so the
 * data-extent behaviour stays available (and the existing tests keep passing).
 */
export function axisTicks(points: Point[], windowDays: number, windowStart?: string): AxisTicks {
  if (points.length === 0) return { x: [], y: [] }

  const first = windowStart ?? points[0]!.observedOn
  const span = windowStart === undefined
    ? daysBetween(points[0]!.observedOn, points[points.length - 1]!.observedOn)
    : windowDays
  const xCount: number = windowDays <= 30 ? 3 : windowDays <= 90 ? 4 : 5

  const x: string[] = []
  for (let i = 0; i < xCount; i++) {
    const frac = xCount === 1 ? 0 : i / (xCount - 1)
    const offset = Math.round(span * frac)
    x.push(new Date(Date.parse(first) + offset * DAY_MS).toISOString().slice(0, 10))
  }

  const values = points.map((p) => p.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const step = niceStep(hi - lo || 1, 4)
  const niceLo = Math.floor(lo / step) * step
  const niceHi = Math.ceil(hi / step) * step

  const y: number[] = []
  for (let v = niceLo; v <= niceHi + step / 1000; v += step) {
    y.push(Math.round(v * 100) / 100)
  }

  return { x, y }
}

export type Regression = { slope: number; intercept: number; referenceDate: string }

export type TrendBand = {
  trendLine: [Point, Point]
  band: [Point, Point, Point, Point]
}

/**
 * The weight chart's two overlays: the actual regression fit, and an
 * "on-track" band (expected +/- concerning lb/week) anchored at the trend
 * line's own starting value. Returns null when there's no regression (too
 * few points -- mirrors weight_trend's own HAVING count(*) >= 3) rather
 * than fabricating a line through noise.
 */
export function computeTrendBand(
  points: Point[],
  regression: Regression | null,
  target: Targets,
): TrendBand | null {
  if (regression === null || points.length === 0) return null

  const first = points[0]!.observedOn
  const last = points[points.length - 1]!.observedOn

  const valueAt = (observedOn: string): number => {
    const offsetFromReference = daysBetween(regression.referenceDate, observedOn)
    return regression.intercept + regression.slope * offsetFromReference
  }

  const trendLine: [Point, Point] = [
    { observedOn: first, value: valueAt(first) },
    { observedOn: last, value: valueAt(last) },
  ]

  const startValue = trendLine[0].value
  const bandValueAt = (observedOn: string, lbPerWeek: number): number => {
    const offsetFromFirst = daysBetween(first, observedOn)
    return startValue + (lbPerWeek / 7) * offsetFromFirst
  }

  const band: [Point, Point, Point, Point] = [
    { observedOn: first, value: bandValueAt(first, target.expected - target.concerning) },
    { observedOn: last, value: bandValueAt(last, target.expected - target.concerning) },
    { observedOn: last, value: bandValueAt(last, target.expected + target.concerning) },
    { observedOn: first, value: bandValueAt(first, target.expected + target.concerning) },
  ]

  return { trendLine, band }
}
