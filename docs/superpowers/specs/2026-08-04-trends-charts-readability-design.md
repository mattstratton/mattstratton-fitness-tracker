# Trends charts readability — design

Status: approved, ready for implementation planning
Issue: [#5](../../../../issues/5) — "Make the trends charts actually readable"

## Context

Phase 3 built honest charts: gaps stay gaps, coverage counts are real, nothing
interpolates. But they're bare polylines with no orientation — no axes, no
sense of "where does today sit," no way to see a value against its target,
and a single global 30/90/365 switch when different metrics want different
windows. Issue #5 lists eight concrete weaknesses; this spec addresses all
eight.

**Out of scope, deliberately:** the issue also floats a broader visual design
pass (colors, typography, overall layout) as "worth doing once there's some
idea of what actually gets looked at." That's being split into its own,
separate spec so it can be reviewed independently and doesn't block this one.
This spec ships using the app's *current* visual language (existing CSS
custom properties in `app/globals.css` — `--bg`, `--panel`, `--line`,
`--text`, `--muted`, `--accent`, `--ok`, `--watch`, `--act`, `--unknown`), not
new tokens.

**Correction to the issue text:** the issue says protein/weight targets live
in `lib/config.ts`. As of issue #9 (shipped 2026-08-04), they don't —
`nutrition_targets` is a DB table, read via `loadTargets()` in
`lib/queries.ts`. `lib/config.ts` now only holds `MAINTAIN`/`BULK` presets.
This design reads targets from `loadTargets()`.

## Decisions locked via mockups + questions

These were validated interactively (not just asserted) before writing this
spec:

- **Weight overlay**: solid actual-trend line (real regression fit) + a
  shaded "on-track" band (`expected ± concerning`, from `nutrition_targets`),
  not two competing lines and not a text-only badge.
- **Layout/hierarchy**: single column, card height signals importance —
  Weight and Protein get taller cards; Calories/Steps/RHR/HRV are compact.
  (Not a two-tier grid, not a collapsed "more" section.)
- **Sparse series (protein, calories)**: bars from a baseline, not
  disconnected dots — each bar colored by hit/miss against its target.
- **Tap-to-read**: a tap toggles a small floating label with date + value.
  This is the app's first client-side interactivity (`'use client'`) —
  approved as a small, scoped exception to the current all-server-components
  pattern.
- **Sparse/dense threshold**: <50% coverage in the displayed window ⇒ bars;
  ≥50% ⇒ connected line. A property of the data, not a per-metric hardcode.
- **Today**: excluded from the plotted series/bars entirely (matches how
  tiles and signal averages already treat Partial Days), plus a dashed
  vertical marker labeled "today (partial)".
- **Per-chart range**: each chart gets its own 30/90/365 control instead of
  one global switch, defaulting per metric (see below). This deliberately
  goes against the dataviz skill's general "one shared range control, never
  per-chart" guidance — issue #5 explicitly diagnoses the shared control as
  the actual problem (weight wants a year, protein wants a fortnight), and
  this was confirmed via mockup rather than overlooked.

## Architecture

**Chosen approach: pure data-prep functions + a presentational component.**
(Considered: (a) cramming more props into the existing `Chart` with inline
branching — rejected, mixes untestable SVG code with testable decision logic;
(b) a component per chart family (`WeightChart`, `SeriesChart`) — rejected,
duplicates axis/legend/tooltip code for no benefit since all six charts share
one anatomy.) The chosen shape mirrors this codebase's existing
`lib/signals/` pattern: pure, fixture-tested functions produce a fully
resolved value; the component that renders it stays simple.

### `lib/charting.ts` (new — pure, fixture-tested, no SQL/fetch/clock reads)

- `resolveMarkType(points: Point[], windowDays: number): 'line' | 'bar'` —
  the <50% coverage rule. Coverage = points.length / windowDays.
