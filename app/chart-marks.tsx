'use client'

import { useState } from 'react'

export type Mark = { x: number; y: number; label: string }

/**
 * Tap-to-read values -- the only client component in this app. Owns exactly
 * one piece of state (which mark is active); everything else (coordinates,
 * labels) is precomputed by the server-rendered Chart and passed in.
 */
export function ChartMarks({ marks }: { marks: Mark[] }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const active = activeIndex === null ? null : marks[activeIndex]

  return (
    <>
      {marks.map((m, i) => (
        <circle
          key={i}
          cx={m.x}
          cy={m.y}
          r="12"
          fill="transparent"
          onClick={() => setActiveIndex(activeIndex === i ? null : i)}
          style={{ cursor: 'pointer' }}
        />
      ))}
      {active ? (
        <g>
          <rect
            x={active.x - 30}
            y={active.y - 24}
            width="60"
            height="16"
            rx="3"
            fill="var(--bg)"
            stroke="var(--line)"
          />
          <text x={active.x} y={active.y - 12} textAnchor="middle" fontSize="9" fill="var(--text)">
            {active.label}
          </text>
        </g>
      ) : null}
    </>
  )
}
