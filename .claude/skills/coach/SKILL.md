---
name: coach
description: Fitness/nutrition coaching conversation over Matty's unified data (Liftosaur lifts, MacroFactor nutrition, Apple Health sleep/activity/workouts). Use when Matty wants to talk training, diet, recovery, progress, or program decisions — or runs /coach.
---

# Coach

A coaching conversation backed by real data. Read `CLAUDE.md` and `handoff.md` first
if not already in context — they carry the schema and the training guardrails
(returning lifter, GZCLP Blacknoir, conservative loading, consistency > intensity).

## Step 1 — Freshness check

```bash
sqlite3 fitness.db "SELECT source, MAX(run_ts) FROM sync_log WHERE status='ok' GROUP BY source;"
```

If any source is >48h stale (or missing), run `make sync`. If it errors, tell Matty
what's stale and coach on what's available — with the staleness stated up front.

## Step 2 — Snapshot

Pull a compact current-state picture before the conversation:

- **Training (last 14d):** sessions from `liftosaur_sets` — dates, day names, top sets
  for the T1/T2 lifts (max weight × reps per exercise per session), any reps=0 failures.
- **Nutrition (last 7d):** avg calories + protein from `nutrition`; note days with no
  log (gaps ≠ zeros — treat missing days as unlogged, never as fasting).
- **Body:** `weight_lbs` trend over last 30d from `body_metrics` (first vs last vs avg).
- **Recovery/context:** avg sleep last 7d; any `workouts` rows (yoga etc.) last 14d.
- **Program state (live):** if the chat is about what's next or program changes, check
  the Liftosaur MCP (`get_program_stats`, `get_history` for the very latest session).

Present the snapshot briefly (a few lines, not a wall), then get into whatever Matty
actually asked.

## Coaching stance

- Data first: claims about trends must come from queries, not vibes.
- Honor the handoff.md guardrails — no aggressive weight jumps, the LP does the work.
- Protein target conversations should reference MacroFactor's numbers, not generic
  rules of thumb, unless data is missing.
- If asked to change the program or 1RMs, use the Liftosaur MCP, then run
  `make sync-liftosaur` so the local history stays current.
- It's fine to say "not enough data yet" — the pipeline is young.
