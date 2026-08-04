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

## The web app

A Next.js app at **https://fitness.mattstratton.com**, deployed from `main` on
push (personal Vercel scope `mattystratton` — never TigerData's).

| Path | What |
|---|---|
| `app/page.tsx` | glance: today's tiles, then signals needing attention |
| `app/coach/page.tsx` | every signal with its reasoning |
| `app/trends/page.tsx` | charts, 30/90/365d |
| `app/settings/page.tsx` | edit nutrition targets (`nutrition_targets` table) and see the change history |
| `app/api/hae/route.ts` | HAE's push endpoint (bearer token) |
| `app/api/cron/*` | daily Liftosaur sync and freshness check |
| `lib/signals/` | the coaching rules — **pure functions, fixture-tested** |
| `lib/queries.ts` | the only place with SQL for the pages |

It exists because `/coach` can't run on Claude iOS (enterprise config blocks the
Liftosaur MCP), so coaching on a phone had no other route.

**Rules for changing it:**

- Signals stay **pure**. No SQL, no fetch, no clock reads inside a rule — that's
  what makes them fixture-testable and reusable as LLM tools later. Fetching
  belongs in `lib/queries.ts`.
- Signals return `unknown` when there isn't enough data. Never collapse that into
  `ok`; this dataset produces it constantly.
- **Today is read from raw `observations`, not `observations_daily`.** The
  continuous aggregate stops consulting raw rows once it materialises a bucket,
  which served a stale 688 kcal against a real 1556. See `lib/queries.ts`.
- Charts never interpolate across gaps and tiles never show 0 for unlogged.
- Auth: `lib/allowlist.ts` is the security boundary. `proxy.ts` guards the UI and
  deliberately excludes `/api` so HAE and the crons work.

`npm run dev` locally; `npm test` and `npm run typecheck` before pushing.

## Record what we learn — this is not optional

`docs/migration-log.md` is raw material for a writeup and it is **part of the
work, not a nice-to-have**. Update it in the same change that produced the
finding, never in a batch at the end. Findings evaporate: the numbers get
re-measured, the wrong assumption gets fixed and forgotten, and six weeks later
only the final state survives — which is the least interesting version.

**Write an entry whenever any of these happen:**

- A wrong assumption is corrected — *especially* one that looked right. Record
  what was assumed, what the data said, and how it was caught.
- Real data breaks something synthetic data or a passing test did not.
- A measured number lands (compression ratio, row counts, coverage, timings).
  Include how it was measured; a figure without its method can't be re-checked.
- Something is configured that appears correct and does nothing. This project has
  produced several and they are the best material in the log.
- A platform behaves differently from its documentation, or from a reasonable
  reading of it.

**Keep the three destinations distinct:**

| Where | What |
|---|---|
| `docs/adr/` | A decision that is hard to reverse, surprising, and a real trade-off. Final form, no narrative. |
| `docs/migration-log.md` | What was *discovered*, what was *wrong*, and the numbers. Narrative and rough is fine. |
| Commit messages | Why this specific change. Not a substitute for the log — commits are hard to mine six weeks later. |

**Be honest in it.** Entries where the first three explanations were wrong are
more useful than entries where everything worked. The through-line so far is that
everything real in this project was found by *running* it, not by reading it —
don't sand that off.

Numbers quoted in the log get re-measured before publishing; there's a checklist
at the bottom of the file. Add to it rather than trusting a figure to still hold.

## Live actions

The **Liftosaur MCP** (`mcp__liftosaur__*`) is still the tool for reading or
editing the program and adjusting 1RMs. After any write, `npm run sync-liftosaur`.

## Rules

- Never commit `fitness.db`, `.env`, `exports/`, or `node_modules` (all gitignored).
- Ingest is idempotent; re-running any sync or the backfill is always safe.
- Deploy only to the **personal** Vercel scope — `vercel --prod --scope mattystratton`.
