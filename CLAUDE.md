# Fitness tracker — Claude context

Personal fitness data in **TimescaleDB on Tiger Cloud**. Query it with
`npm run q "SELECT ..."` — never `sqlite3`, and never the Tiger MCP.

`fitness.db` still exists on disk but is a **frozen artifact** of the retired
SQLite pipeline. Do not read it for anything except `npm run diff-oracle`.

## Why not the Tiger MCP

It is user-level configuration on a machine also used for work, so it points at
whichever Tiger Cloud project was last selected. `npm run q` reads `DATABASE_URL`
from this repo's `.env`, so the database is chosen by the working directory. It
also refuses writes unless `ALLOW_WRITES=1`.

## The person

Matty. Lifter on **GZCLP: Blacknoir version** in Liftosaur (program `viohtrec`),
home garage gym. Cutting on a GLP-1 — see `nutrition-strategy.md` for the settled
decisions (1660 kcal / 198g protein, 10am–8pm window) and don't re-litigate them.

## Vocabulary

**Read `CONTEXT.md` before reasoning about this data.** These terms are precise
and the schema depends on them:

- **Observation** — a scalar fact about one Metric on one Observed Day.
- **Report** — one delivery of an Observation. Several can describe the same day
  and disagree; the most recent wins.
- **Observed Day** — the calendar day in `America/Chicago`. Always.
- **Partial Day** — today. Still accumulating. **Exclude from every average.**
- **Restatement** — a later Report revising an earlier one. Normal.

## Tables and views

| Object | What it is |
|---|---|
| `observations` | append-only Report log. Raw. Rarely what you want. |
| `observations_daily` | **current truth** — `last(value, reported_at)` per day/metric |
| `nutrition` `activity` `body` `sleep` `recovery` | pivots over `observations_daily` |
| `energy_balance` | intake vs Apple's expenditure — **see the caveat below** |
| `energy_reality_check` | how far `energy_balance` disagrees with the scale |
| `weight_trend` / `weight_outliers` | lb/week via regression; bad readings |
| `lifting_records` / `lifting_sets` | Liftosaur. `reps = 0` is a failed set, not missing. |
| `health_workouts` | Apple's view of sessions, with energy and duration |
| `training_sessions` | **reconciled** — use this to count training, not the two above |
| `data_freshness` | per-source recency |
| `metric_catalog` | canonical units and an `attention` grade |

81 metrics exist. Anything not in a view is queryable by name in
`observations_daily` — `SELECT DISTINCT metric FROM observations_daily`.

## Traps

- **`energy_balance` overstates the deficit by roughly 2.6×.** Apple's basal
  figure is a formula estimate and watch active energy runs generous. Always read
  `energy_reality_check` alongside it, and ignore rows with low `coverage_pct`.
  Use it for direction; use `weight_trend` for magnitude.
- **Counting `health_workouts` double-counts lifting** — Apple shadow-copies every
  Liftosaur session. Use `training_sessions`.
- **Gaps are not zeros.** An unlogged day is unlogged, not fasted.
- **Today is partial.** A midday export once made a 1241 kcal day look like 333.
- **`program` is sometimes an app**, not a program: 1,218 rows say `Hevy`, which
  is imported history.
- Sleep has ~7% coverage. It is stored but deliberately unmonitored; don't build
  conclusions on it.

## Freshness

```bash
npm run q "SELECT * FROM data_freshness"
```

Any **automatic** source (steps, active/basal energy, exercise minutes) that is
`stale` or `missing` means the pipeline is broken. User-driven sources only warn —
that may just be travel.

Never judge freshness from `ingest_runs`. It records that a run happened and what
it found; the failure this system exists to catch is a run that succeeds and
delivers nothing.

## Live actions

The **Liftosaur MCP** (`mcp__liftosaur__*`) is still the tool for reading or
editing the program and adjusting 1RMs. After any write, `npm run sync-liftosaur`.

## Rules

- Never commit `fitness.db`, `.env`, `exports/`, or `node_modules` (all gitignored).
- Ingest is idempotent; re-running any sync or the backfill is always safe.
- Deploy only to the **personal** Vercel scope — `vercel --prod --scope mattystratton`.
