# Trends Charts Readability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the six `/trends` charts readable — axes, a today marker, target lines, a real trend overlay for weight, bars for sparse series, tap-to-read values, per-chart range control, and importance-based sizing.

**Architecture:** Pure, fixture-tested data-prep functions in a new `lib/charting.ts` (mirrors the existing `lib/signals/` pattern) decide *what* to draw — mark type, axis ticks, trend/band geometry, hit/miss status. `app/ui.tsx`'s `Chart` component stays presentational: it receives already-resolved data and renders SVG. A new, tiny `'use client'` component (`app/chart-marks.tsx`) is the app's first client-side interactivity, scoped to exactly one piece of state (which point is tapped).

**Tech Stack:** Next.js App Router (server components + one scoped client component), hand-rolled SVG (no charting library), PostgreSQL (`regr_slope`/`regr_intercept` for the weight trend), `node:test` for fixtures.

Spec: `docs/superpowers/specs/2026-08-04-trends-charts-readability-design.md`

## Global Constraints

- No charting library — hand-rolled SVG only (spec: Context; issue #5).
- Gaps are never interpolated and never plotted as zero (existing project-wide rule, unchanged by this work).
- Today is always excluded from every plotted series/bars — it's a Partial Day (spec: Decisions locked).
- Every tap/hit target is ≥24px even though the visible mark stays small — mobile-first (spec: Chart component section).
- This spec reuses the *existing* CSS custom properties in `app/globals.css` (`--bg`, `--panel`, `--line`, `--text`, `--muted`, `--accent`, `--ok`, `--watch`, `--act`, `--unknown`) — no new colors, no site-wide redesign (spec: Context, out of scope).
- Dashed lines are reserved exclusively for target/threshold lines; axes and gridlines are always solid hairlines (spec: Chart component section).
- Bars always grow from y=0, never a truncated baseline (spec: Chart component section).
- `npm test` and `npm run typecheck` must both pass before any task is considered done (project standing rule, `CLAUDE.md`).

---

## Task 1: `lib/charting.ts` — `resolveMarkType` and `resolveBarStatus`

**Files:**
- Create: `lib/charting.ts`
- Create: `tests/charting.test.ts`

**Interfaces:**
- Produces: `resolveMarkType(points: Point[], windowDays: number): 'line' | 'bar'`; `resolveBarStatus(value: number, target: number | null, direction: 'atLeast' | { signedExpected: number }): 'hit' | 'miss' | 'neutral'`. `Point` is imported from `lib/queries.ts` (already exists: `{ observedOn: string; value: number }`).

- [ ] **Step 1: Write the failing tests**

Create `tests/charting.test.ts`:

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveMarkType, resolveBarStatus } from '../lib/charting.js'
import type { Point } from '../lib/queries.js'

const day = (n: number) => `2026-07-${String(n).padStart(2, '0')}`

test('resolveMarkType: exactly 50% coverage is a line, not a bar', () => {
  const points: Point[] = Array.from({ length: 45 }, (_, i) => ({ observedOn: day(i + 1), value: 100 }))
  assert.equal(resolveMarkType(points, 90), 'line')
})

test('resolveMarkType: just under 50% coverage is a bar', () => {
  const points: Point[] = Array.from({ length: 44 }, (_, i) => ({ observedOn: day(i + 1), value: 100 }))
  assert.equal(resolveMarkType(points, 90), 'bar')
})

test('resolveMarkType: well above threshold is a line', () => {
  const points: Point[] = Array.from({ length: 85 }, (_, i) => ({ observedOn: day(i + 1), value: 100 }))
  assert.equal(resolveMarkType(points, 90), 'line')
})

test('resolveBarStatus: atLeast hits at or above target', () => {
  assert.equal(resolveBarStatus(198, 198, 'atLeast'), 'hit')
  assert.equal(resolveBarStatus(199, 198, 'atLeast'), 'hit')
  assert.equal(resolveBarStatus(197, 198, 'atLeast'), 'miss')
})

