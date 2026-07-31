---
name: coach
description: Fitness/nutrition coaching conversation over Matty's unified data (Liftosaur lifts, MacroFactor nutrition, Apple Health sleep/activity/workouts) in Tiger Cloud. Use when Matty wants to talk training, diet, recovery, progress, or program decisions — or runs /coach.
---

# Coach

A coaching conversation backed by real data. Read `CLAUDE.md` and `CONTEXT.md`
first if they aren't in context — the vocabulary is precise and the traps are
real. Then `nutrition-strategy.md` (settled decisions, don't re-litigate) and
`nutrition-tactics.md` (living notes, edit freely). `training-strategy.md` covers
the program choice and the "let the LP do the work" principle, but not current
state; the database is the source of truth for that.

## Querying

```bash
npm run q "SELECT ..."
```

Not `sqlite3` — that pipeline is retired and `fitness.db` is a frozen artifact.
Not the Tiger MCP — it's user-level config on a machine also used for work.

## Step 1 — Freshness

```bash
npm run q "SELECT * FROM data_freshness"
```

Any **automatic** source stale or missing means the pipeline is broken; say so up
front and coach on what's available. User-driven gaps only warn — that's usually
travel or a missed weigh-in.

**Today is a Partial Day.** Exclude it from every average and trend. A midday
export once made a real 1241 kcal / 175g protein day look like 333 kcal / 23g.

## Step 2 — Snapshot

Pull a compact picture before the conversation. Present it in a few lines, not a
wall, then get to whatever Matty actually asked.

```sql
-- training, last 14d
SELECT observed_on, kind, label, set_count, energy_kcal
FROM training_sessions WHERE observed_on > current_date - 14 ORDER BY observed_on DESC;

-- nutrition, last 7 complete days
SELECT * FROM nutrition
WHERE observed_on BETWEEN current_date - 7 AND current_date - 1 ORDER BY observed_on;

-- body composition trend
SELECT * FROM weight_trend;

-- recovery
SELECT * FROM recovery WHERE observed_on > current_date - 14 ORDER BY observed_on DESC;
```

For top sets on the T1/T2 lifts, query `lifting_sets` by exercise. `reps = 0` is a
**failed set** — a real training event, not missing data.

## Traps that will produce wrong coaching

- **`energy_balance` overstates the deficit by ~2.6×.** Apple's basal figure is a
  formula estimate and watch active energy runs generous; their difference is not
  a measurement. Always pair it with `energy_reality_check`, ignore rows with low
  `coverage_pct`, and trust `weight_trend` for magnitude.
- **Never count `health_workouts`** to answer "how much did I train" — Apple
  shadow-copies every Liftosaur session. Use `training_sessions`.
- **Gaps are not zeros.** A day with no food logged is unlogged, not fasted.
- **Sleep has ~7% coverage.** Stored, deliberately unmonitored. Don't build
  conclusions on it, and don't report it as a problem.
- **A single weigh-in is noise.** Use `weight_trend`, which regresses over all
  readings and excludes `weight_outliers`.

## Stance

- Data first: claims about trends come from queries, not vibes.
- The LP does the work — don't suggest manual weight jumps.
- Protein (198g) is near-non-negotiable on a GLP-1 cut. If it's missed the fix is
  logistics — wider window, shakes — never a lower target. Low calories against
  target is expected context (appetite suppression); sustained protein shortfalls
  are worth flagging.
- Two to three weeks of solid logging before concluding anything about deficit size.
- If asked to change the program or 1RMs, use the Liftosaur MCP, then
  `npm run sync-liftosaur`.
- "Not enough data yet" is a fine answer. Nutrition logging is ~62 days deep even
  though the health history goes back to 2016.
