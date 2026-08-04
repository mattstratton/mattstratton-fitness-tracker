'use client'

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Panzoom from '@panzoom/panzoom'
import type { PanzoomObject } from '@panzoom/panzoom'
import type { ChartProps } from './ui.js'
import { Chart } from './ui.js'

const EXPANDED_HEIGHT = 420

/**
 * Wraps a Chart with an expand button and a full-screen pinch-zoom/pan modal
 * -- the app's second client component (after ChartMarks). Renders the exact
 * same Chart twice (small inline, then again larger inside the modal) rather
 * than trying to animate one instance between sizes; the modal instance gets
 * @panzoom/panzoom attached to its own container so a fresh pinch/pan starts
 * centered every time, never carrying over a stale transform from last time.
 *
 * rangeControl is accepted as a prop rather than owned here: it's built by
 * the page (a plain function component, no 'use client', no server-only
 * work), so its JSX can simply cross the server->client boundary as a prop
 * value -- this component doesn't need to know anything about ranges.
 */
export function ExpandableChart({ rangeControl, ...chartProps }: { rangeControl: ReactNode } & ChartProps) {
  const [expanded, setExpanded] = useState(false)
  const panzoomElRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!expanded) return undefined

    document.body.style.overflow = 'hidden'
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('keydown', onKeyDown)

    const el = panzoomElRef.current
    let panzoom: PanzoomObject | undefined
    let wheelTarget: HTMLElement | null = null
    if (el) {
      panzoom = Panzoom(el, { maxScale: 6, contain: 'outside', canvas: true })
      wheelTarget = el.parentElement
      // Panzoom binds pointer/touch pan+pinch on creation; wheel-zoom needs
      // explicit binding per its own docs.
      wheelTarget?.addEventListener('wheel', panzoom.zoomWithWheel)
    }

    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKeyDown)
      if (panzoom) {
        wheelTarget?.removeEventListener('wheel', panzoom.zoomWithWheel)
        panzoom.destroy()
      }
    }
  }, [expanded])

  return (
    <>
      <div className="chart-section-header">
        <h2>{chartProps.title}</h2>
        {rangeControl}
        <button
          type="button"
          className="chart-expand-btn"
          aria-label={`Expand ${chartProps.title} chart`}
          onClick={() => setExpanded(true)}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6"
              fill="none" stroke="currentColor" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <Chart {...chartProps} />

      {expanded ? (
        <div
          className="chart-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setExpanded(false)
          }}
        >
          <button type="button" className="chart-modal-close" onClick={() => setExpanded(false)} aria-label="Close">
            ✕
          </button>
          <div className="chart-modal-panzoom">
            <div ref={panzoomElRef}>
              <Chart {...chartProps} height={EXPANDED_HEIGHT} />
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
