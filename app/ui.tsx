import type { Point } from '../lib/queries.js'
import type { Signal } from '../lib/signals/types.js'
import type { AxisTicks, BarStatus, TrendBand } from '../lib/charting.js'
import { windowStartDate } from '../lib/charting.js'
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
  /** Line mode only: false draws a scatter of dots with no connecting line --
   *  what weight wants, where the day-to-day wobble is water, not signal, and
   *  the trend line is the thing to read. */
  connectPoints?: boolean
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
  connectPoints = true,
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

  // Bars grow from y=0, but axisTicks derives its ticks from the data's own
  // min/max and so frequently omits zero -- leaving the baseline every bar is
  // measured against as an unlabelled gap at the bottom of the chart. Purely a
  // display union; lib/charting.ts stays a pure function of the data.
  const displayTicksY = markType === 'bar'
    ? [...new Set([0, ...ticks.y])].sort((a, b) => a - b)
    : ticks.y

  // A left gutter for the y-axis tick numbers, which are right-aligned against
  // the plot edge. Sized to the longest label rather than fixed: a fixed gutter
  // wide enough for weight's "265" sends steps' "15000" off the left edge of the
  // viewBox, and one wide enough for "15000" wastes a tenth of every other
  // chart. ~0.6em per character is a safe over-estimate for digits.
  const maxTickChars = Math.max(1, ...displayTicksY.map((v) => String(v).length))
  const PAD_LEFT = Math.ceil(PAD + maxTickChars * AXIS_FONT * 0.6 + 4)

  // The x-scale always spans the full requested window ending today, not
  // just "first data point to last data point" -- so a gap at the start or
  // end of the window (e.g. nothing logged in the most recent 3 days)
  // shows as real empty space rather than compressing the visible range.
  const windowStart = windowStartDate(today, windowDays)
  const span = windowDays

  const values = points.map((p) => p.value)
  let lo = Math.min(...values, ...ticks.y)
  let hi = Math.max(...values, ...ticks.y)
  // The trend band is deliberately NOT folded into lo/hi. It's a regression
  // projected across the whole window, so its extremes can sit tens of pounds
  // outside anything observed -- expanding the domain to contain it squashes
  // the real readings (real 90d data: 35% of the plot height instead of 66%),
  // which trades a clipping bug for a legibility one. The band is clipped to
  // the plot rect instead; see the <clipPath> below. Domain expansion and
  // visual clipping are not the same fix.
  if (targetLine !== undefined) {
    lo = Math.min(lo, targetLine)
    hi = Math.max(hi, targetLine)
  }
  if (markType === 'bar') {
    lo = Math.min(lo, 0) // bars grow from zero, never a truncated baseline
  }
  const range = hi - lo || 1
  const plotH = H - AXIS_PAD - PAD * 2

  const x = (observedOn: string) =>
    PAD_LEFT + (daysBetween(windowStart, observedOn) / span) * (W - PAD_LEFT - PAD)
  const y = (value: number) => PAD + (1 - (value - lo) / range) * plotH

  const covered = points.length
  // loadSeries excludes BOTH boundary days (observed_on > today - N AND
  // observed_on < today), so N-1 is the most days that can ever be covered.
  const possible = windowDays - 1

  // On a compact chart (height 90) six ticks land ~12 user units apart, which
  // at AXIS_FONT=16 means adjacent numbers visually merge. Draw every
  // gridline; label every other one, counting down from the top so the
  // highest tick -- the one worth reading -- always keeps its label.
  const tickGap = displayTicksY.length > 1 ? plotH / (displayTicksY.length - 1) : plotH
  const sparseLabels = tickGap < AXIS_FONT * 1.3

  const formatValue = (v: number) =>
    Number.isInteger(v)
      ? v.toLocaleString()
      // One decimal, not Math.round: weight moves in tenths of a pound and
      // rounding to a whole number throws away the entire signal.
      : v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })

  const marks: Mark[] = points.map((p) => ({
    x: x(p.observedOn),
    y: y(p.value),
    label: `${p.observedOn} · ${formatValue(p.value)}${unit ? ` ${unit}` : ''}`,
  }))

  // Split into runs of points that are actually adjacent in time -- only
  // needed when we're actually drawing a connecting line.
  const runs: Point[][] = []
  if (markType === 'line' && connectPoints) {
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
  }

  // SVG ids are document-global and all six charts share one page.
  const clipId = `plot-clip-${title.replace(/\s+/g, '-').toLowerCase()}`

  return (
    <figure className="chart">
      <figcaption>
        <span>{title}</span>
        <span>
          {Math.round(Math.min(...values))}–{Math.round(Math.max(...values))}{unit ? ` ${unit}` : ''} · {covered}/{possible} days
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${covered} readings`}>
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD_LEFT} y={PAD} width={W - PAD_LEFT - PAD} height={plotH} />
          </clipPath>
        </defs>
        {displayTicksY.map((v, i) => {
          const yPos = y(v)
          // The topmost gridline sits at y === PAD (hi is always bound by
          // the top tick), so a label placed above it clips off the top of
          // the viewBox -- drop it below the line instead whenever there
          // isn't room above.
          const nearTop = yPos < PAD + AXIS_FONT
          const labelled = !sparseLabels || (displayTicksY.length - 1 - i) % 2 === 0
          return (
            <g key={v}>
              <line x1={PAD_LEFT} y1={yPos} x2={W - PAD} y2={yPos} stroke="var(--line)" strokeWidth="1" />
              {labelled ? (
                <text
                  x={PAD_LEFT - 4} y={nearTop ? yPos + AXIS_FONT : yPos - 2}
                  fontSize={AXIS_FONT} fill="var(--muted)" textAnchor="end"
                >
                  {v}
                </text>
              ) : null}
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
            x1={PAD_LEFT} y1={y(targetLine)} x2={W - PAD} y2={y(targetLine)}
            stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="4,3"
          />
        ) : null}

        {trendBand ? (
          // Clipped to the plot rect rather than scaled to fit: the band's
          // projected extremes routinely fall outside the visible domain and
          // cropping them there is free, where widening the domain costs the
          // real data most of the chart's height.
          <g clipPath={`url(#${clipId})`}>
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
          </g>
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
              <circle
                key={p.observedOn} cx={x(p.observedOn)} cy={y(p.value)} r="1.9"
                // When there's a trend overlay, the raw readings are the noise
                // and the trend is the message -- so the dots step back to
                // muted and --accent belongs to the trend line alone.
                fill={trendBand ? 'var(--muted)' : 'var(--accent)'}
              />
            ))}
          </>
        )}

        <ChartMarks marks={marks} viewBoxWidth={W} viewBoxHeight={H} />
      </svg>
    </figure>
  )
}
