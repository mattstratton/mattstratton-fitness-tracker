import {
  loadSeries, loadTargets, loadTodayDate, loadWeightTrendLine,
} from '../../lib/queries.js'
import {
  axisTicks, computeTrendBand, resolveBarStatus, resolveMarkType, windowStartDate,
} from '../../lib/charting.js'
import type { BarStatus, TrendBand } from '../../lib/charting.js'
import type { Point } from '../../lib/queries.js'
import { ExpandableChart } from '../expandable-chart.js'

export const dynamic = 'force-dynamic'

const RANGE_OPTIONS = [30, 90, 365] as const

const DEFAULT_DAYS = {
  weight: 90, bodyFat: 90, leanMass: 90, protein: 30, calories: 30,
  // Same logging cadence as protein/calories -- all four come from the same
  // MacroFactor entry.
  carbs: 30, fat: 30, fiber: 30,
  steps: 90, rhr: 90, hrv: 90, sleep: 90,
  // Defaults to the widest window -- "a long-run fitness trend, meaningless
  // day to day" per its own metric_catalog note, so the short windows aren't
  // the useful ones here the way they are for everything else.
  vo2Max: 365,
} as const

type Metric = keyof typeof DEFAULT_DAYS

const METRICS: Metric[] = [
  'weight', 'bodyFat', 'leanMass', 'protein', 'calories', 'carbs', 'fat', 'fiber',
  'steps', 'rhr', 'hrv', 'sleep', 'vo2Max',
]

const CHART_CONFIG: Record<Metric, { title: string; unit?: string; maxGapDays?: number; height: number }> = {
  weight: { title: 'Weight', unit: 'lb', maxGapDays: 5, height: 140 },
  // Same sparsity/noise profile as weight (bioimpedance wobbles with hydration
  // and glycogen day to day) -- same maxGapDays, same scatter treatment below.
  bodyFat: { title: 'Body fat', unit: '%', maxGapDays: 5, height: 90 },
  leanMass: { title: 'Lean mass', unit: 'lb', maxGapDays: 5, height: 90 },
  protein: { title: 'Protein', unit: 'g', height: 140 },
  calories: { title: 'Calories', height: 90 },
  // Ingested from MacroFactor and already flow into the `nutrition` view's
  // SQL, but had no chart at all -- no target exists for any of these three
  // (only protein/calories have one), so they never get hit/miss coloring.
  // Names match metric_catalog's own display_name exactly, incl. "Fibre".
  carbs: { title: 'Carbohydrates', unit: 'g', height: 90 },
  fat: { title: 'Fat', unit: 'g', height: 90 },
  fiber: { title: 'Fibre', unit: 'g', height: 90 },
  steps: { title: 'Steps', height: 90 },
  rhr: { title: 'Resting heart rate', unit: 'bpm', maxGapDays: 4, height: 90 },
  hrv: { title: 'HRV', unit: 'ms', maxGapDays: 4, height: 90 },
  // Sleep has ~7% coverage -- no maxGapDays override needed. Nights are
  // virtually always >3 days apart (Chart's default), so this already
  // renders as isolated dots with no connecting line, same as the sparse
  // scatter weight/RHR/HRV get for free.
  sleep: { title: 'Sleep', unit: 'hr', height: 90 },
  // Real readings land 8-48 days apart (measured against live history) --
  // a wide maxGapDays connects them into one trend line rather than
  // shattering into isolated dots the way sleep's ~7%-coverage chart does.
  // Unlike weight/body-fat/lean-mass, each reading here IS the signal
  // (not day-to-day wobble), so a connecting line is the honest read.
  vo2Max: { title: 'VO2 max', unit: 'ml/(kg·min)', maxGapDays: 60, height: 90 },
}

function resolveDays(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return (RANGE_OPTIONS as readonly number[]).includes(n) ? n : fallback
}

