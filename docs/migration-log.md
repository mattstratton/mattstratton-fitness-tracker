# Migration log — raw material for the writeup

Running notes from moving this pipeline off SQLite. **This is not an ADR.** ADRs record
what we decided and why, in their final form. This records what we *discovered*, what we
got *wrong*, and the numbers — the things a blog post needs and an ADR deliberately
strips out.

Append freely, don't tidy. Rough is fine; the point is that it exists in six weeks.

> Real body-composition numbers are fine in here and fine in the post — Matty is happy
> being public about his own health metrics, and the candour is a feature of the writeup
> rather than a risk to manage. The one thing that must never land in this file is
> credentials: connection strings, the HAE bearer token, `LIFTOSAUR_API_KEY`. Those go in
> `.env` and Vercel env vars, and nowhere near a doc whose whole purpose is to be copied
> into something public.

---

## The story in one line

A personal health pipeline that had already lost data twice got moved from SQLite to
TimescaleDB — and the migration turned out to be a redesign, because interrogating the
model surfaced eight defects a straight port would have carried forward.

---

## Before and after

| | SQLite | Tiger Cloud |
|---|---|---|
| Size | 840 KB | 87 MB of source JSON |
| Observations | ~280 rows across 4 tables | **56,402** |
| Workouts | 30 | **806** |
| Metrics modelled | 17 | **74** (all of them) |
| Health history starts | 2026-04-19 | **2016-01-01** |
| Lifting history | 2024-02-19 → present (unchanged) | same |

Ten years of data was sitting in HealthKit the whole time. The old pipeline could see
three months of it.

---

## The bug that actually cost data

Worth leading with, because it's the one no schema change catches.

An iOS update silently dropped Health Auto Export's HealthKit **read** permission for
Weight & Body Mass and Lean Body Mass — while leaving Body Fat % and BMI intact. Exports
kept running. They kept succeeding. They contained empty arrays for exactly two metrics.
`sync_log` recorded `status='ok'` every hour for five days.

The lesson that survived into the new design: **never ask "did the sync run", ask "is the
data current"**. `data_freshness` grades data recency per source and ignores run status
entirely. The one automatic-source failure is a hard error; user-driven gaps only warn,
because those might just be travel.

---

## Defects found by interrogating the model

All verified against the live data before being believed.

