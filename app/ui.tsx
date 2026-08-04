import type { Point } from '../lib/queries.js'
import type { Signal } from '../lib/signals/types.js'
import type { AxisTicks, BarStatus, TrendBand } from '../lib/charting.js'
import type { Mark } from './chart-marks.js'
import { ChartMarks } from './chart-marks.js'

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

export type ChartProps = {
  title: string
  points: Point[]
  unit?: string
  maxGapDays?: number
  height?: number
  windowDays: number
  today: string
  markType: 'line' | 'bar'
  ticks: AxisTicks
  barStatuses?: Map<string, BarStatus>
  targetLine?: number
  trendBand?: TrendBand | null
}

/**
 * A sparse-aware chart: axes, a today marker, an optional flat target line
 * or weight's trend/band overlay, and either a connected line (dense
 * series) or bars from zero (sparse series) -- see lib/charting.ts for how
 * each of those is decided. Gaps are never interpolated and today's value
 * is never plotted (it's a Partial Day); tap any mark to read its value.
 */
export function Chart({
  title, points, unit, maxGapDays = 3, height = 90,
  windowDays, today, markType, ticks, barStatuses, targetLine, trendBand,
}: ChartProps) {
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
  const AXIS_PAD = 16
  // Axis text renders inside a 600-unit-wide viewBox that's scaled to ~55%
  // of its user-unit size on a phone (600 user units -> ~330 CSS px inside
  // main's padding + the chart panel's padding) -- fontSize="8" here would
  // render at under 5 CSS px, illegible in the garage. 16 lands around 9px.
  const AXIS_FONT = 16
  // The x-scale always spans the full requested window ending today, not
  // just "first data point to last data point" -- so a gap at the start or
  // end of the window (e.g. nothing logged in the most recent 3 days)
  // shows as real empty space rather than compressing the visible range.
  const windowStart = new Date(Date.parse(today) - windowDays * DAY_MS).toISOString().slice(0, 10)
  const span = windowDays

  const values = points.map((p) => p.value)
  let lo = Math.min(...values, ...ticks.y)
  let hi = Math.max(...values, ...ticks.y)
  // The trend band and target line can both extrapolate well outside the
  // observed values (the band is a regression projected across the whole
  // window) -- fold them into the range too, or they render clipped off
  // the plot and the on-track band silently swallows the entire chart.
  if (trendBand) {
    const bandValues = [
      ...trendBand.band.map((p) => p.value),
      ...trendBand.trendLine.map((p) => p.value),
    ]
    lo = Math.min(lo, ...bandValues)
    hi = Math.max(hi, ...bandValues)
  }
  if (targetLine !== undefined) {
    lo = Math.min(lo, targetLine)
    hi = Math.max(hi, targetLine)
  }
  if (markType === 'bar') {
    lo = Math.min(lo, 0) // bars grow from zero, never a truncated baseline
  }
  const range = hi - lo || 1

  const x = (observedOn: string) => PAD + (daysBetween(windowStart, observedOn) / span) * (W - PAD * 2)
  const y = (value: number) => PAD + (1 - (value - lo) / range) * (H - AXIS_PAD - PAD * 2)

  const covered = points.length
  const possible = windowDays

  const marks: Mark[] = points.map((p) => ({
    x: x(p.observedOn),
    y: y(p.value),
    label: `${p.observedOn} · ${Math.round(p.value).toLocaleString()}${unit ? ` ${unit}` : ''}`,
  }))

  // Split into runs of points that are actually adjacent in time (line mode only).
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

  return (
    <figure className="chart">
      <figcaption>
        <span>{title}</span>
        <span>
          {Math.round(Math.min(...values))}–{Math.round(Math.max(...values))}{unit ? ` ${unit}` : ''} · {covered}/{possible} days
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${covered} readings`}>
        {ticks.y.map((v) => {
          const yPos = y(v)
          // The topmost gridline sits at y === PAD (hi is always bound by
          // the top tick), so a label placed above it clips off the top of
          // the viewBox -- drop it below the line instead whenever there
          // isn't room above.
          const nearTop = yPos < PAD + AXIS_FONT
          return (
            <g key={v}>
              <line x1={PAD} y1={yPos} x2={W - PAD} y2={yPos} stroke="var(--line)" strokeWidth="1" />
              <text x={PAD} y={nearTop ? yPos + AXIS_FONT : yPos - 2} fontSize={AXIS_FONT} fill="var(--muted)">{v}</text>
            </g>
          )
        })}
        {ticks.x.map((d) => (
          <text key={d} x={x(d)} y={H - 2} fontSize={AXIS_FONT} fill="var(--muted)" textAnchor="middle">
            {d.slice(5)}
          </text>
        ))}

        <line
          x1={x(today)} y1={PAD} x2={x(today)} y2={H - AXIS_PAD}
          stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="4,3"
        />
        <text x={x(today) - 4} y={PAD + AXIS_FONT} fontSize={AXIS_FONT} fill="var(--muted)" textAnchor="end">
          today (partial)
        </text>

        {targetLine !== undefined ? (
          <line
            x1={PAD} y1={y(targetLine)} x2={W - PAD} y2={y(targetLine)}
            stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="4,3"
          />
        ) : null}

        {trendBand ? (
          <>
            <polygon
              points={trendBand.band.map((p) => `${x(p.observedOn).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}
              fill="var(--ok)"
              opacity="0.12"
            />
            <line
              x1={x(trendBand.trendLine[0].observedOn)} y1={y(trendBand.trendLine[0].value)}
              x2={x(trendBand.trendLine[1].observedOn)} y2={y(trendBand.trendLine[1].value)}
              stroke="var(--accent)" strokeWidth="1.75"
            />
          </>
        ) : null}

        {markType === 'bar' ? (
          points.map((p) => {
            const status = barStatuses?.get(p.observedOn) ?? 'neutral'
            const barY = Math.min(y(p.value), y(0))
            const barH = Math.abs(y(0) - y(p.value))
            return (
              <rect
                key={p.observedOn}
                x={x(p.observedOn) - 3} y={barY} width="6" height={barH}
                fill={status === 'miss' ? 'var(--act)' : 'var(--accent)'}
              />
            )
          })
        ) : (
          <>
            {runs.map((r, i) =>
              r.length > 1 ? (
                <polyline
                  key={i}
                  points={r.map((p) => `${x(p.observedOn).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}
                  fill="none" stroke="var(--accent)" strokeWidth="1.75"
                  strokeLinejoin="round" strokeLinecap="round"
                />
              ) : null,
            )}
            {points.map((p) => (
              <circle key={p.observedOn} cx={x(p.observedOn)} cy={y(p.value)} r="1.9" fill="var(--accent)" />
            ))}
          </>
        )}

        <ChartMarks marks={marks} />
      </svg>
    </figure>
  )
}
