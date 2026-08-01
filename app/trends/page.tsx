import { loadSeries } from '../../lib/queries.js'
import { Chart } from '../ui.js'

export const dynamic = 'force-dynamic'

export default async function Trends({
  searchParams,
}: {
  searchParams: Promise<{ d?: string }>
}) {
  const { d } = await searchParams
  const days = [30, 90, 365].includes(Number(d)) ? Number(d) : 90

  const [weight, protein, calories, steps, rhr, hrv] = await Promise.all([
    loadSeries('weight_lbs', days),
    loadSeries('protein_g', days),
    loadSeries('calories', days),
    loadSeries('steps', days),
    loadSeries('resting_hr', days),
    loadSeries('hrv_ms', days),
  ])

  return (
    <main>
      <h2>
        Last {days} days
        <span style={{ float: 'right', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
          {[30, 90, 365].map((n) => (
            <a key={n} href={`/trends?d=${n}`} style={{ marginLeft: '.6rem' }}>
              {n === 365 ? '1y' : `${n}d`}
            </a>
          ))}
        </span>
      </h2>
      <Chart title="Weight" points={weight} unit="lb" maxGapDays={5} />
      <Chart title="Protein" points={protein} unit="g" />
      <Chart title="Calories" points={calories} />
      <Chart title="Steps" points={steps} />
      <Chart title="Resting heart rate" points={rhr} unit="bpm" maxGapDays={4} />
      <Chart title="HRV" points={hrv} unit="ms" maxGapDays={4} />
      <p className="empty">
        Lines break across gaps rather than interpolating. A day with no reading is
        a day with no reading — the counts in each header show real coverage.
      </p>
    </main>
  )
}
