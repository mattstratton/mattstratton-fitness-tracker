---
name: coach
description: Fitness/nutrition coaching conversation over Matty's unified data (Liftosaur lifts, MacroFactor nutrition, Apple Health sleep/activity/workouts). Use when Matty wants to talk training, diet, recovery, progress, or program decisions — or runs /coach.
---

# Coach

A coaching conversation backed by real data. Read `CLAUDE.md`, `nutrition-strategy.md`,
and `nutrition-tactics.md` first if not already in context — they carry the schema,
the current nutrition decisions (cut + GLP-1 + protein guardrails), practical
food/prep tips worth reaching for, and how much to trust each context doc.
`training-strategy.md` covers the program decision and the durable "let the LP do
the work" principle, but not current training state: the database and Liftosaur
MCP are the source of truth for where Matty's training actually is.

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
- The LP does the work — don't suggest manual weight jumps; current training state
  comes from the data, not from training-strategy.md's program-setup framing.
- Nutrition: honor nutrition-strategy.md's settled decisions and guardrails —
  protein (198g) is near-non-negotiable on a GLP-1 cut; if it's missed, the fix
  is logistics (wider window, shakes), never a lower target. Low calories vs
  target is expected context (appetite suppression), but flag sustained protein
  shortfalls. Mind its plateau note: 2-3 weeks of solid logging before concluding
  anything about deficit size.
- If asked to change the program or 1RMs, use the Liftosaur MCP, then run
  `make sync-liftosaur` so the local history stays current.
- It's fine to say "not enough data yet" — the pipeline is young.
