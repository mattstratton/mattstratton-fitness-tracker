import type { Point } from '../lib/queries.js'
import type { Signal } from '../lib/signals/types.js'

export function SignalCard({ signal, showDetail = true }: { signal: Signal; showDetail?: boolean }) {
  return (
    <div className="signal" data-s={signal.status}>
      <div className="body">
        <div className="t">{signal.title}</div>
        <div className="h">{signal.headline}</div>
        {showDetail && signal.detail ? <div className="d">{signal.detail}</div> : null}
      </div>
    </div>
  )
}

export function Tile({ label, value, unit }: { label: string; value: number | null; unit?: string }) {
  return (
    <div className="tile">
      <div className="k">{label}</div>
      {value === null ? (
        // Not "0". An unlogged day is unlogged, and a tile showing 0g protein
        // when nothing was logged is the same lie as a chart interpolating a gap.
        <div className="v none">not logged</div>
      ) : (
        <div className="v">
          {Math.round(value).toLocaleString()}
          {unit ? <span style={{ fontSize: '.8rem', color: 'var(--muted)' }}> {unit}</span> : null}
        </div>
      )}
    </div>
  )
}

const DAY_MS = 86_400_000
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS)

/**
 * A sparse-aware line chart.
 *
 * The whole point: nutrition is logged on 21 of 90 days, so a naive polyline
 * would draw a confident straight line across a nine-day hole and invent data
 * that does not exist. The path BREAKS whenever consecutive points are more
 * than `maxGapDays` apart, and every real observation gets a dot so density is
 * visible rather than implied.
 *
 * Hand-rolled SVG rather than a charting library: ~50 points per series does
 * not justify shipping a bundle to a phone.
 */
export function Chart({
  title, points, unit, maxGapDays = 3, height = 90,
}: {
  title: string
  points: Point[]
  unit?: string
  maxGapDays?: number
  height?: number
}) {
  if (points.length < 2) {
    return (
      <figure className="chart">
        <figcaption><span>{title}</span><span>no data</span></figcaption>
        <div className="empty">Not enough readings to plot.</div>
      </figure>
    )
  }

  const W = 600
  const H = height
  const PAD = 6
  const first = points[0]!.observedOn
  const last = points[points.length - 1]!.observedOn
  const span = Math.max(1, daysBetween(first, last))
  const values = points.map((p) => p.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const range = hi - lo || 1

  const x = (p: Point) => PAD + (daysBetween(first, p.observedOn) / span) * (W - PAD * 2)
  const y = (p: Point) => PAD + (1 - (p.value - lo) / range) * (H - PAD * 2)

  // Split into runs of points that are actually adjacent in time.
  const runs: Point[][] = []
  let run: Point[] = []
  for (const p of points) {
    const prev = run[run.length - 1]
    if (prev && daysBetween(prev.observedOn, p.observedOn) > maxGapDays) {
      runs.push(run)
      run = []
    }
    run.push(p)
  }
  if (run.length) runs.push(run)

  const covered = points.length
  const possible = span + 1

  return (
    <figure className="chart">
      <figcaption>
        <span>{title}</span>
        <span>
          {Math.round(lo)}–{Math.round(hi)}{unit ? ` ${unit}` : ''} · {covered}/{possible} days
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${covered} readings`}>
        {runs.map((r, i) =>
          r.length > 1 ? (
            <polyline
              key={i}
              points={r.map((p) => `${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(' ')}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.75"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ) : null,
        )}
        {points.map((p) => (
          <circle key={p.observedOn} cx={x(p)} cy={y(p)} r="1.9" fill="var(--accent)" />
        ))}
      </svg>
    </figure>
  )
}
