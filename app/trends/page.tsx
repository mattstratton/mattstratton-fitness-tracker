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
  weight: 90, protein: 30, calories: 30, steps: 90, rhr: 90, hrv: 90,
} as const

type Metric = keyof typeof DEFAULT_DAYS

const METRICS: Metric[] = ['weight', 'protein', 'calories', 'steps', 'rhr', 'hrv']

const CHART_CONFIG: Record<Metric, { title: string; unit?: string; maxGapDays?: number; height: number }> = {
  weight: { title: 'Weight', unit: 'lb', maxGapDays: 5, height: 140 },
  protein: { title: 'Protein', unit: 'g', height: 140 },
  calories: { title: 'Calories', height: 90 },
  steps: { title: 'Steps', height: 90 },
  rhr: { title: 'Resting heart rate', unit: 'bpm', maxGapDays: 4, height: 90 },
  hrv: { title: 'HRV', unit: 'ms', maxGapDays: 4, height: 90 },
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
    protein: resolveDays(params['protein'], DEFAULT_DAYS.protein),
    calories: resolveDays(params['calories'], DEFAULT_DAYS.calories),
    steps: resolveDays(params['steps'], DEFAULT_DAYS.steps),
    rhr: resolveDays(params['rhr'], DEFAULT_DAYS.rhr),
    hrv: resolveDays(params['hrv'], DEFAULT_DAYS.hrv),
  }

  const [weight, protein, calories, steps, rhr, hrv, targets, today, weightTrendLine] = await Promise.all([
    loadSeries('weight_lbs', days.weight),
    loadSeries('protein_g', days.protein),
    loadSeries('calories', days.calories),
    loadSeries('steps', days.steps),
    loadSeries('resting_hr', days.rhr),
    loadSeries('hrv_ms', days.hrv),
    loadTargets(),
    loadTodayDate(),
    loadWeightTrendLine(days.weight),
  ])

  const points: Record<Metric, Point[]> = { weight, protein, calories, steps, rhr, hrv }

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
    protein: windowStartDate(today, days.protein),
    calories: windowStartDate(today, days.calories),
    steps: windowStartDate(today, days.steps),
    rhr: windowStartDate(today, days.rhr),
    hrv: windowStartDate(today, days.hrv),
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
  // line is what's being read. Protein/Calories are the only two sparse
  // series with a real target to grade against, so they're the only two that
  // can ever become bars.
  const extraFor: Record<Metric, Extra> = {
    weight: { markType: 'line', connectPoints: false, trendBand },
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
    steps: { markType: 'line' },
    rhr: { markType: 'line' },
    hrv: { markType: 'line' },
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
        wasn't logged. Today is always excluded — it's still accumulating.
      </p>
    </main>
  )
}