function buildHref(current: Record<Metric, number>, metric: Metric, days: number): string {
  const params = new URLSearchParams()
  for (const key of Object.keys(current) as Metric[]) {
    params.set(key, String(key === metric ? days : current[key]))
  }
  return `/trends?${params.toString()}#${metric}`
}

function RangeControl({ current, metric }: { current: Record<Metric, number>; metric: Metric }) {
  return (
    <span className="chart-range">
      {RANGE_OPTIONS.map((n) => (
        <a key={n} href={buildHref(current, metric, n)} data-active={n === current[metric] ? '' : undefined}>
          {n === 365 ? '1y' : `${n}d`}
        </a>
      ))}
    </span>
  )
}

export default async function Trends({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const days: Record<Metric, number> = {
    weight: resolveDays(params['weight'], DEFAULT_DAYS.weight),
    bodyFat: resolveDays(params['bodyFat'], DEFAULT_DAYS.bodyFat),
    leanMass: resolveDays(params['leanMass'], DEFAULT_DAYS.leanMass),
    protein: resolveDays(params['protein'], DEFAULT_DAYS.protein),
    calories: resolveDays(params['calories'], DEFAULT_DAYS.calories),
    carbs: resolveDays(params['carbs'], DEFAULT_DAYS.carbs),
    fat: resolveDays(params['fat'], DEFAULT_DAYS.fat),
    fiber: resolveDays(params['fiber'], DEFAULT_DAYS.fiber),
    steps: resolveDays(params['steps'], DEFAULT_DAYS.steps),
    rhr: resolveDays(params['rhr'], DEFAULT_DAYS.rhr),
    hrv: resolveDays(params['hrv'], DEFAULT_DAYS.hrv),
    sleep: resolveDays(params['sleep'], DEFAULT_DAYS.sleep),
    vo2Max: resolveDays(params['vo2Max'], DEFAULT_DAYS.vo2Max),
  }

  const [
    weight, bodyFat, leanMass, protein, calories, carbs, fat, fiber, steps, rhr, hrv, sleep, vo2Max,
    targets, today, weightTrendLine,
  ] = await Promise.all([
    loadSeries('weight_lbs', days.weight),
    loadSeries('body_fat_pct', days.bodyFat),
    loadSeries('lean_mass_lbs', days.leanMass),
    loadSeries('protein_g', days.protein),
    loadSeries('calories', days.calories),
    loadSeries('carbs_g', days.carbs),
    loadSeries('fat_g', days.fat),
    loadSeries('fiber_g', days.fiber),
    loadSeries('steps', days.steps),
    loadSeries('resting_hr', days.rhr),
    loadSeries('hrv_ms', days.hrv),
    loadSeries('sleep_asleep_min', days.sleep),
    loadSeries('vo2_max', days.vo2Max),
    loadTargets(),
    loadTodayDate(),
    loadWeightTrendLine(days.weight),
  ])

  // Minutes -> hours for readability, same pattern as protein/calories'
  // status maps below transforming a raw series before display.
  const sleepHours: Point[] = sleep.map((p) => ({ observedOn: p.observedOn, value: p.value / 60 }))

  const points: Record<Metric, Point[]> = {
    weight, bodyFat, leanMass, protein, calories, carbs, fat, fiber, steps, rhr, hrv, sleep: sleepHours, vo2Max,
  }

  const proteinStatuses = new Map(
    protein.map((p) => [p.observedOn, resolveBarStatus(p.value, targets.proteinG, 'atLeast')] as const),
  )
  const caloriesStatuses = new Map(
    calories.map((p) => [
      p.observedOn,
      resolveBarStatus(p.value, targets.calories, { signedExpected: targets.expected }),
    ] as const),
  )
  const trendBand = computeTrendBand(weight, weightTrendLine, targets)

  // Chart's x-scale spans the whole requested window, so the date labels have
  // to be spaced across that same window rather than across wherever the data
  // happens to sit. Same helper Chart uses, so the two can't drift.
  const starts: Record<Metric, string> = {
    weight: windowStartDate(today, days.weight),
    bodyFat: windowStartDate(today, days.bodyFat),
    leanMass: windowStartDate(today, days.leanMass),
    protein: windowStartDate(today, days.protein),
    calories: windowStartDate(today, days.calories),
    carbs: windowStartDate(today, days.carbs),
    fat: windowStartDate(today, days.fat),
    fiber: windowStartDate(today, days.fiber),
    steps: windowStartDate(today, days.steps),
    rhr: windowStartDate(today, days.rhr),
    hrv: windowStartDate(today, days.hrv),
    sleep: windowStartDate(today, days.sleep),
    vo2Max: windowStartDate(today, days.vo2Max),
  }

  type Extra = {
    markType: 'line' | 'bar'
    barStatuses?: Map<string, BarStatus>
    targetLine?: number
    trendBand?: TrendBand | null
    connectPoints?: boolean
  }

  // markType is a literal "line" for weight/steps/RHR/HRV, never
  // resolveMarkType: bars grow from zero and none of those metrics has a
  // hit/miss target to color against, so a thin coverage window must never
  // silently turn them into a misleading bar chart. connectPoints={false} on
  // weight makes it a scatter -- daily wobble is water weight; the trend
  // line is what's being read. Protein/Calories are the only two with a real
  // target, so they're the only two that ever get hit/miss COLOR. Carbs/fat/
  // fiber have no target (see macrofactor-is-authoritative memory -- this app
  // tracks, never grades, macros beyond protein/calories) but zero is still a
  // meaningful baseline for a gram amount, so resolveMarkType can still turn
  // them into bars when sparse -- just always neutral-colored, no barStatuses.
  const extraFor: Record<Metric, Extra> = {
    weight: { markType: 'line', connectPoints: false, trendBand },
    // Same scatter treatment as weight, same reason: bioimpedance readings
    // wobble day to day (hydration, glycogen), so a connecting line would
    // read as signal that isn't there. No trend band -- that's tied to
    // nutrition targets (expected/concerning lb/week), which don't apply to
    // body fat %/lean mass.
    bodyFat: { markType: 'line', connectPoints: false },
    leanMass: { markType: 'line', connectPoints: false },
    protein: {
      markType: resolveMarkType(protein, days.protein),
      barStatuses: proteinStatuses,
      targetLine: targets.proteinG,
    },
    calories: {
      markType: resolveMarkType(calories, days.calories),
      barStatuses: caloriesStatuses,
      ...(targets.calories !== null ? { targetLine: targets.calories } : {}),
    },
    carbs: { markType: resolveMarkType(carbs, days.carbs) },
    fat: { markType: resolveMarkType(fat, days.fat) },
    fiber: { markType: resolveMarkType(fiber, days.fiber) },
    steps: { markType: 'line' },
    rhr: { markType: 'line' },
    hrv: { markType: 'line' },
    sleep: { markType: 'line' },
    vo2Max: { markType: 'line' },
  }

  return (
    <main>
      {METRICS.map((key) => {
        const cfg = CHART_CONFIG[key]
        const metricPoints = points[key]
        return (
          <ExpandableChart
            key={key}
            rangeControl={<RangeControl current={days} metric={key} />}
            title={cfg.title}
            points={metricPoints}
            height={cfg.height}
            windowDays={days[key]}
            today={today}
            ticks={axisTicks(metricPoints, days[key], starts[key])}
            {...(cfg.unit !== undefined ? { unit: cfg.unit } : {})}
            {...(cfg.maxGapDays !== undefined ? { maxGapDays: cfg.maxGapDays } : {})}
            {...extraFor[key]}
          />
        )
      })}

      <p className="empty">
        Lines never interpolate across gaps and bars never appear for a day that
        wasn't logged. Today is always excluded — it's still accumulating. Sleep
        coverage is intentionally sparse (~7%) and shown for reference, not a trend
        to read into.
      </p>
    </main>
  )
}