| Defect | Evidence |
|---|---|
| `tier` column never populated | NULL in **2,416 of 2,416** rows; the sync hardcoded `None` |
| `is_completed` wasn't a fact | `= (reps > 0)` in **2,416 of 2,416** rows — a restatement, not data |
| Sleep stages stored in the wrong unit | siblings in minutes, `stages_json` raw in **hours**. Anything summing stages against total sleep was wrong by 60× |
| `workouts` double-counted training | **27 of 30** rows were `Traditional Strength Training` — Apple's shadow copies of Liftosaur sessions |
| Liftosaur could re-date its own history | bare `.astimezone()` (machine's *current* zone) combined with DELETE-INSERT of all 2.5 years every run. One sync from another timezone rewrites every near-midnight session. Never fired — every sync so far ran from Central |
| 57 metrics discarded | unmapped names went into a variable literally called `unknown`, then were thrown away |
| Schema comment documented a format that never existed | said `'benchPress_barbell'`; the data has always been `'Bench Press'` |
| `CLAUDE.md` described the wrong table | called `workouts` "yoga, walking, etc." — it's 90% strength training |

### `sync_log`, the table that logged everything and told you nothing

- **611 rows in 12 days.** That's 25% of the row count of 2.5 years of actual training.
- **115 `partial` + 19 `error` out of 611** — 22% of runs were degraded.
- Only the *most recent* degraded run was ever surfaced anywhere.
- Nothing ever pruned it.

It is now `ingest_runs`, with a 90-day retention policy and a schema that records what a
run *found* rather than that it happened.

---

## Things I assumed and had to un-assume

The honest list. Most of these are better story beats than the things that went right.

1. **`segmentby = 'metric'` was obviously correct.** It wasn't. Measured: a yearly chunk
   averages ~69 rows per metric (139 in the densest year, single digits for
   micronutrients) against a >100-rows-per-segment-value guideline. Dropped it entirely;
   `metric` went into `orderby` instead, where Timescale auto-creates minmax + firstlast
   sparse indexes that preserve batch exclusion anyway. *Assume, then measure, then
   delete the assumption.*

2. **Monthly chunks.** Wrong for a reason I hadn't considered: HAE restates a day for
   about a week afterwards. Yearly chunks keep that entire restatement window inside the
   current *uncompressed* chunk, so a revision never has to decompress anything. The
   chunk interval was decided by write semantics, not by size.

3. **HAE caps exports at 90 days.** It *warns* above 90 days. It doesn't refuse. Ten
   years came out fine. An unverified UI warning nearly cost eight years of history.

4. **The Vercel 4.5MB body limit matters** → retracted it when a 90-day export was 1.2MB
   → it turned out to be 87MB across all years. Right conclusion, wrong reasoning, twice.
   The backfill is a manual local step regardless, which is the actual answer.

5. **Reconciling workouts by date.** Suppressing every Apple strength row on a day that
   has a Liftosaur record silently eats a genuine second session. Fixed to one-to-one
   matching on closest start time. Caught only because a test asserted a two-a-day.

6. **Forgot `enable_columnstore` auto-creates a 7-day policy** (TimescaleDB 2.23+), so
   adding a custom one errors. Needs `remove_columnstore_policy` first. The skill
   documentation said so and I skimmed it.

7. **Recommended append-only-on-change.** Matty pushed back. He was right: HAE pushes
   *daily*, not hourly (the hourly figure was the old pipeline polling a static file), so
   the row saving was illusory and would have bought a read-before-write on every point.

---

## Measured surprises

- **Zero unit drift.** 8 export files, 10 years, 74 metrics — not one metric ever changed
  units. Genuinely unexpected, and it means the EAV model's canonical-unit check starts
  clean rather than as a minefield.
- **`step_count` is the only metric with 100% coverage.** Everything else has holes.
- **Watch-wear halved.** Resting-HR coverage: 68% of days in 2025, 39% in 2026.
- **Sleep is a rounding error.** 16 data points in 19 months — 6.6% of 2026.
- **2019: 3,473 observations, one workout.**
- **2024: 331 workouts** and 23MB of JSON, most of it GPS route data we don't ingest.
- **Basal + active energy were never stored** — despite being the denominator that makes
  a deficit *measurable* rather than assumed, which on a GLP-1 cut is the whole question.
- HealthKit has been quietly recording **toothbrushing** (3 points) and **handwashing**
  (18). Under the new model they land for free and nobody looks at them, which is exactly
  right.

---

## Ideas the post should probably build around

- **The reframe that dissolved the hard problem.** "Upsert or append?" was unanswerable
  until the real question surfaced: *is the thing you're storing an observation about a
  day, or a report that arrived at a time?* The old schema couldn't tell those apart,
  which is precisely why both of its data-loss bugs were invisible. Separate them and the
  write model stops being a judgement call.
- **`last(value, reported_at)` in a continuous aggregate literally is last-write-wins.**
  The semantics SQLite expressed as `ON CONFLICT DO UPDATE` — while destroying the
  history — become a materialized aggregate that keeps it.
- **EAV, against instinct.** Normally an anti-pattern; here it's what makes enabling a
  75th metric a toggle in an iPhone app rather than a migration. The catalog table gives
  back the two things EAV costs you (canonical units, human names) as *data*.
- **Monitoring the wrong things trains you to ignore alerts.** Sleep has 6% coverage;
  freshness-monitoring it would fire constantly, which is how a real five-day weight gap
  survives five days.
- **The promise we broke.** The README said "health data and secrets never leave this
  machine." It's now in a hosted database. A dogfooding post that omits the part where
  you uploaded your own body-fat percentage isn't a candid post.

---

## Numbers to re-measure before publishing

- [ ] Compression ratio via `hypertable_compression_stats('observations')`, before/after,
      stated honestly — including that it compresses well *partly because* it stores
      restatements.
- [ ] Final row counts after backfill (the 56,402 figure is from the export scan, not
      from loaded rows).
- [ ] Lines of code deleted at cutover (estimated ~150 for the iCloud/launchd machinery
      alone — get the real `git diff --stat`).
- [ ] Query timing on a representative `/coach` question, SQLite vs Tiger Cloud. Expect
      SQLite to win on a local 840KB file; say so if it does.
