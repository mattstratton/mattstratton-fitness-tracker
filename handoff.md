# GZCLP Comeback — Handoff to Claude Code

**Goal:** Finish setting up a returning-from-layoff GZCLP run in Liftosaur (via the Liftosaur MCP) and fix three starting weights that are set too heavy. Most of the work is already done in the app; this is the last mile.

---

## Who / situation

- Returning lifter. Last consistent training block ended ~April 2025. A brief failed restart happened late Oct 2025. Effectively ~8+ months off as of June 2026.
- Trains in a home garage gym, works from home. Logistics are not the constraint; consistency is.
- Tracks everything in Liftosaur. Wants to run **GZCLP, Blacknoir version** (already cloned).

## Program decision (already made, do not re-litigate)

- Running **GZCLP: Blacknoir version** — Liftosaur program id **`viohtrec`** (this is the fresh clone made 2026-06-15, and it is the current program).
- Using the **modified** exercise templates (`t1_modified` / `t2_modified` / `t3_modified`), NOT advanced. This is intentional — returning lifter, keep it boring.
- Blacknoir was chosen specifically because it drops the disliked 10x1 T1 stage. The no-10x1 cascade (2x5 → 3x3 → 4x2 → 5RM retest → reset to 85%) is wired in correctly. Leave it.
- Increments are correct: squat/deadlift +10 lb per session, bench/OHP +5 lb. Leave them.
- T3 slots are Lat Pulldown (cable) and Bent Over Row (barbell), matched to available equipment. Leave them.

**Verdict on current setup: structurally correct. One problem remains — starting weights.**

## Guiding principle for the weights

Start deliberately light. The linear progression re-adds weight every session, so an undershoot self-corrects in a couple weeks. Muscles rebound fast after a layoff; tendons/connective tissue readapt slower, and that lag is where comeback injuries happen. Light start protects the slow tissue. Undershooting costs a few boring sessions; overshooting costs a stall, a reset, or an injury.

---

## The problem found in the Liftosaur export

In Liftosaur the 1RM (`rm1`) is stored **globally per exercise**, so the new clone inherited stale maxes from the last training block. The **squat 1RM was manually lowballed, but bench / deadlift / OHP were not** — they're sitting near the last real (and in bench's case, *failed*) working weights.

Smoking gun from the user's own history, 2025-10-27:

```
benchPress  (0 reps, 125 lb)  (0 reps, 125 lb)  (0 reps, 125 lb)
```

Three sets, zero reps completed at 125 lb. They walked in detrained and couldn't move it. The new program's **T1 bench (Day 3) is set to ~126 lb for a 5+ top set** — i.e. it would re-stage the exact failure.

Comparison of last real working sets vs. what the new program currently prescribes for the T1 top set:

| Lift | Last real working set | New T1 working (current) | Status |
|---|---|---|---|
| Squat | 235x3 (Jul) / 202x5 (Jun) | ~127.5 | Properly light — keep |
| Bench | failed 0 reps @ 125 (Oct) | ~126 | Too heavy — fix |
| Deadlift | 207x6 (Jun) / 190 (Oct) | ~173 | Too heavy — fix |
| OHP | 100x3 (Jul) / 85x5 (Oct) | ~87 | Too heavy — fix |

T1 working weight = 75% of the stored 1RM. So fixing the working weights = lowering the stored 1RMs.

---

## ACTION ITEMS for Claude Code (via Liftosaur MCP)

Update the global per-exercise 1RM (`rm1`) values. Exercise keys and current → target:

| Exercise key | Current 1RM | New 1RM | Resulting T1 (75%) | Resulting T2 (55%) |
|---|---|---|---|---|
| `benchPress_barbell` | 168 | **140** | ~105 | ~77 |
| `deadlift_barbell` | 231 | **190** | ~143 | ~105 |
| `overheadPress_barbell` | 116 | **100** | ~75 | ~55 |
| `squat_barbell` | 173 | **leave as-is** | ~127.5 | ~95 |

Do **not** touch:
- `squat_barbell` (already correct)
- `latPulldown_cable` (T3, 116) and `bentOverRow_barbell` (T3, 95) — accessory work, fine as-is
- Any set/rep schemes, progression scripts, increments, or template selections

These targets are intentionally conservative. If the user wants slightly less-light, bench can go up to ~145 and deadlift to ~200, but do not exceed those without a reason — bench especially must stay well under the 125 failure point.

## Verification after editing

Re-read the program and confirm the upcoming working weights land approximately:
- Day 1: Squat T1 ~127.5, Bench T2 ~77, Lat Pulldown T3
- Day 2: OHP T1 ~75, Deadlift T2 ~105, Bent Over Row T3
- Day 3: Bench **T1 ~105** (this is the critical one — must be well below 125), Squat T2 ~95, Lat Pulldown T3
- Day 4: Deadlift T1 ~143, OHP T2 ~55, Bent Over Row T3

(Exact numbers will vary slightly with plate rounding — approximate is fine.)

## Notes

- Nothing here is permanent; all values are editable later. The point is just to set a safe seed and let the LP climb.
- The old programs in the account (`gzclp`, `gzcl-the-rippler`, `gzclp-blacknoir`, `the531bbb`) are history/reference — do not modify or delete them.
- Expect Day 1 to feel insultingly easy. That is the intended on-ramp, not a mistake. The job after setup is hitting "Start" two days in a row.