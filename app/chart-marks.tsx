'use client'

import { useState } from 'react'

export type Mark = { x: number; y: number; label: string }

// User units in a 600-wide viewBox scaled to ~330 CSS px on a phone (factor
// ~0.55). 16 renders at ~9 CSS px -- the same reasoning, and the same value,
// as ui.tsx's AXIS_FONT. This file kept fontSize="9" long after the axis text
// was fixed, which rendered at ~5 CSS px.
const LABEL_FONT = 16
// The longest realistic label is a date, a separator, up to five digits with a
// decimal, and a unit: "2026-08-03 · 282.9 lb" -- 21 characters, ~9.3 user
// units each at font 16. 200 clears that with room to spare and still leaves
// most of the 600-unit width free.
const LABEL_WIDTH = 200
const LABEL_HEIGHT = 26

/**
 * Tap-to-read values -- the only client component in this app. Owns exactly
 * one piece of state (which mark is active); everything else (coordinates,
 * labels) is precomputed by the server-rendered Chart and passed in.
 *
 * Hit regions are full-height bands spanning the midpoint to each
 * neighboring mark, not small circles on the mark itself -- a fixed-radius
 * circle becomes a sub-24px hit target once the chart's viewBox is scaled
 * down on a phone, and on a dense series (e.g. a year of daily weight)
 * neighboring marks sit closer together than any reasonably-sized circle,
 * so taps could never reliably pick one point over its neighbor. A band
 * per point has neither problem: it's always as wide as half the spacing
 * to each neighbor, and partitions the chart exhaustively so every tap
 * lands on exactly one point.
 *
 * The label box is clamped horizontally into the viewBox and flips below the
 * mark when there's no room above -- charts run right up to "today", so the
 * most interesting points are exactly the ones nearest an edge.
 */
export function ChartMarks({
  marks, viewBoxWidth, viewBoxHeight,
}: {
  marks: Mark[]
  viewBoxWidth: number
  viewBoxHeight: number
}) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const active = activeIndex === null ? null : marks[activeIndex]

  const bands = marks.map((m, i) => {
    const prev = marks[i - 1]
    const next = marks[i + 1]
    const left = prev ? (prev.x + m.x) / 2 : 0
    const right = next ? (m.x + next.x) / 2 : viewBoxWidth
    return { left, right }
  })

  const labelX = active
    ? Math.min(Math.max(active.x, LABEL_WIDTH / 2), viewBoxWidth - LABEL_WIDTH / 2)
    : 0
  const labelBelow = active ? active.y < LABEL_HEIGHT + 8 : false
  const labelY = active ? (labelBelow ? active.y + LABEL_HEIGHT + 8 : active.y - 12) : 0

  return (
    <>
      {marks.map((m, i) => (
        <rect
          key={i}
          x={bands[i]!.left}
          y={0}
          width={bands[i]!.right - bands[i]!.left}
          height={viewBoxHeight}
          fill="transparent"
          onClick={() => setActiveIndex(activeIndex === i ? null : i)}
          style={{ cursor: 'pointer' }}
        />
      ))}
      {active ? (
        <g>
          <rect
            x={labelX - LABEL_WIDTH / 2}
            y={labelY - LABEL_HEIGHT}
            width={LABEL_WIDTH}
            height={LABEL_HEIGHT}
            rx="3"
            fill="var(--bg)"
            stroke="var(--line)"
          />
          <text
            x={labelX}
            y={labelY - LABEL_HEIGHT / 2 + LABEL_FONT / 2 - 2}
            textAnchor="middle"
            fontSize={LABEL_FONT}
            fill="var(--text)"
          >
            {active.label}
          </text>
        </g>
      ) : null}
    </>
  )
}
