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
- `handoff.md` — **historical snapshot** of the June 2026 comeback setup. The
  program choice and structure it documents still stand, but its picture of
  Matty's state (fresh off a layoff, "insultingly easy" starting weights) is
  stale — weeks of training have happened since. For current training state,
  trust `fitness.db` and the Liftosaur MCP over anything in that doc. Its one
  durable principle: let the linear progression do the work, don't manually
  jump weights.

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

Before coaching on the data, check `sync_log`: if the latest 'ok' run for a source is
>48h old, run `make sync` first (or warn if it fails). HAE data arrives via a nightly
iCloud export; a gap usually means the phone app needs attention, not the pipeline.

## Live actions

The **Liftosaur MCP** (`mcp__liftosaur__*`) is still the tool for live things:
reading/editing the program, checking what's next, adjusting 1RMs. `fitness.db` is the
analytical history; the MCP is current state. After MCP writes, `make sync-liftosaur`
refreshes the local copy.

## Rules

- Never commit `fitness.db`, `.env`, exports, or logs (gitignored — keep it that way).
- Ingest is idempotent; re-running any sync is always safe.
- Python is `/opt/homebrew/bin/python3` (system 3.9 is too old for these scripts).