test('resolveBarStatus: signed negative (cut) wants at-or-under', () => {
  const direction = { signedExpected: -1.0 }
  assert.equal(resolveBarStatus(1660, 1660, direction), 'hit')
  assert.equal(resolveBarStatus(1600, 1660, direction), 'hit')
  assert.equal(resolveBarStatus(1700, 1660, direction), 'miss')
})

test('resolveBarStatus: signed positive (bulk) wants at-or-over', () => {
  const direction = { signedExpected: 0.5 }
  assert.equal(resolveBarStatus(3200, 3200, direction), 'hit')
  assert.equal(resolveBarStatus(3300, 3200, direction), 'hit')
  assert.equal(resolveBarStatus(3100, 3200, direction), 'miss')
})

test('resolveBarStatus: signed zero (maintain) wants a 5% tolerance band', () => {
  const direction = { signedExpected: 0 }
  assert.equal(resolveBarStatus(2200, 2200, direction), 'hit')
  assert.equal(resolveBarStatus(2250, 2200, direction), 'hit')
  assert.equal(resolveBarStatus(2600, 2200, direction), 'miss')
})

test('resolveBarStatus: a null target is neutral, never a fabricated miss', () => {
  assert.equal(resolveBarStatus(1900, null, { signedExpected: -1.0 }), 'neutral')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/charting.test.ts`
Expected: FAIL — `Cannot find module '../lib/charting.js'`

- [ ] **Step 3: Write the implementation**

Create `lib/charting.ts`:

```typescript
// Pure chart data-prep: how to render a series, never how it looks.
//
// Mirrors lib/signals/ -- no SQL, no fetch, no clock reads. Everything a
// caller needs (today's date, a regression result, the current targets) is
// passed in explicitly so this stays fixture-testable.
import type { Point } from './queries.js'

export type MarkType = 'line' | 'bar'

/** Below this coverage, disconnected dots read as confetti -- bars from a
 *  baseline are more legible for a sparse series. */
const SPARSE_THRESHOLD = 0.5

export function resolveMarkType(points: Point[], windowDays: number): MarkType {
  if (windowDays <= 0) return 'line'
  return points.length / windowDays < SPARSE_THRESHOLD ? 'bar' : 'line'
}

export type BarStatus = 'hit' | 'miss' | 'neutral'
export type BarDirection = 'atLeast' | { signedExpected: number }

/**
 * Whether a single value counts as a hit against a target.
 *
 * 'atLeast' is protein's rule: hitting or exceeding is always good,
 * regardless of phase (mirrors proteinAdherence). { signedExpected } is
 * calories' rule: direction comes from the phase's expected weekly rate,
 * the same trick calorieAdherence uses -- a cut wants at-or-under, a bulk
 * wants at-or-over, maintenance wants a tolerance band.
 */
export function resolveBarStatus(
  value: number,
  target: number | null,
  direction: BarDirection,
): BarStatus {
  if (target === null) return 'neutral'
  if (direction === 'atLeast') return value >= target ? 'hit' : 'miss'
  if (direction.signedExpected < 0) return value <= target ? 'hit' : 'miss'
  if (direction.signedExpected > 0) return value >= target ? 'hit' : 'miss'
  const tolerance = target * 0.05
  return Math.abs(value - target) <= tolerance ? 'hit' : 'miss'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/charting.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors

```bash
git add lib/charting.ts tests/charting.test.ts
git commit -m "Add resolveMarkType and resolveBarStatus for chart readability (#5)"
```

---

## Task 2: `lib/charting.ts` — `axisTicks`

**Files:**
- Modify: `lib/charting.ts` (append)
- Modify: `tests/charting.test.ts` (append)

**Interfaces:**
- Consumes: `Point` (from Task 1's import).
- Produces: `AxisTicks = { x: string[]; y: number[] }`; `axisTicks(points: Point[], windowDays: number): AxisTicks`.

- [ ] **Step 1: Write the failing tests**

First, change the existing import line at the top of `tests/charting.test.ts` from:

```typescript
import { resolveMarkType, resolveBarStatus } from '../lib/charting.js'
```

to:

```typescript
import { resolveMarkType, resolveBarStatus, axisTicks } from '../lib/charting.js'
```

Then append the new tests to the end of the file:

```typescript
test('axisTicks: x tick count scales with window length', () => {
  const points30: Point[] = Array.from({ length: 30 }, (_, i) => ({ observedOn: day(i + 1), value: 100 }))
  assert.equal(axisTicks(points30, 30).x.length, 3)
})

test('axisTicks: y ticks are rounded to clean steps, not raw min/max', () => {
  const points: Point[] = [{ observedOn: day(1), value: 213 }, { observedOn: day(2), value: 287 }]
  const ticks = axisTicks(points, 90)
  assert.deepEqual(ticks.y, [200, 220, 240, 260, 280, 300])
})

test('axisTicks: empty points yields no ticks', () => {
  assert.deepEqual(axisTicks([], 90), { x: [], y: [] })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/charting.test.ts`
Expected: FAIL — `axisTicks is not a function`

- [ ] **Step 3: Write the implementation**

Append to `lib/charting.ts`:

```typescript
const DAY_MS = 86_400_000
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS)

export type AxisTicks = { x: string[]; y: number[] }

/** A "nice" step size (1/2/5 x 10^n) for roughly `targetCount` gridlines. */
function niceStep(range: number, targetCount: number): number {
  const roughStep = range / targetCount
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
  const residual = roughStep / magnitude
  const step = residual >= 5 ? 10 : residual >= 2 ? 5 : residual >= 1 ? 2 : 1
  return step * magnitude
}

/**
 * X ticks: a handful of evenly-spaced dates, never one per point -- a tick
 * per point is chaos on a 90-point series. Y ticks: rounded to clean values,
 * not the raw min/max, so the gridlines read as round numbers.
 */
export function axisTicks(points: Point[], windowDays: number): AxisTicks {
  if (points.length === 0) return { x: [], y: [] }

  const first = points[0]!.observedOn
  const last = points[points.length - 1]!.observedOn
  const span = daysBetween(first, last)
  const xCount = windowDays <= 30 ? 3 : windowDays <= 90 ? 4 : 5

  const x: string[] = []
  for (let i = 0; i < xCount; i++) {
    const frac = xCount === 1 ? 0 : i / (xCount - 1)
    const offset = Math.round(span * frac)
    x.push(new Date(Date.parse(first) + offset * DAY_MS).toISOString().slice(0, 10))
  }

  const values = points.map((p) => p.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const step = niceStep(hi - lo || 1, 4)
  const niceLo = Math.floor(lo / step) * step
  const niceHi = Math.ceil(hi / step) * step

  const y: number[] = []
  for (let v = niceLo; v <= niceHi + step / 1000; v += step) {
    y.push(Math.round(v * 100) / 100)
  }

  return { x, y }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/charting.test.ts`
Expected: PASS (11 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add lib/charting.ts tests/charting.test.ts
git commit -m "Add axisTicks for chart axis rendering (#5)"
```

---

## Task 3: `lib/charting.ts` — `computeTrendBand`

**Files:**
- Modify: `lib/charting.ts` (append)
- Modify: `tests/charting.test.ts` (append)

**Interfaces:**
- Consumes: `Point`; `Targets` (from `lib/config.ts`, existing: `{ phase, proteinG, calories, expected, concerning }`).
- Produces: `Regression = { slope: number; intercept: number; referenceDate: string }`; `TrendBand = { trendLine: [Point, Point]; band: [Point, Point, Point, Point] }`; `computeTrendBand(points: Point[], regression: Regression | null, target: Targets): TrendBand | null`.

- [ ] **Step 1: Write the failing tests**

First, change the existing import line at the top of `tests/charting.test.ts` from:

```typescript
import { resolveMarkType, resolveBarStatus, axisTicks } from '../lib/charting.js'
```

to:

```typescript
import { resolveMarkType, resolveBarStatus, axisTicks, computeTrendBand } from '../lib/charting.js'
import type { Targets } from '../lib/config.js'
```

Then append the new tests to the end of the file:

```typescript
test('computeTrendBand: null regression yields no overlay', () => {
  const points: Point[] = [{ observedOn: day(1), value: 275 }, { observedOn: day(2), value: 274 }]
  const target: Targets = { phase: 'cut', proteinG: 198, calories: 1660, expected: -1.0, concerning: 1.5 }
  assert.equal(computeTrendBand(points, null, target), null)
})

test('computeTrendBand: trend line follows the regression, band widens by concerning', () => {
  const points: Point[] = [{ observedOn: day(1), value: 275 }, { observedOn: day(8), value: 274 }]
  // slope -1 lb/week = -1/7 lb/day, anchored so day(1) (referenceDate) = 275
  const regression = { slope: -1 / 7, intercept: 275, referenceDate: day(1) }
  const target: Targets = { phase: 'cut', proteinG: 198, calories: 1660, expected: -1.0, concerning: 1.5 }
  const result = computeTrendBand(points, regression, target)
  assert.ok(result)
  assert.equal(result.trendLine[0].value, 275)
  assert.equal(Math.round(result.trendLine[1].value * 100) / 100, 274)
  assert.equal(result.band[0].value, 275)
  assert.equal(Math.round(result.band[2].value * 100) / 100, 275.5)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test tests/charting.test.ts`
Expected: FAIL — `computeTrendBand is not a function`

- [ ] **Step 3: Write the implementation**

Append to `lib/charting.ts` (add `import type { Targets } from './config.js'` to the top imports):

```typescript
export type Regression = { slope: number; intercept: number; referenceDate: string }

export type TrendBand = {
  trendLine: [Point, Point]
  band: [Point, Point, Point, Point]
}

/**
 * The weight chart's two overlays: the actual regression fit, and an
 * "on-track" band (expected +/- concerning lb/week) anchored at the trend
 * line's own starting value. Returns null when there's no regression (too
 * few points -- mirrors weight_trend's own HAVING count(*) >= 3) rather
 * than fabricating a line through noise.
 */
export function computeTrendBand(
  points: Point[],
  regression: Regression | null,
  target: Targets,
): TrendBand | null {
  if (regression === null || points.length === 0) return null

  const first = points[0]!.observedOn
  const last = points[points.length - 1]!.observedOn

  const valueAt = (observedOn: string): number => {
    const offsetFromReference = daysBetween(regression.referenceDate, observedOn)
    return regression.intercept + regression.slope * offsetFromReference
  }

  const trendLine: [Point, Point] = [
    { observedOn: first, value: valueAt(first) },
    { observedOn: last, value: valueAt(last) },
  ]

  const startValue = trendLine[0].value
  const bandValueAt = (observedOn: string, lbPerWeek: number): number => {
    const offsetFromFirst = daysBetween(first, observedOn)
    return startValue + (lbPerWeek / 7) * offsetFromFirst
  }

  const band: [Point, Point, Point, Point] = [
    { observedOn: first, value: bandValueAt(first, target.expected - target.concerning) },
    { observedOn: last, value: bandValueAt(last, target.expected - target.concerning) },
    { observedOn: last, value: bandValueAt(last, target.expected + target.concerning) },
    { observedOn: first, value: bandValueAt(first, target.expected + target.concerning) },
  ]

  return { trendLine, band }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test tests/charting.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add lib/charting.ts tests/charting.test.ts
git commit -m "Add computeTrendBand for the weight chart's trend/target overlay (#5)"
```

---

## Task 4: `lib/queries.ts` — `loadTodayDate`, `loadWeightTrendLine`, exclude today from `loadSeries`

**Files:**
- Modify: `lib/queries.ts`

**Interfaces:**
- Produces: `loadTodayDate(): Promise<string>`; `loadWeightTrendLine(days: number): Promise<{ slope: number; intercept: number; referenceDate: string } | null>` (shape matches `charting.ts`'s `Regression` type from Task 3).
- Modifies existing `loadSeries` behavior: excludes the current day.

This file has no unit tests today (it's the SQL/fetch layer — `tests/signals.test.ts` covers the pure functions it feeds, not the queries themselves). Verification here is a manual query against the real dev database, same as this project's existing convention.

- [ ] **Step 1: Modify `loadSeries` to exclude today**

In `lib/queries.ts`, find:

```typescript
export async function loadSeries(metric: string, days: number): Promise<Point[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT observed_on, value FROM observations_daily
     WHERE metric = $1 AND observed_on > today_local() - $2::int ORDER BY observed_on`,
    [metric, days],
  )
  return r.map((x) => ({ observedOn: day(x['observed_on']), value: Number(x['value']) }))
}
```

Replace the SQL string with (adds `AND observed_on < today_local()`):

```typescript
export async function loadSeries(metric: string, days: number): Promise<Point[]> {
  const r = await rows<Record<string, unknown>>(
    `SELECT observed_on, value FROM observations_daily
     WHERE metric = $1 AND observed_on > today_local() - $2::int AND observed_on < today_local()
     ORDER BY observed_on`,
    [metric, days],
  )
  return r.map((x) => ({ observedOn: day(x['observed_on']), value: Number(x['value']) }))
}
```

- [ ] **Step 2: Add `loadTodayDate` and `loadWeightTrendLine`**

Add immediately after `loadSeries` (before `loadToday`):

```typescript
/** Today's date, for the chart's "today (partial)" marker -- charts must not
 *  read the clock themselves, so this is the one place that does. */
export async function loadTodayDate(): Promise<string> {
  const r = await rows<Record<string, unknown>>(`SELECT today_local() AS d`)
  return day(r[0]!['d'])
}

/**
 * Regression for the weight chart's trend overlay, over the EXACT window
 * the chart is displaying -- not weight_trend's fixed 14/28/90-day windows,
 * which have no intercept and can't draw a line over an arbitrary range.
 * Excludes the same outliers weight_trend does. Null when there are too few
 * points to fit a trend (mirrors weight_trend's own HAVING count(*) >= 3).
 */
export async function loadWeightTrendLine(
  days: number,
): Promise<{ slope: number; intercept: number; referenceDate: string } | null> {
  const r = await rows<Record<string, unknown>>(
    `SELECT
       regr_slope(o.value, (o.observed_on - today_local())::int) AS slope,
       regr_intercept(o.value, (o.observed_on - today_local())::int) AS intercept,
       count(*) AS n,
       today_local() AS reference_date
     FROM observations_daily o
     WHERE o.metric = 'weight_lbs'
       AND o.observed_on > today_local() - $1::int
       AND o.observed_on <= today_local()
       AND NOT EXISTS (
         SELECT 1 FROM weight_outliers x WHERE x.observed_on = o.observed_on
       )`,
    [days],
  )
  const row = r[0]
  if (!row || Number(row['n']) < 3 || row['slope'] === null) return null
  return {
    slope: Number(row['slope']),
    intercept: Number(row['intercept']),
    referenceDate: day(row['reference_date']),
  }
}
```

- [ ] **Step 3: Verify against the real dev database**

Run (uses this project's existing `npm run q` script against `DATABASE_URL` in `.env`):

```bash
npm run q "SELECT regr_slope(o.value, (o.observed_on - today_local())::int) AS slope, regr_intercept(o.value, (o.observed_on - today_local())::int) AS intercept, count(*) AS n, today_local() AS reference_date FROM observations_daily o WHERE o.metric='weight_lbs' AND o.observed_on > today_local() - 90 AND o.observed_on <= today_local() AND NOT EXISTS (SELECT 1 FROM weight_outliers x WHERE x.observed_on = o.observed_on)"
```

Expected: one row with a plausible `slope` (a small negative number, lb/day), `intercept` (a number near the current bodyweight), `n >= 3`, and today's date. Also spot-check that `loadSeries` no longer returns a row for today:

```bash
npm run q "SELECT observed_on, value FROM observations_daily WHERE metric='calories' AND observed_on >= today_local() - 3 ORDER BY observed_on"
```

Expected: no row with `observed_on = today_local()`'s date in the output (confirm against `date` on the machine or `npm run q "SELECT today_local()"`).

- [ ] **Step 4: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add lib/queries.ts
git commit -m "Add loadTodayDate/loadWeightTrendLine, exclude today from loadSeries (#5)"
```

---

## Task 5: `app/chart-marks.tsx` — tap-to-read client component

**Files:**
- Create: `app/chart-marks.tsx`

**Interfaces:**
- Produces: `Mark = { x: number; y: number; label: string }`; `ChartMarks({ marks: Mark[] })` — a `'use client'` component, the app's first.
- Consumes: nothing from earlier tasks (pure presentational; `Chart` in Task 6 will pass it pre-computed screen coordinates and label strings).

This is a leaf UI component with no existing test harness for components in this app (verified by hand once wired into `Chart` in Task 6). This task's own verification is limited to typechecking.

- [ ] **Step 1: Write the component**

Create `app/chart-marks.tsx`:

```tsx
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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors (the component isn't imported anywhere yet, so this only checks its own syntax/types)

- [ ] **Step 3: Commit**

```bash
git add app/chart-marks.tsx
git commit -m "Add ChartMarks, the app's first client component, for tap-to-read (#5)"
```

---

## Task 6: `app/ui.tsx` — rewrite `Chart` for axes, today marker, targets, trend band, and bar mode

**Files:**
- Modify: `app/ui.tsx:38-127` (the `Chart` component and its helpers; `SignalCard` and `Tile` above it are untouched)

**Interfaces:**
- Consumes: `AxisTicks`, `BarStatus`, `TrendBand` (from `lib/charting.ts`, Tasks 1-3); `Mark`, `ChartMarks` (from `app/chart-marks.tsx`, Task 5); `Point` (from `lib/queries.ts`, existing).
- Produces: new `ChartProps` type or, since it's not currently exported: `Chart(props: { title, points, unit?, maxGapDays?, height?, windowDays, today, markType, ticks, barStatuses?, targetLine?, trendBand? })`. Task 7 (the trends page) calls this with fully-resolved props — `Chart` no longer computes `resolveMarkType`/`axisTicks`/`computeTrendBand` itself.

This is one cohesive rewrite (axes, marker, targets, bars, and trend band all share the same `x()`/`y()` scale functions, so splitting them into separate diffs would produce intermediate states that don't render correctly). Verified by hand in a browser, since this app has no component-rendering test harness today (existing `Chart` has none either).

- [ ] **Step 1: Replace the `Chart` component**

In `app/ui.tsx`, first add three import lines to the existing import block at the
top of the file (alongside the current `import type { Point } from
'../lib/queries.js'` and `import type { Signal } from '../lib/signals/types.js'`):

```typescript
import type { AxisTicks, BarStatus, TrendBand } from '../lib/charting.js'
import type { Mark } from './chart-marks.js'
import { ChartMarks } from './chart-marks.js'
```

Then replace everything from the `daysBetween`/`Chart` section (the code starting
at the `const DAY_MS = 86_400_000` line, roughly line 34, through the end of
`Chart`, roughly line 127) with:

```typescript
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
  // The x-scale always spans the full requested window ending today, not
  // just "first data point to last data point" -- so a gap at the start or
  // end of the window (e.g. nothing logged in the most recent 3 days)
  // shows as real empty space rather than compressing the visible range.
  const windowStart = new Date(Date.parse(today) - windowDays * DAY_MS).toISOString().slice(0, 10)
  const span = windowDays

  const values = points.map((p) => p.value)
  let lo = Math.min(...values, ...ticks.y)
  let hi = Math.max(...values, ...ticks.y)
  if (markType === 'bar') {
    lo = Math.min(lo, 0) // bars grow from zero, never a truncated baseline
    if (targetLine !== undefined) hi = Math.max(hi, targetLine)
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
        {ticks.y.map((v) => (
          <g key={v}>
            <line x1={PAD} y1={y(v)} x2={W - PAD} y2={y(v)} stroke="var(--line)" strokeWidth="1" />
            <text x={PAD} y={y(v) - 2} fontSize="8" fill="var(--muted)">{v}</text>
          </g>
        ))}
        {ticks.x.map((d) => (
          <text key={d} x={x(d)} y={H - 2} fontSize="8" fill="var(--muted)" textAnchor="middle">
            {d.slice(5)}
          </text>
        ))}

        <line
          x1={x(today)} y1={PAD} x2={x(today)} y2={H - AXIS_PAD}
          stroke="var(--muted)" strokeWidth="1.5" strokeDasharray="4,3"
        />
        <text x={x(today)} y={PAD + 8} fontSize="8" fill="var(--muted)" textAnchor="middle">
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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: errors in `app/trends/page.tsx` (it still calls `Chart` with the old prop shape) — this is expected and fixed in Task 7. Confirm there are **no** errors reported inside `app/ui.tsx` itself.

- [ ] **Step 3: Commit**

```bash
git add app/ui.tsx
git commit -m "Rewrite Chart for axes, today marker, targets, trend band, and bars (#5)"
```

(`app/trends/page.tsx` is intentionally left broken until Task 7 — this task is about `Chart` in isolation.)

---

## Task 7: `app/trends/page.tsx` — per-chart ranges, hierarchy, wiring

**Files:**
- Modify: `app/trends/page.tsx` (full rewrite of the existing file)
- Modify: `app/globals.css` (append)

**Interfaces:**
- Consumes: `loadSeries`, `loadTargets`, `loadTodayDate`, `loadWeightTrendLine` (from `lib/queries.ts`); `resolveMarkType`, `resolveBarStatus`, `computeTrendBand`, `axisTicks` (from `lib/charting.ts`); `Chart` (from `app/ui.tsx`, Task 6's new prop shape).
- Produces: the rendered `/trends` page. Nothing downstream depends on this file.

- [ ] **Step 1: Replace `app/trends/page.tsx`**

Replace the entire file with:

```tsx
import {
  loadSeries, loadTargets, loadTodayDate, loadWeightTrendLine,
} from '../../lib/queries.js'
import { axisTicks, computeTrendBand, resolveBarStatus, resolveMarkType } from '../../lib/charting.js'
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

  return (
    <main>
      <div className="chart-section-header">
        <h2>Weight</h2>
        <RangeControl current={days} metric="weight" />
      </div>
      <Chart
        title="Weight" points={weight} unit="lb" maxGapDays={5} height={140}
        windowDays={days.weight} today={today}
        markType={resolveMarkType(weight, days.weight)}
        ticks={axisTicks(weight, days.weight)}
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
        ticks={axisTicks(protein, days.protein)}
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
        ticks={axisTicks(calories, days.calories)}
        barStatuses={caloriesStatuses}
        targetLine={targets.calories ?? undefined}
      />

      <div className="chart-section-header">
        <h2>Steps</h2>
        <RangeControl current={days} metric="steps" />
      </div>
      <Chart
        title="Steps" points={steps}
        windowDays={days.steps} today={today}
        markType={resolveMarkType(steps, days.steps)}
        ticks={axisTicks(steps, days.steps)}
      />

      <div className="chart-section-header">
        <h2>Resting heart rate</h2>
        <RangeControl current={days} metric="rhr" />
      </div>
      <Chart
        title="Resting heart rate" points={rhr} unit="bpm" maxGapDays={4}
        windowDays={days.rhr} today={today}
        markType={resolveMarkType(rhr, days.rhr)}
        ticks={axisTicks(rhr, days.rhr)}
      />

      <div className="chart-section-header">
        <h2>HRV</h2>
        <RangeControl current={days} metric="hrv" />
      </div>
      <Chart
        title="HRV" points={hrv} unit="ms" maxGapDays={4}
        windowDays={days.hrv} today={today}
        markType={resolveMarkType(hrv, days.hrv)}
        ticks={axisTicks(hrv, days.hrv)}
      />

      <p className="empty">
        Lines never interpolate across gaps and bars never appear for a day that
        wasn't logged. Today is always excluded — it's still accumulating.
      </p>
    </main>
  )
}
```

- [ ] **Step 2: Add CSS for the per-chart range control and section header**

Append to `app/globals.css`:

```css
.chart-section-header { display:flex; align-items:baseline; justify-content:space-between;
                         margin:2rem 0 .5rem; }
.chart-section-header h2 { margin:0; }
.chart-range { display:flex; gap:.5rem; font-size:.7rem; }
.chart-range a { text-decoration:none; color:var(--muted); }
.chart-range a[data-active] { color:var(--text); font-weight:600; }
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors anywhere in the project now

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: all tests pass (the existing signals suite plus `tests/charting.test.ts` from Tasks 1–3)

- [ ] **Step 5: Verify in a browser**

Run: `npm run dev`, then sign in and visit `http://localhost:3000/trends` (or, per this project's known local-auth limitation — Google OAuth is only registered for the production redirect URI — verify after deploying instead if local sign-in fails).

Check by hand:
- Each of the six charts shows solid axis gridlines and date labels, not just a bare polyline.
- A dashed vertical "today (partial)" marker appears at the right edge of every chart, and today's own value never appears as a plotted point/bar.
- Protein and Calories render as bars (assuming their real coverage is under 50%) with a dashed target line; a bar you know missed its target renders in the red status color, not blue.
- Weight shows dots, a solid actual-trend line, and a faint green on-track band.
- Tapping any point/bar shows a small label with its date and value; tapping again hides it.
- Each chart's range links (30d/90d/1y) change only that chart's window, leaving the others as they were.
- Weight/Protein render visibly taller than Calories/Steps/RHR/HRV.

- [ ] **Step 6: Commit**

```bash
git add app/trends/page.tsx app/globals.css
git commit -m "Rework /trends: per-chart ranges, hierarchy, wire targets and trend overlay (#5)"
```

---

## Task 8: Final verification and cleanup

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass, including `tests/charting.test.ts`

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 3: Production build**

Run: `npx next build`
Expected: builds successfully, `/trends` listed as a route (mirrors the verification already done for issue #9's `/settings` page)

- [ ] **Step 4: Confirm the out-of-scope items are still out of scope**

Re-read `docs/superpowers/specs/2026-08-04-trends-charts-readability-design.md`'s "Follow-ups filed for later" section. Confirm no changes in this plan touched `app/globals.css`'s color custom properties (`--ok`/`--watch`/`--act`/`--unknown`/`--accent` etc.) beyond adding the two new rules in Task 7 — the whole-app visual redesign stays a separate future spec.

- [ ] **Step 5: Migration log**

If anything during implementation surprised you (a query behaving differently than expected, a number that didn't match the mockup's assumption, TimescaleDB continuous-aggregate behavior around `today_local()` that didn't match `loadSeries`'s new exclusion clause, etc.), add an entry to `docs/migration-log.md` in the same change that found it, per this project's standing "record what we learn" rule (`CLAUDE.md`). If nothing surprising came up, no entry is needed — don't manufacture one.

- [ ] **Step 6: Final commit (if Step 5 produced one)**

```bash
git add docs/migration-log.md
git commit -m "Record findings from the trends chart readability work (#5)"
```
