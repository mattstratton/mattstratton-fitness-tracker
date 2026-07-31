# Fitness tracker — Claude context

Personal fitness data pipeline. All health data is in `fitness.db` (SQLite, local
only). Query it with `sqlite3 fitness.db "..."` via Bash — no MCP server needed.

## The person

Matty. Lifter on **GZCLP: Blacknoir version** in Liftosaur (program id `viohtrec`),
home garage gym, training consistently since the June 2026 restart. Cutting on a
GLP-1 — see `nutrition-strategy.md` for the settled nutrition decisions (1660 kcal /
198g protein targets, 10am–8pm eating window, and the guardrails around all of it).
Logs food in MacroFactor; nutrition arrives here via Apple Health.

## Context docs — how much to trust them

- `nutrition-strategy.md` — **current** (July 2026). The settled decisions and
  guardrails hold until Matty says otherwise; don't re-litigate them.
- `nutrition-tactics.md` — **living notes**, not settled decisions. Practical
  food/prep tips and patterns noticed from the logs (protein-dense options, what
  actually separates good vs. bad protein days). Update it freely as we learn
  more — unlike `nutrition-strategy.md`, nothing in here is locked.
- `training-strategy.md` — the program decision (GZCLP: Blacknoir, program id
  `viohtrec`, templates/increments) plus the durable guiding principle: let the
  linear progression do the work, don't manually jump weights. Trimmed down from
  the original June 2026 comeback handoff doc once its one-time setup work
  (fixing inflated starting 1RMs) was done. For current training state — what's
  next, current weights, T3 exercise selection — trust `fitness.db` and the
  Liftosaur MCP over this doc; it won't track that.

## Tables (see schema.sql for full DDL)

| Table | Grain | Notes |
|---|---|---|
| `nutrition` | 1 row/day | calories, protein_g, carbs_g, fat_g (from MacroFactor) |
| `body_metrics` | day × metric | `weight_lbs`, `body_fat_percentage`, ... |
| `sleep` | 1 row/day | asleep/in-bed minutes, stages_json |
| `activity` | 1 row/day | steps, active_energy_kcal, exercise_minutes |
| `workouts` | 1 row/workout | Apple Health workouts: yoga, walking, etc. |
| `liftosaur_sets` | 1 row/set | full lifting history; reps=0 means a failed set |
| `sync_log` | 1 row/sync run | freshness + error tracking |

## Query patterns

Lifting days: `SELECT DISTINCT date FROM liftosaur_sets`.
Cross-source join example — protein on lifting vs rest days:

```sql
SELECT CASE WHEN l.date IS NULL THEN 'rest' ELSE 'lift' END AS day_type,
       ROUND(AVG(n.protein_g)) AS avg_protein
FROM nutrition n
LEFT JOIN (SELECT DISTINCT date FROM liftosaur_sets) l ON l.date = n.date
GROUP BY day_type;
```

Exercise progression: filter `liftosaur_sets` by exercise name (display names like
'Bench Press', 'Squat', 'Deadlift', 'Overhead Press'), order by date, look at max
weight × reps per session.

## Freshness

Run `make check` before coaching on the data. It reports the newest date per table
and exits nonzero when the pipeline genuinely isn't delivering. If it flags anything,
`make sync`, then re-check.

**Don't use `sync_log` to judge freshness.** It records whether an ingest *ran*, not
whether data arrived. In July 2026 it logged `ok` every hour for five days while an
iOS update had dropped HAE's HealthKit read permission for weight — syncs succeeded,
no weight came through. `check_freshness.py` splits sources accordingly: `activity`
and `sleep` are written by the Watch unprompted, so a gap there is always a broken
pipeline (hard failure), while `nutrition`/`weight`/`workouts` depend on Matty logging
or weighing in, so a gap warns but may just be travel.

**Today's row is always a partial day** — HAE exports whatever has been logged so far.
Exclude it from averages and trends.

Two known failure modes worth recognizing:

- **Phone-side.** HAE stops exporting a metric, or exports empty arrays for it. Fix is
  on the phone (Settings → Health → Data Access & Devices → Health Auto Export), not
  in this repo. Compare metrics against each other in
  `AutoSync/HealthMetrics/<metric>/YYYYMMDD.hae` — a 70-byte file is an empty payload,
  so one metric empty while its neighbours have data means a permission, not a gap.
- **Dataless iCloud files.** Exports can sit as metadata-only placeholders that a
  launchd agent can't materialize, failing with `EDEADLK`. `read_export()` in
  `ingest_hae.py` handles this via `brctl download`; see its docstring.

## Live actions

The **Liftosaur MCP** (`mcp__liftosaur__*`) is still the tool for live things:
reading/editing the program, checking what's next, adjusting 1RMs. `fitness.db` is the
analytical history; the MCP is current state. After MCP writes, `make sync-liftosaur`
refreshes the local copy.

## Rules

- Never commit `fitness.db`, `.env`, exports, or logs (gitignored — keep it that way).
- Ingest is idempotent; re-running any sync is always safe.
- Python is `/opt/homebrew/bin/python3` (system 3.9 is too old for these scripts).
