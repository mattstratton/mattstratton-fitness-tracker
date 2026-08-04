import {
  loadSeries, loadTargets, loadTodayDate, loadWeightTrendLine,
} from '../../lib/queries.js'
import {
  axisTicks, computeTrendBand, resolveBarStatus, resolveMarkType, windowStartDate,
} from '../../lib/charting.js'
import { Chart } from '../ui.js'

export const dynamic = 'force-dynamic'

const RANGE_OPTIONS = [30, 90, 365] as const

const DEFAULT_DAYS = {
  weight: 90, protein: 30, calories: 30, steps: 90, rhr: 90, hrv: 90,
} as const

type Metric = keyof typeof DEFAULT_DAYS

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
  const starts = {
    weight: windowStartDate(today, days.weight),
    protein: windowStartDate(today, days.protein),
    calories: windowStartDate(today, days.calories),
    steps: windowStartDate(today, days.steps),
    rhr: windowStartDate(today, days.rhr),
    hrv: windowStartDate(today, days.hrv),
  }

  return (
    <main>
      <div className="chart-section-header">
        <h2>Weight</h2>
        <RangeControl current={days} metric="weight" />
      </div>
      {/* markType is a literal "line", not resolveMarkType: bars grow from zero
          and nobody weighs zero, so a sparse weight series must never become a
          bar chart no matter how thin its coverage gets. Same for steps/RHR/HRV
          below. connectPoints={false} makes it a scatter -- daily wobble is
          water weight; the trend line is what's being read. */}
      <Chart
        title="Weight" points={weight} unit="lb" maxGapDays={5} height={140}
        windowDays={days.weight} today={today}
        markType="line"
        connectPoints={false}
        ticks={axisTicks(weight, days.weight, starts.weight)}
        trendBand={trendBand}
      />

      <div className="chart-section-header">
        <h2>Protein</h2>
        <RangeControl current={days} metric="protein" />
      </div>
      <Chart
        title="Protein" points={protein} unit="g" height={140}
        windowDays={days.protein} today={today}
        markType={resolveMarkType(protein, days.protein)}
        ticks={axisTicks(protein, days.protein, starts.protein)}
        barStatuses={proteinStatuses}
        targetLine={targets.proteinG}
      />

      <div className="chart-section-header">
        <h2>Calories</h2>
        <RangeControl current={days} metric="calories" />
      </div>
      <Chart
        title="Calories" points={calories}
        windowDays={days.calories} today={today}
        markType={resolveMarkType(calories, days.calories)}
        ticks={axisTicks(calories, days.calories, starts.calories)}
        barStatuses={caloriesStatuses}
        {...(targets.calories !== null ? { targetLine: targets.calories } : {})}
      />

      <div className="chart-section-header">
        <h2>Steps</h2>
        <RangeControl current={days} metric="steps" />
      </div>
      <Chart
        title="Steps" points={steps}
        windowDays={days.steps} today={today}
        markType="line"
        ticks={axisTicks(steps, days.steps, starts.steps)}
      />

      <div className="chart-section-header">
        <h2>Resting heart rate</h2>
        <RangeControl current={days} metric="rhr" />
      </div>
      <Chart
        title="Resting heart rate" points={rhr} unit="bpm" maxGapDays={4}
        windowDays={days.rhr} today={today}
        markType="line"
        ticks={axisTicks(rhr, days.rhr, starts.rhr)}
      />

      <div className="chart-section-header">
        <h2>HRV</h2>
        <RangeControl current={days} metric="hrv" />
      </div>
      <Chart
        title="HRV" points={hrv} unit="ms" maxGapDays={4}
        windowDays={days.hrv} today={today}
        markType="line"
        ticks={axisTicks(hrv, days.hrv, starts.hrv)}
      />

      <p className="empty">
        Lines never interpolate across gaps and bars never appear for a day that
        wasn't logged. Today is always excluded — it's still accumulating.
      </p>
    </main>
  )
}