- `computeTrendBand(points, regression: { slope: number; intercept: number } | null, target: Targets): { trendLine: [Point, Point], band: Polygon } | null` —
  given the regression result from `loadWeightTrendLine` (see below) and
  `target.expected`/`target.concerning`, produces the line and band geometry
  for the weight chart. Returns `null` when `regression` is `null` (too few
  points — mirrors `weight_trend`'s own `HAVING count(*) >= 3`) rather than
  fabricating a line.
- `resolveBarStatus(value: number, target: number | null, expected: number): 'hit' | 'miss' | 'neutral'` —
  direction-aware, same trick as `weightTrend`/`calorieAdherence`: cut wants
  at-or-under, bulk wants at-or-over, maintenance wants a tolerance band.
  Returns `'neutral'` when `target` is null (not being steered).
- `axisTicks(points, windowDays)` — x-axis: a handful of evenly-spaced date
  labels (never one per point). y-axis: rounded "clean" values (dataviz
  skill's rule), not raw min/max.
- All pure functions, fixture-tested in `tests/charting.test.ts` following
  the existing `tests/signals.test.ts` pattern (plain `node:test`, no
  framework).

### `lib/queries.ts` (existing file, additive)

- New `loadWeightTrendLine(days: number): Promise<{ slope: number; intercept: number } | null>` —
  runs `regr_slope`/`regr_intercept` over `observations_daily` (metric
  `weight_lbs`) for the **exact** `days` window the chart is displaying,
  excluding `weight_outliers` rows (same exclusion `weight_trend` already
  applies). This is deliberately separate from the `weight_trend` view: that
  view is signal-oriented (fixed 14/28/90-day windows for coaching, slope
  only) and this is chart-oriented (arbitrary window matching whatever range
  the chart control picked, slope **and** intercept so a line can actually be
  drawn). Conflating them would couple the coaching signal's windows to
  whatever range a chart happens to display.
- `loadSeries` is unchanged; the trends page now also calls `loadTargets()`
  (already exists, from issue #9) to get the current protein/calorie/weight
  targets for target lines and bar hit/miss coloring.

### `app/ui.tsx` — `Chart` component (existing, extended)

- Axes: solid hairline (`--line`, 1px), one shade off `--panel`, never
  dashed. Dashing is reserved exclusively for target/threshold lines, so a
  dashed line always means "this is a target" — never "this is just a grid."
- Today marker: dashed vertical line at today's x-position, labeled "today
  (partial)"; today's own value is omitted from the plotted points/bars.
- Dense line charts (steps, RHR, HRV, calories when well-logged): unchanged
  polyline rendering, plus solid target line where one exists (calories only
  if `targets.calories` is set).
- Sparse bar charts (protein, and calories when under the coverage
  threshold): bars grow from **y=0**, never a truncated baseline — a bar
  chart's length is a proportionality claim, and starting anywhere above
  zero exaggerates differences (the classic truncated-bar-axis
  anti-pattern). `--act` (red) when `resolveBarStatus` says `'miss'`,
  default series color otherwise. Dashed horizontal target line at the
  target value. Line charts keep their existing windowed y-range (min–max of
  the visible data) since that convention doesn't apply to lines the way it
  does to bars.
- Weight: dots (scatter — noise, per the issue) + solid actual-trend line +
  a translucent on-track band (series hue at ~10% opacity, per the dataviz
  skill's area-fill spec), from `computeTrendBand`.
- Marker sizing: visible dot/bar stays small (mobile density), but every
  mark gets an invisible hit-area ≥24px for tap targets — the dataviz
  skill's guidance that a tiny visible mark and a tiny hit-area are two
  different things, and mobile tapping needs the larger one.

### Tap-to-read — new client component

- `ChartMarks` (new, `'use client'`) — the **only** client component in this
  app. Receives pre-computed screen coordinates, values, and dates as props;
  owns exactly one piece of state (which mark, if any, is active). No
  fetching, no business logic — purely "which mark is tapped, show its
  label." `Chart` itself stays a server component that computes all SVG
  geometry and passes the resolved marks down.
- Tap toggles a small floating `<text>`/`<rect>` label near the mark; tapping
  the same mark or elsewhere hides it.

### `app/trends/page.tsx` (existing, reworked)

- Drop the global `?d=` range switch. Each chart section gets its own range
  control (same `30`/`90`/`365` presets), defaulting per metric:
  - Weight, Steps, RHR, HRV → 90d
  - Protein, Calories → 30d
- Single-column layout; Weight and Protein cards are visually taller
  (more room for axes + band/target overlays); Calories/Steps/RHR/HRV are
  compact.
- Coverage counts (`21/90 days`) stay in the header, unchanged.

## Data flow (weight chart, as the most involved case)

1. Page reads its own range control (query param, per-chart now instead of
   page-wide) → `days`.
2. `loadSeries('weight_lbs', days)` (existing) → raw points.
3. `loadWeightTrendLine(days)` (new) → `{ slope, intercept } | null`.
4. `loadTargets()` (existing, from issue #9) → current `Targets`.
5. `computeTrendBand(points, regression, targets)` (new, pure) → trend line +
   band geometry, or `null` if too few points (chart falls back to dots-only,
   same as today when there's not enough data for `weight_trend` either).
6. `Chart` renders dots + (if present) trend line + band, axes, today
   marker; wraps marks in `ChartMarks` for tap state.

## Error handling / gaps

- No regression possible (< 3 points in window) → dots only, no
  trend/band — never a fabricated line through two points (mirrors
  `weight_trend`'s own `HAVING count(*) >= 3`).
- No target set for a phase (`targets.calories === null`) → no target line
  on that chart, `resolveBarStatus` returns `'neutral'` (no hit/miss
  coloring) rather than inventing a threshold.
- Sparse/dense is recomputed per range change — switching a chart from 30d
  to 365d can flip it from bars to line if coverage crosses 50%, which is
  correct (it's a property of what's actually in the visible window).
- Today is always excluded from the series regardless of mark type — this
  was already true for the coaching signals; the chart now matches.

## Testing

- `tests/charting.test.ts` (new): `resolveMarkType` boundary cases (49%/50%/51%
  coverage), `computeTrendBand` against known regression inputs (including
  the < 3 point / null case), `resolveBarStatus` for cut/bulk/maintain
  directions and the null-target case, `axisTicks` rounding.
- No automated test for SVG rendering or the tap interaction itself —
  consistent with how `app/ui.tsx`'s existing `Chart` has no test coverage
  today. Verified by hand in a browser (`npm run dev`) per this project's
  standing rule for UI changes.
- `npm test` and `npm run typecheck` before considering this done, per
  `CLAUDE.md`.

## Follow-ups filed for later (not this spec)

- **Whole-app visual-language refresh** — separate future spec, per your
  call to split it out. Should revisit the current status color palette
  (`--ok`/`--watch`/`--act`/`--unknown`): running it through the dataviz
  skill's validator (`validate_palette.js`) as a categorical set failed the
  lightness-band and chroma-floor checks. Not fixed here (reusing "current
  visual language" as-is per scope), but worth having as concrete input for
  that spec rather than re-discovering it later.
