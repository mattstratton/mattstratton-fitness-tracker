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

8. **Assumed "lifting" meant one string.** The first `training_sessions` view hardcoded
   `'Traditional Strength Training'`. Parsing ten years of real workouts found **20
   distinct types**, of which `Functional Strength Training` (47 sessions) is also
   lifting and was being misfiled as "other" — and **285 Indoor Cycling** sessions made a
   binary lifting/not-lifting split useless anyway. Replaced with a `workout_types`
   lookup table plus an `unclassified_workout_types` view so the next unseen type gets
   noticed instead of silently defaulting forever. *Every hardcoded string in this
   migration that met real data turned out to be an assumption.*

9. **Nearly reported a clean typecheck that wasn't.** `npx tsc --noEmit | tail -20 && echo
   CLEAN` chains off `tail`'s exit code, not `tsc`'s, so it printed CLEAN over five
   visible errors. Check exit codes explicitly. Not a migration lesson, but a good
   reminder that "the command printed something reassuring" is not verification.

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
- **Apple knows about 4.4× more training than Liftosaur does.** 806 Apple workouts back
  to 2016 versus 182 Liftosaur sessions from 2024. The lifting app everyone thinks of as
  the training record holds less than a quarter of the training history.
- **The parser emits more rows than the source has points**: 56,402 points → **68,858
  observations**, because `heart_rate` fans out to min/max/avg and `sleep_analysis` to
  six stage metrics. Worth stating carefully in the post so the numbers reconcile.
- **Zero dev dependencies lasted right up until deployment.** Node 26 ships native
  TypeScript stripping, `node:test` and `node:sqlite` in core, so the whole port ran with
  only `pg` installed — pleasing continuity with the stdlib-only Python it replaced. Then
  Vercel killed it, and the reason is a genuinely interesting incompatibility:
  - Node's native TS runner **requires** `.ts` in relative import specifiers. `./dep.js`
    and `./dep` both fail. (Tested all three.)
  - Vercel **transpiles** `.ts` to `.js` but does not rewrite specifiers, so
    `api/hae.js` shipped asking for `lib/db.ts`, which no longer existed:
    `ERR_MODULE_NOT_FOUND: Cannot find module '/var/task/lib/db.ts'`.

  Two correct-looking toolchains with exactly opposite requirements, and no
  configuration that satisfies both. Resolved by using `.js` specifiers (which match
  Vercel's output) and adding `tsx` to run them locally. One dev dependency, and the code
  is now portable to any TS toolchain instead of depending on a Node-version-specific
  behaviour. Worth telling honestly rather than quietly dropping the zero-dep claim.

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

## Backfill results (local TimescaleDB 2.29, 2026-07-31)

Ten years loaded from 87MB of JSON in **2.2 seconds**.

| | |
|---|---|
| Observations | **68,858** (from 56,402 source points; `heart_rate`→3, `sleep_analysis`→6) |
| Workouts | **790** stored from 806 parsed — 16 were duplicates *within* single export files |
| Distinct metrics | 81 |
| Unit anomalies | **0** |
| Unclassified workout types | **0** |
| Idempotency | second run: identical counts |

### On Tiger Cloud (service `fitness`, 0.5 CPU / 2 GB, us-east-1)

Same load, 7 seconds over the network. Identical counts, zero anomalies, and
compressed chunks query correctly (1,936 rows read out of the 2017 columnstore chunk).

| | |
|---|---|
| Before compression | 13 MB |
| After | **1,480 kB** across 11 chunks |
| **Compression ratio** | **8.8×** |
| `observations` total | 2,480 kB |
| Whole database | 28 MB |

**Publish 8.8×, not the 11.9× measured locally.** The local figure was inflated by my own
churn: re-running the idempotent backfill leaves dead tuples, which bulk the uncompressed
"before" without adding any real data. Tiger Cloud was a single clean load. A neat little
lesson in accidentally benchmarking your own test loop — and an argument for measuring
compression on a freshly loaded table, never one you've been iterating against.

Sessions over ten years: **399 cardio, 300 lifting, 60 mobility, 31 other.** The lifting
app holds 182 of them.

### Real data broke things synthetic data didn't

- **Duplicate workouts inside one export file.** The 2016–2018 archive repeats sessions,
  and Postgres refuses to let `ON CONFLICT DO UPDATE` touch a row twice in one statement.
  Fixed in the parser (not the loader), since a push payload could carry the same thing.
- **Continuous aggregates can't be created inside a transaction**, which the migration
  runner wrapped everything in. Needed `WITH NO DATA` plus a `migrate:no-transaction`
  opt-out marker.
- **20 workout types, not one.** See wrong turn #8.

### Two findings that are about the data, not the pipeline

1. **`energy_balance` overstates the deficit by ~2.4×.** Last 20 days: intake 1,542 kcal,
   Apple expenditure 3,084, net −1,542/day → predicts ~3 lb/week. Actual trend over the
   same window (277.1 → 271.9) is ~1.25 lb/week, implying a real deficit nearer −625.
   `basal_energy_burned` is a formula estimate from weight/height/age and watch
   `active_energy` runs generous; both are real numbers whose *difference* is not a
   measurement. Good post material: the metric I was most excited to finally store turned
   out to need a caveat the moment it met reality. MacroFactor's own expenditure figure,
   derived from weight trend vs logged intake, is far better calibrated.
2. **A 343.5 lb reading in 2021** against a 280–300 baseline — and chasing it down was the
   best thing that happened to the schema. See below.

## TLS: a three-minute red herring

`pg` v8 treats `sslmode=require` as `verify-full`, and the first connection failed with
`SELF_SIGNED_CERT_IN_CHAIN`. The chain showed `ca.timescale.com` self-signing itself,
which reads like a platform that ships a private CA.

It isn't. Tiger Cloud issues a temporary self-signed cert so a service is usable
immediately, then swaps in a publicly-signed one behind the scenes. The docs say "usually
within 30 minutes"; it took **3.5 minutes**, and by the time I'd finished diagnosing it
the issuer was already Google Trust Services and `verify-full` just worked.

Worth a line in the post as an anti-lesson: the instinct on a TLS error is to reach for
`rejectUnauthorized: false`, and on a database holding personal health data that would
have been a permanent hole punched to work around a condition that resolved itself before
the investigation finished. Also note `libpq` needs `PGSSLROOTCERT` pointed at a CA bundle
on macOS where Node just works — psql and Node disagree about what "verify" means.

## A CHECK constraint earned its keep in the first 30 seconds

The Liftosaur sync failed immediately on `lifting_sets_weight_sane CHECK (weight_lbs > 0)`.
Cause: **52 sets across plank, crunch, hanging leg raise, inverted row and bodyweight
squat arrive from Liftosaur as `0lb`.**

`0lb` means "no external load" — which is exactly what `NULL` already meant in this schema
for a set logged as `3x12` with no weight segment at all. One concept, two representations.
Relaxing the constraint to `>= 0` would have been the easy fix and the wrong one: every
"did I add weight?" query would then need `> 0` instead of `IS NOT NULL`, and
`AVG(weight_lbs)` would quietly average real loads against zeroes. Normalised in the parser
instead.

The point for the post: **SQLite could not have told us this.** It was typeless and had no
constraints, so those 52 rows sat there for two and a half years as an unnoticed ambiguity.
The first schema with actual constraints found it before the first sync finished. That is
the entire argument for the migration, delivered unprompted in the first thirty seconds.

## Both sources live on Tiger Cloud

| | |
|---|---|
| `lifting_sets` | **2,416** — exact parity with SQLite |
| of which bodyweight (NULL) | 52 |
| of which failed sets (reps=0) | 15 — matches SQLite |
| `lifting_records` | 189 |
| `health_workouts` | 790 |
| `training_sessions` (reconciled) | **792** |
| naive double-count | 979 |

187 Apple shadow copies absorbed into their Liftosaur records, each donating the energy and
duration Liftosaur has no idea about.

**The hash-skip works.** First sync: 125 records changed, 1,713 sets written. Second sync:
`189 records seen, 0 changed, 0 sets written`. The old Python DELETE-INSERTed all 2.5 years
every single run; against a compressed hypertable that would have meant decompressing every
chunk, hourly, forever.

**`ingest_runs` immediately justified itself** by recording three runs that `sync_log` would
have reported identically: an error with the constraint message, a run that wrote 1,713
sets, and a run that found 189 records and correctly wrote nothing.

## The oracle diff caught a bug no unit test would have

Diffing Tiger Cloud against `fitness.db` over the 2026-04-19→now overlap. First run:
**486/507 matched, 21 differences** — and one cluster was a real regression I had shipped.

**All twelve `sleep_in_bed_min` values were zero.** HAE reports `inBed: 0` on most nights
while `inBedStart`/`inBedEnd` carry the actual interval. The old Python survived this *by
accident*: `p.get("inBed") or p.get("inBedTime") or _span_hours(...)` — Python's `or`
treats `0` as falsy, so it silently fell through to computing the span. My TypeScript read
the field directly and faithfully stored the zero, wiping out every in-bed figure. Same
applies to `totalSleep: 0`, which also happens.

No unit test would have found this, because I'd have written the test from the same
mistaken understanding that produced the bug. Only a known-good reference could. That is
the argument for building the oracle diff *before* deleting the thing you're replacing.

After the fix: **493/495**, with the remaining differences fully accounted for:

| Difference | Count | Verdict |
|---|---|---|
| Everything dated today | 8 | Partial Day. Both stores captured it at different moments; Tiger Cloud is higher on all 8 (448 vs 228 kcal, 1816 vs 1063 steps) because its export is later. Differs by construction. |
| `weight_lbs` on 2026-05-09 and 2026-06-19 | 2 | **Restatements.** Tiger Cloud matches the current export to six decimal places; SQLite is stale. HealthKit revised those two values after the old pipeline had stopped seeing those dates in its rolling window. |
| Workouts | 0 | All 30 found, keyed on the instant — which independently confirms the `timestamptz` approach agrees with the old hand-written `_utc_key` repair. |

The second row is the whole thesis in miniature: the old schema silently held two stale
values and could not tell you they had ever changed. The new one records the Restatement.

## The outlier that found a missing column

Probably the best single anecdote in here, because it went through three wrong answers.

A `weight_outliers` view flagged one reading in ten years: **343.5 lb on 2021-11-30**,
12.8% above its own three-week median. First guess: a smart scale mis-assigning a reading
to the wrong household profile. Matty ruled that out — and raised the genuinely
uncomfortable possibility that it was simply true.

Looking at the surrounding data made it stranger. Late 2021 weigh-ins were 11–27 days
apart with deltas of **+14.6, −23.8, +10.2, +26.7, −41.4 lb**. From December, once
weigh-ins became near-daily, deltas settled to ±1–5. So it wasn't one bad reading — the
whole sparse stretch looked impossible. Nobody loses 41 lb in ten days.

The answer was in a field the parser was throwing away. Every HAE data point carries a
`source`: the device or app that recorded it. And:

```
2021-11-19  316.8  MyFitnessPal | Withings
2021-11-30  343.5  MyFitnessPal              <- no scale
2021-12-10  302.1  MyFitnessPal | Withings
```

**It was typed in by hand.** Every reading around it came off the Withings scale; that one
didn't. A typo, not a body.

Three lessons, all of which belong in the post:

1. **Provenance is data, not decoration.** The column I hadn't bothered to store was the
   only one that could answer the question. It's now `observations.recorded_by`, distinct
   from `source` (which records how a Report reached us, not what recorded it).
2. **The first three explanations were all wrong** — wrong scale profile, wrong person,
   genuinely his weight — and each was plausible. The data settled it; speculation
   wouldn't have.
3. **It's an accidental ten-year archaeology of tracking apps.** 27 distinct source
   strings: MyFitnessPal, Withings, Noom, Simple, StrongLifts, Strong, Hevy, Glyppo,
   Progress, MacroFactor, Liftosaur. Only 30 of 683 weigh-ins were ever hand-entered, and
   nearly all of those predate owning a scale.

## The web app: four deploy failures, none reproducible locally

`npm run build` and 40 tests passed before every single one. That's the theme.

1. **`.ts` import specifiers.** Node's native TypeScript runner *requires* them;
   Vercel transpiles to `.js` and leaves specifiers untouched, so every route
   shipped asking for a file that no longer existed. Two toolchains with exactly
   opposite requirements.
2. **`tsconfig` never covered `api/`.** So `tsc --noEmit` had never once looked at
   the three files that broke. A typecheck that misses your entry points is
   theatre.
3. **No framework preset.** The project was created by `vercel link` before there
   was a framework, so `framework: null` meant Vercel treated a Next.js app as a
   static site and looked for the `public/` directory the conversion had deleted.
4. **A stale project-level Output Directory.** Pinning the framework got Vercel to
   recognise Next and it *still* looked in `public`, because a project setting
   beats framework detection. Fixed by overriding it in `vercel.json` so the repo
   is self-contained.

Nothing here is exotic. Every one is configuration that was correct for the
previous shape of the project and silently wrong for the new one, and none of it
is expressible in a local build. The lesson for the post is to get a deploy green
early rather than accumulating local confidence that doesn't transfer.

### And one that would have shipped a public health dashboard

`export { auth as middleware }` reads exactly like it protects your routes. It
does not — it attaches the session and waves every request through. An anonymous
`GET /` returned **200** until an `authorized` callback was added.

That's the same family as the four above but worse: configuration that appears
correct, does nothing, and fails *open*. It was caught only by curling a running
server instead of reading the matcher. Pair it with the sleep-stage unit bug and
the `inBed: 0` regression and there's a clear through-line for the writeup —
**everything real in this project was found by running it, not by reading it.**

## TimescaleDB, specifically

The time-series lessons, pulled together — these are scattered above in the order
they happened, but for a post about migrating to Timescale they are the spine.

### 1. `segment_by` is a density decision, and the obvious answer was wrong

`metric` looks like the textbook segment key for a tall/narrow EAV table. Measured
against 56k real rows and 74 metrics, a yearly chunk averages **~69 rows per
metric** — 139 in the densest year, single digits for micronutrients — against a
guideline of >100 per segment value per chunk. Segmenting would have produced
dozens of near-empty compression batches and compressed *worse*.

Dropped it entirely and put `metric` in `orderby` instead, where Timescale
auto-creates minmax **and** firstlast sparse indexes, preserving batch exclusion
for `WHERE metric = …` without the near-empty segments. Confirmed in
`timescaledb_information.hypertable_columnstore_settings`.

**Lesson: compute rows-per-segment-value-per-chunk from your actual data before
choosing. The tall/narrow shape that suggests a segment key can be exactly the
one that can't support it.**

### 2. Chunk interval was decided by write semantics, not by size

The size guidance (chunks in ~25% of memory) is irrelevant at 56k rows —
everything fits. What actually decided it: **HAE restates a day for about a week
afterwards.** Yearly chunks keep that entire restatement window inside the
current uncompressed chunk, so a revision never has to decompress anything.
Quarterly chunks would have put late restatements of a previous quarter into
already-compressed data.

**Lesson: if your source revises history, size chunks so the revision window
fits inside the uncompressed one.**

### 3. Compression: 8.8×, and beware benchmarking your own churn

13MB → 1,480kB across 11 chunks on Tiger Cloud. Locally it measured **11.9×**,
which was wrong — re-running the idempotent backfill left dead tuples that
bulked the uncompressed "before" without adding data. I was benchmarking my test
loop.

Also worth stating honestly in the post: the backfill contains **no
restatements** (each year file covers a distinct range), so 8.8× is genuine
columnar compression of tall/narrow data, not deduplicated repetition. Re-measure
once live pushes accumulate restatements.

### 4. `enable_columnstore` auto-creates a policy

TimescaleDB 2.23+ creates a 7-day columnstore policy the moment you set
`tsdb.enable_columnstore`. Adding your own then errors. You need
`remove_columnstore_policy` first. The skill docs said so and I skimmed past it.

### 5. A continuous aggregate cannot be created inside a transaction

The migration runner wrapped everything in `BEGIN`/`COMMIT`, which is correct for
every other migration and fatal for this one. Needed `WITH NO DATA` plus an
explicit `migrate:no-transaction` opt-out marker, with the backfill materialising
afterwards — which is faster anyway.

### 6. The watermark bug — the big one, and it bit twice

**Symptom:** MacroFactor said 1556 kcal; the site said 688. HAE was fine. The raw
Report log had 1556 pushed at 21:05; `observations_daily` served 688 materialised
at 16:10.

**Mechanism:** real-time aggregation unions materialised data with raw rows
*newer than the watermark*. Once a bucket is materialised, raw rows for it are
never consulted again until an explicit refresh. So a Report arriving later the
same day is **invisible**, and the view confidently serves a stale number.

I diagnosed and "fixed" this twice, and only understood it the second time:

- **First**: blamed entirely on the backfill calling
  `refresh_continuous_aggregate(cagg, NULL, NULL)`, which materialises *every*
  bucket including today. That was a real cause. Fixed by refreshing only up to
  `today_local()`.
- **But**: refreshing a narrower window does **not** move the watermark
  backwards. Today stayed materialised, and the only way to clear it was to
  rebuild the aggregate.
- **Second**: it recurred anyway, because the hourly policy's
  `end_offset => INTERVAL '1 hour'` **also** materialises the current day's
  bucket. My reasoning — "a bucket ending at midnight tonight can never be older
  than now minus an hour" — was simply wrong. The watermark had advanced to
  tomorrow's date.

**Final fix, deliberately belt and braces:** `end_offset` widened to 2 days so
the current day is never a refresh candidate, *and* the application reads today
directly from the raw log via `DISTINCT ON … ORDER BY reported_at DESC` — which
is exactly what `last(value, reported_at)` computes. "Today is correct" was too
important to rest on a rule I had misjudged twice, and reading raw makes it true
by construction rather than by reasoning.

**Lessons, and this is the section of the post I'd actually write:**
- Real-time aggregation is not "always fresh". It is "fresh past the watermark".
- The watermark only moves forward. A narrower refresh will not undo a wide one.
- `end_offset` must comfortably exceed one bucket, or your newest bucket
  silently freezes.
- For the one value users look at most — today — consider reading raw and
  skipping the question entirely.

**And the meta-lesson:** the append-only design is what made this diagnosable.
Both Reports were sitting in the log with timestamps, so the diagnosis was one
query. Under the old upsert schema the 688 would have overwritten nothing,
left no trace, and produced a wrong number with no way to tell.

## The web app: more of the same theme

- **The rule that was right and the fixture that wasn't.** Recovery baselines in
  tests used identical values, so SD was 0 and the rule silently reported
  "markers normal" while unable to judge anything. Now returns `unknown` — flat
  physiological data means something is broken upstream, not that recovery is
  perfect.
- **A false positive only real data could show.** Stalling flagged "Triceps
  Pushdown at 40lb". T3 accessories are *meant* to park at one weight; GZCLP only
  bumps them once the AMRAP clears 18 reps. Reporting that weekly is how a real
  T1 stall gets ignored. The fix needed tier — which isn't in the database,
  because the old `tier` column was NULL in all 2,416 rows and got dropped. It
  lives in the program, which is its right home.
- **The hardcoded assumption that wasn't the program.** Protein target 198g and a
  1.5 lb/week threshold were baked into the signals. A program change is
  deliberate and obvious; drifting from a cut to maintenance is gradual, and the
  rules would have kept confidently grading against a cut for months. Now
  phase-aware: the same −1.2 lb/week is `ok` on a cut and "going the wrong way"
  on a bulk.

## Targets moved from a hardcoded constant to a table, on schedule

`lib/config.ts`'s own comment predicted this: "if it ever starts changing
often... this becomes a table with effective dates." MacroFactor re-tunes
calories/protein roughly weekly as weight and body-fat% shift — issue #9 — so
that prediction just landed. `nutrition_targets` (migration 0009) is
append-only, same reasoning as `observations`: an edit is a new effective-dated
row, never an UPDATE, so a past day's grading is never rewritten by a later
change and `/settings` can show real history instead of just a current value.

While in there: `deficitReality` never actually graded against
`targets.calories` — the calorie number was display-only, only protein had a
real adherence signal. Added `calorieAdherence`, reusing `weightTrend`'s trick
of deriving direction from the sign of `targets.expected` rather than
switching on phase directly (cut wants at-or-under, bulk wants at-or-over,
maintenance wants a tolerance band).

**A real platform surprise while wiring the settings page's Server Action:**
`import { redirect } from 'next/navigation'` failed to resolve — not just in
this project's own `tsc --noEmit`, but inside `next build` itself, using this
project's own `tsconfig.json`. Cause: Next 16.2.12's `package.json` has no
`exports` map at all, and this project's `tsconfig.json` sets
`moduleResolution: nodenext` (chosen so `lib`/`scripts` files, run directly by
`tsx` as real ESM, get accurate extension-aware resolution). Under nodenext's
strict ESM resolution, a bare subpath import like `next/navigation` requires an
`exports` entry to resolve — Next ships the real files but doesn't declare
them, relying on legacy CJS-style extensionless lookup that ESM resolution
doesn't do. Tried the obvious fix (switch to `moduleResolution: bundler`, what
`create-next-app` ships by default) — that resolved `next/navigation` but broke
Turbopack's own bundling of the existing `./ui.js`-style relative imports
project-wide, a worse regression. Reverted. The actual fix: don't import
`next/navigation` at all — a Server Action bound directly to a `<form
action={...}>` triggers Next's automatic route refresh once it resolves, no
`redirect()`/`revalidatePath()` needed, and this page is `force-dynamic` anyway
so there's no route cache to invalidate. Filed away rather than chased further:
if a future feature genuinely needs `redirect`, `cookies`, or `headers`, this
tsconfig incompatibility will resurface and need a real fix, not a workaround.

**Couldn't verify the finished settings page in a real logged-in browser
session.** The Google OAuth client is only registered for the production
redirect URI (`fitness.mattstratton.com/api/auth/callback/google`), so signing
in against `localhost:3000` fails with `redirect_uri_mismatch` — a pre-existing
limitation of local dev, not something introduced by this change. Verified
instead via: `npm run migrate` applying cleanly against the real Tiger Cloud dev
database and seeding the expected row, `npm run q` confirming the row's
contents, `npm test` (84/84, including new `calorieAdherence` fixtures) and
`next build` succeeding with `/settings` compiled in. What's *not* verified:
the form actually rendering and submitting correctly in a browser. Briefly
considered widening `proxy.ts`'s matcher to exclude `/settings` so the page
could be loaded unauthenticated for a local screenshot — stopped short of that;
temporarily punching a hole in the auth boundary to test through it is exactly
the kind of shortcut this project's own traps section warns against, even
reverted immediately after.

## Verifying that a tool exists is not verifying that it works

Phase 0 of the web app was explicitly about resolving unknowns before building on
them, and the headline finding was that Liftosaur's MCP could tell us the next
workout via `run_playground`. That was recorded as "RESOLVED, best case", and the
open question about whether to hardcode GZCLP was closed on the strength of it.

It doesn't work. Every argument shape returns `exercises: {}` — an empty workout
— while the same response's `stats` block correctly reports that Day 3 has 15
working sets. So the tool parses the program perfectly and simply doesn't emit
the simulated session.

What actually got verified in Phase 0 was that the endpoint answered, the tool
was listed, and a call returned a 200 with plausible-looking JSON. Nobody checked
the part that mattered. Same failure as `export { auth as middleware }` attaching
a session and protecting nothing, and the `tsconfig` that typechecked everything
except the three files that broke the deploy — and I did this one *while writing
up the other two*.

**The lesson, sharpened: "I called it and got a response" is not verification.
Verification is asserting on the specific field you intend to depend on.** A
Phase 0 whose job is de-risking has to end in an assertion, not an impression.

The fallback is fine — derive the next session from the program text (`## Day N`
blocks, which carry current weights) plus the last `dayName` in history. It just
isn't the elegant thing that was promised, and the decision to skip hardcoding
GZCLP now rests on a different, weaker foundation than the one recorded.

## Building the fallback parser (#7 + #11): three more things the real program text didn't match the plan

The fallback recorded above got built as a real `/workouts` page — a "next up"
preview plus full session history, combined with issue #11's separate ask for
more workout detail in general. Before writing the parser, its design was
checked against Matty's actual live "GZCLP: Blacknoir version" program
(`viohtrec`, fetched via the Liftosaur MCP's `get_program`/`get_history`), not
assumed from the day-block syntax sketched above. Good thing — the real text
disagreed with the plan in three separate ways, each of which would have
produced silently wrong output if shipped as first imagined.

**1. Exercise lines are reuse references, not literal set schemes, and the
reference can point FORWARD in the file.** A line like

```
t1: Squat / ...t1_modified / 207.5lb / warmup: 1x5 45lb, 1x5 50%, 1x5 80%
```

carries no sets scheme of its own — `2x5, 1x5+` comes from a separate
`t1_modified / used: none / 2x5, 1x5+ / ...` template line, defined inside
**Day 4's** block, textually *after* Day 1 references it. A single
top-to-bottom scan (what a first-draft parser modeled on `lib/signals/tiers.ts`
would naturally do) resolves Day 1 before it has ever seen the template that
defines its sets — it would either crash or silently emit `sets: null` for
every un-progressed T1/T2/T3 exercise in the program, which is most of them.
Fixed with two passes: collect every `used: none` template first, then walk
day blocks resolving references against that map.

**2. An exercise repeats every variation inline once it's progressed past the
template default, and shows none at all while still on it.** Day 2's Overhead
Press, having advanced past its template's first variation, is written as

```
t1: Overhead Press / ...t1_modified / 2x5, 1x5+ / ! 3x3, 1x3+ / 4x2, 1x2+ / 1x5 (5RM Test) / 97.5lb / ...
```

— all four of `t1_modified`'s variations repeated on the exercise's own line,
with a leading `!` marking which one is current. Day 1's Squat, still on the
default, has no such repetition at all. Cross-checked against real
`get_history` records: the oldest Day 2 session's target (`2x5 95lb, 1x5+
95lb`) matches variation 1; a later one (`3x3 95lb, 1x3+ 95lb`) matches
variation 2, the one `!` now marks — confirming "prefer an inline `!`-marked
candidate, else the first inline candidate, else the template's own
(`!`-marked, else first) variation" against real progression, not a guess.

**3. `training_sessions.label` lags the true "last day," and a real program
interruption already exists in the data.** Querying it live, the day this was
built (2026-08-04):

```
observed_on  label                          set_count
2026-08-04   Traditional Strength Training   (blank)
2026-08-02   Day 4                          11
```

Today's session — synced via the Liftosaur MCP moments earlier — hadn't been
picked up by the `sync-liftosaur` cron yet, so `training_sessions` still
showed Apple Health's generic fallback label for it. `lifting_records.day_name`
(queried directly) doesn't carry that lag; it's what the cron actually
populates. Separately, `lifting_records.program` genuinely shows a real
interruption: `"Hotel Travel Week"` on 2026-07-27 and 2026-07-29, sandwiched
between GZCLP sessions. An unfiltered "most recent record" query would read a
future travel week the same way — restarting the GZCLP cycle at Day 1 instead
of correctly resuming where it left off — so the "last day" lookup filters by
the *current* program's own name.

**One design question Matty raised directly, and the fix:** the sets-scheme
matching was first written to match a segment *exactly* — `"2x5"`, nothing
else — tuned to how Blacknoir happens to write templates. Asked point-blank
whether that would be too brittle if he ever switched to a differently-written
program (5/3/1 was the example), the answer was yes for one specific case:
5/3/1's real inline style writes something like `1x5 65%, 1x5 75%, 1x5+ 85%`,
which an exact match wouldn't recognize as a sets scheme at all. Broadened to
"segment *contains* an `NxR`-shaped token" instead — one regex change, no
architecture change, and it now resolves both styles. Filed as a test case
(a synthetic day-headered, template-free, percentage-based exercise line)
specifically because the existing 5/3/1 fixture already in this repo's test
suite (real text, no day headers at all) can't exercise it — that program
would just make the whole preview go quiet, correctly, per the "render
nothing rather than guess" rule, and never reach the sets-parsing code at all.

**The measured consequence of the sync lag, seen directly rather than
theorized:** because `lifting_records`'s most recent GZCLP row was still "Day
4" (from 2026-08-02) at verification time — today's real Day 1 session not
yet synced — the shipped preview computed "Day 1" as next up. The actual next
session, given the untracked real session, is "Day 2." This is the exact
same eventual-consistency property `data_freshness` already has elsewhere in
this app, not a new gap this feature introduces — noted here because it was
observed happening in real time while building this, not inferred afterward.

## Numbers to re-measure before publishing

- [x] Compression: **8.8×** on Tiger Cloud, clean load. Note honestly that the backfill
      contains no Restatements at all (each year file covers a distinct range), so this
      ratio reflects genuine columnar compression of tall/narrow data rather than
      deduplicated repetition. Re-measure once live pushes have accumulated restatements.
- [ ] Final row counts after backfill (the 56,402 figure is from the export scan, not
      from loaded rows).
- [ ] Lines of code deleted at cutover (estimated ~150 for the iCloud/launchd machinery
      alone — get the real `git diff --stat`).
- [ ] Query timing on a representative `/coach` question, SQLite vs Tiger Cloud. Expect
      SQLite to win on a local 840KB file; say so if it does.
- [ ] Weight chart plot-height share: **35% band-folded vs 66% clipped** (39.3 vs 74.0 of
      112 user units). Measured 2026-08-04 on the live 90-day window: observed 269.8–283.0 lb
      (47 readings), ticks 265–285, regression slope −0.1029 lb/day, band rails 250.5/288.2
      from cut targets expected −1.0 / concerning 1.5. Re-derive by re-running that
      regression — the share moves as the observed spread does, so this figure is a
      snapshot, not a constant.
- [ ] Weight coverage at each window (**47 of 89 possible days at 90d** on 2026-08-04 — 53%,
      just above the 50% sparse threshold, which is *why* the bar-chart bug only appeared at
      the 1y window). Denominator is `windowDays - 1`: `loadSeries` excludes both boundary
      days. Re-measure; a few missed weigh-ins flip which side of the threshold this lands on.
- [ ] Sleep coverage (~7% / 16 nights in 19 months, per `metric_catalog`'s comment) vs. what's
      actually on the scale now: on 2026-08-04, the five most recent calendar days (2026-07-31
      through 2026-08-04) **all** have a recorded night. Whether that's a genuine recent uptick
      in watch-wear or a short streak inside an otherwise-sparse year needs a real query over a
      longer window before either number gets quoted in a writeup — see the entry below.
- [ ] The `/workouts` next-up preview's one-cycle sync lag (#7/#11 entry below): on 2026-08-04,
      `lifting_records`'s most recent GZCLP row was still "Day 4" from 2026-08-02, with a real
      Day 1 session performed that same day not yet synced — so the preview computed "Day 1" as
      next when the true next day (given the untracked session) was "Day 2." A one-off, timestamped
      observation, not a constant; re-check whether the lag is still ~1 sync cycle or has changed
      before quoting it, and don't assume "Day 4"/"Day 1" specifically still holds by then.
- [ ] Unilateral-notation data loss scope (**3 of 192 records**, the full live history as of
      2026-08-04, `hasMore: false`): re-scan before publishing in case more sessions with
      dumbbell/unilateral work have landed since, which would change the count without changing
      the underlying bug.

## An entire exercise, silently missing — found by displaying real data, not by a test

Building `/workouts`' session history (the entry above) surfaced a real, months-old
data-loss bug in the Liftosaur sync — found because Matty compared the new page
against the real Liftosaur app screenshot and noticed Incline Curl just wasn't
there at all, not that its numbers were wrong.

**What was happening:** Liftosaur writes unilateral/dumbbell exercises with reps
per side — `2x12|12 20lb` (both arms did 12), not the plain `2x5 215lb` shape
every existing test fixture used. `SET_GROUP_RE` in `lib/parse/liftohistory.ts`
didn't match the `|` at all, so `SET_GROUP_RE.exec(...)` returned `null` for
every group in that segment, and `parseSets` silently `continue`d past all of
them. The exercise didn't get corrupted sets — it produced **zero** sets,
for the whole session, and nothing in the pipeline noticed: no thrown error,
no failed constraint, just an exercise that quietly never made it into
`lifting_sets`.

**How wide:** scanned the full live history (192 records, confirmed
`hasMore: false` — not a sample) via the Liftosaur MCP for any performed-set
segment containing `|`. Exactly 3 records affected, across two exercises:
Incline Curl (2026-07-23, 2026-08-02, both real GZCLP Day 4 sessions) and
Bicep Curl (2026-07-29, the "Hotel Travel Week" interruption already on
record elsewhere in this log). Every real occurrence found so far has
identical reps on both sides (`12|12`, `8|8`, `10|10`, `9|9`, `20|20`) — no
genuine left/right asymmetry has actually happened yet.

**The fix:** `SET_GROUP_RE` now accepts an optional `|(\d+)` second-reps group;
`parseSets` takes `Math.min` of the two sides when both are present. Chosen
deliberately over averaging or taking the first side: in a program like GZCLP,
the weaker side is what actually limits whether the exercise counts as
progressing, the same logic already applied to a AMRAP `reps: 0` counting as a
real failed set rather than being discarded. Since every real case so far is
symmetric, this choice is currently unobservable in the data — worth
revisiting if Matty ever has a genuine per-side split, but not before, per this
codebase's own rule against solving for cases that haven't happened.

**What does NOT recover the missing history for free:** `syncLiftosaur`'s
whole optimization is skipping unchanged records via `text_hash` (a hash of
Liftosaur's own raw text) — and the raw text for these 3 records hasn't
changed, so simply re-running the fixed parser against a normal sync leaves
the gap in place. Recovering the already-missing Incline Curl/Bicep Curl sets
needs those 3 records' stored `text_hash` invalidated first, forcing
`syncLiftosaur` to treat them as changed and reprocess with the fixed parser
on the next run — a deliberate one-time, explicitly-approved data correction,
not something the parser fix does by itself.

**Done, with Matty's explicit go-ahead:** `text_hash` cleared for exactly those
3 `record_id`s (`ALLOW_WRITES=1 npm run q "UPDATE lifting_records SET
text_hash = '' WHERE record_id IN (...)"`), then `npm run sync-liftosaur` —
`192 records seen, 3 changed (42 sets written), 0 pruned`. Exactly the 3
targeted records changed, nothing else swept in. Verified the recovered rows
match the real Liftosaur data exactly: Incline Curl 12/12/8/10 reps @ 20lb
(2026-08-02), 12/12/12/20 @ 15lb (2026-07-23), Bicep Curl 10/9/10 @ 20lb
(2026-07-29) — all now present in `lifting_sets` and rendering on `/workouts`.

**The broader pattern, worth naming:** this is the second time in this
project that "no test failed" and "the pipeline ran clean" turned out to mean
nothing, once real data got looked at directly rather than assumed to match
the fixtures on file (see also: the `run_playground` entry above, and the
`inBed: 0` / `totalSleep: 0` fallback bugs in the HAE parser). Every fixture
this parser had before today used plain `NxR` notation because that's what
the person writing the fixtures had seen. The bug was invisible for as long
as nothing in the app ever showed a full, real, per-exercise set list next to
what Liftosaur itself shows — which is exactly what building `/workouts`
finally did.

## Sleep display added, and the "~7% coverage" assumption checked against live data (#10)

Issue #10 asked for sleep to be represented in the web app at all — it wasn't, anywhere.
Building it surfaced two things worth recording.

**Finding 1 — the actual bug behind the issue's framing.** The user experience issue #10
describes ("recovery markers normal" doesn't feel useful) turned out not to be about sleep
data quality or absence at all. `lib/signals/recovery.ts`'s `overreaching()` produces that
exact headline, and it is driven entirely by resting heart rate and HRV — it has never read
a single sleep metric. The headline just *reads* like a sleep verdict to anyone who doesn't
know the file. Reworded to "Resting HR/HRV normal" (and the suppressed-recovery headline to
match) so "Recovery" can't be misread as "you slept fine." Sleep itself got its own,
deliberately unjudged display instead (`lib/sleep.ts`, `loadLatestSleep`) — no `Signal`, no
`ok`/`watch`/`act`, on purpose: `CLAUDE.md` and the coach skill are explicit that sleep
coverage is too sparse to grade, and a judged signal here would sit at `unknown` roughly 93%
of the time — the same kind of noise the issue was complaining about in the first place.

**Finding 2 — the ~7% coverage figure may be stale, or the recent stretch may be an outlier.**
The plan for this work (reasonably) assumed sleep data would usually be too old to show on the
glance page, given `db/migrations/0004_metric_catalog.sql`'s comment ("16 points in 19 months,
6.6% of 2026") and `CLAUDE.md`'s "~7% coverage." Checking the live `sleep` view while
implementing this turned up something the assumption didn't predict:

```
observed_on  asleep_min          in_bed_min          age_days
-----------  ------------------  ------------------  --------
2026-08-04   419.89              429.35              0
2026-08-03   399.50              415.92              1
2026-08-02   431.34              501.48              2
2026-08-01   434.84              549.77              3
2026-07-31   389.68              389.67              4
```

Five consecutive nights recorded, right up through today. That's not what a ~7%-coverage year
looks like locally — it's either a genuine recent improvement in overnight watch-wear (plausible;
`docs/migration-log.md`'s existing watch-wear note documents wear rates changing over time for
the sibling `resting_hr`/`hrv_ms` metrics), or a short streak that doesn't move the year-long
average much. Both are consistent with what's on record; neither is confirmed by this one query.
The catalog comment's number was never re-run against current data as part of this change, so it
should be treated as of unknown freshness rather than re-quoted — flagged in the checklist above
rather than corrected here, since correcting it would mean asserting a new number this change
didn't actually measure.

The practical consequence for this feature: the glance-page sleep tile (recency-gated at
`RECENT_SLEEP_DAYS = 3`) will very likely render for Matty most days right now, not the "shows up
occasionally" behavior the design discussion assumed — worth knowing when reviewing the deployed
page, so an ever-present tile isn't mistaken for a bug.

## Trends charts readability — two real findings from rendering (#5)

### 1. Trend band geometry excluded from axis scaling (critical rendering bug)

A weight chart's expected-vs-concerning band (from `computeTrendBand`) was computed correctly but excluded from the axis range calculation in `app/ui.tsx`. The band polygon draws regression-fitted boundaries across the full window, and those boundaries can sit far outside anything ever observed. The axis calculation folded only the observed values plus the raw tick suggestions into `lo`/`hi`, missing the polygon coordinates entirely, so the band drew partly off-canvas.

Measured against the real 90-day window on 2026-08-04 (not the hypothetical numbers this entry originally carried, which described neither the live data nor the chart's actual height — the weight chart ships at `height={140}`, giving a 112-user-unit plot area from y=6 to y=118, not the 90-unit viewBox the first draft assumed):

- observed weight 269.8–283.0 lb, 47 readings; `axisTicks` → 265/270/275/280/285
- targets: cut, expected −1.0 lb/wk, concerning 1.5
- regression over that window: slope −0.1029 lb/day, intercept 272.78 at 2026-08-04 → trend line 281.9 → 272.9
- band rails therefore reach **250.5 and 288.2** — 14.5 lb below and 5.2 lb above anything on the scale

With the band excluded from the domain (`lo`/`hi` = 265/285) those rails land at y=199 and y=−12 against a plot that ends at y=118: substantially off-canvas, exactly as reported.

Code review caught this before a render, but it's a canonical "something looked right in isolation" case: the band geometry was correct, the scale logic was correct, and they simply weren't composed together.

**Fix (superseded — see "Domain expansion is not clipping" below):** folded `trendBand.band` and `trendBand.trendLine` values into `lo`/`hi` before computing the scale. This does stop the band drawing off-canvas. It also turned out to be the wrong fix, for reasons the whole-branch review found and the later entry records.

### 2. SVG text on mobile: viewport scaling is not what the code looks like

Axis text across all charts was hardcoded `fontSize="8"` (user units in a 600-unit viewBox). On a 390px-wide phone (accounting for app chrome, ~330px available), the viewBox scales by factor 330/600 ≈ 0.554. That renders 8 user units at ≈4.4 CSS pixels — illegible, especially for the y-axis numbers most users would want to glance at.

Discovered during Task 6's review phase; the `Chart` component had shipped without mobile testing. A reasonable reading of the code — "set a font size, place a label" — completely misses that SVG viewport scaling is not a linear visual property once you factor in actual device widths.

**Fix:** replaced the hardcoded `fontSize="8"` values **in `app/ui.tsx`** with `fontSize={AXIS_FONT}` (16). Renders at ≈8.9 CSS pixels on the same phone — roughly double, and legible. Coordinate scaling math was already correct; only the text sizing needed adjustment.

The original wording here claimed "all hardcoded `fontSize=8`", which was not true. `app/chart-marks.tsx` — the tap-to-read label, i.e. the one piece of text a user deliberately summons in order to read a number — still had `fontSize="9"` and kept it through every per-task review, right up to the final whole-branch pass. The fix had been described in terms of the *finding* ("SVG text is too small") but implemented in terms of one file, and the log's summary quietly inherited the wrong scope. Worth noting as a documentation failure mode of its own: a fix note that generalises past what the diff did makes the remaining instance invisible to everyone reading the log later.

**Broader finding:** this is the second render-only bug in the charting work, following the "water bucket outside the container" trend-band bug. The app is server-rendered, so neither of these would have surfaced without an actual browser, and neither is expressible as a test. Pair with the settings page's OAuth localhost limitation — local dev's `next build` and typecheck both pass while the app is undeployed and untested in a real viewport.

### 3. A generic rule applied where it was never meant to

`resolveMarkType(points, windowDays)` was written as a per-series rule: under 50% coverage, draw bars from a baseline instead of scattered dots, because sparse dots read as confetti. Fine as far as it goes. It was then wired up for all six metrics in `app/trends/page.tsx`, because it takes a series and a window and there is nothing in its signature suggesting otherwise.

The problem only shows up once you change the window. At 90 days weight has 47 readings — 53%, a line. Click "1y" and it's 47 of 364, comfortably under the threshold, and the weight chart silently becomes a bar chart. Bars grow from zero, and a bar's height is a claim that zero is the meaningful baseline. Nobody weighs zero. Same for resting HR and HRV: a 60 bpm bar next to a 58 bpm bar encodes essentially nothing, and worse, it *looks* like it encodes something.

The coverage threshold was never wrong; it just can't know which metrics have a baseline worth measuring against. That's a property of the metric, not of its density. **Fix:** the four metrics with no meaningful zero (weight, steps, resting HR, HRV) now pass `markType="line"` as a literal, and `resolveMarkType` is called only for protein and calories — the two that have a target to colour a hit/miss against, which is the only reason the bar rendering exists. The function's docstring now says so out loud, because the signature can't.

The general shape: a rule derived from one metric's problem, given a generic signature, gets applied generically. Nothing in the type system objects. Nothing in the per-task review objects either, because within any single task the call site looks like consistency.

### 4. Domain expansion is not clipping

Finding 1 above was fixed by folding the band's coordinates into the axis domain so the band would fit. It fits. It also destroyed the chart.

Measured on the real 90-day weight window (2026-08-04), plot area 112 user units tall:

| Domain source | `lo`–`hi` | Height the real readings occupy |
|---|---|---|
| band folded in (the finding-1 fix) | 250.5–288.2 | **39.3 of 112 units — 35%** |
| values + ticks only (current) | 265–285 | **74.0 of 112 units — 66%** |

The band's rails reach 250.5 and 288.2 because they're a regression rate projected across 88 days; the actual scale readings only span 13.2 lb. Sizing the axis to the extrapolation squeezed 13.2 lb of real data into a third of the chart to make room for a shaded region that exists purely as context. The thing you came to the chart to read got the smallest share of it.

**Fix:** the domain goes back to being driven only by the observed values, the tick suggestions and the flat target line. The band polygon and trend line are wrapped in a `<g clipPath>` scoped to the plot rect, so the parts that fall outside get cropped. Both rails now land outside the plot (y=199 and y=−12 against a plot ending at y=118) and are simply not drawn there, which is correct: the band is context for the visible range, not a thing the visible range has to accommodate.

**The property worth remembering:** every chart in this app is a fixed 600-unit-wide `viewBox` scaled down to roughly 330 CSS px on a phone — a ~0.55 factor on *everything*, coordinates and text alike. Three separate bugs in this one issue trace back to it: text sized in user units that renders illegibly (finding 2), a 12-unit tap circle that becomes a sub-7px touch target, and now a domain sized in data units where the visual consequence is invisible from the code. Anything that "looks fine" in the source is being read at 55%. Two rules fall out of it, and they should apply to every future chart here:

1. **Overlays are clipped, never accommodated.** If something extrapolates, crop it to the plot rect. Widening the domain to contain an overlay always costs the real data its resolution.
2. **Anything sized in user units needs the 0.55 factor applied before you believe it.** Fonts, hit targets, stroke widths. A `fontSize` that reads as reasonable in the JSX is not.

Also fixed in the same pass, all of them small and all of them only visible with everything assembled: the tap-to-read label clipped at the top and right edges of the chart (and the right edge is where "today" is, so it clipped exactly where you'd tap most); tap targets became full-height bands between mark midpoints instead of fixed circles, which both fixes the touch-target size and makes dense series selectable at all; the tap label showed `Math.round(value)`, throwing away the tenths of a pound that are the entire point of a weight chart; the y-axis had no left gutter, so its numbers sat on top of the leftmost mark (and the obvious fix — a fixed-width gutter with right-aligned labels — turns out to reproduce the same class of bug one step over: a gutter wide enough for weight's `265` sends steps' `15000` off the left edge of the viewBox, so the gutter is sized from the longest tick label instead); bar charts had no labelled zero gridline despite growing from zero (`axisTicks` derives ticks from the data's own min/max and usually omits it); the x-axis date labels were spaced across the *data's* extent while the x-scale spanned the *window*, so clustered data bunched its labels into the cluster and left most of the axis blank; the coverage denominator said `windowDays` when `loadSeries` excludes both boundary days and so can only ever reach `windowDays - 1`; and `loadWeightTrendLine` fitted its regression with `observed_on <= today_local()`, quietly including the Partial Day that every other query in this codebase is careful to exclude.

That last one is the tell for the whole round. Nine of these ten fixes were invisible per-task and obvious once the pieces sat on one page.

### 5. The plan's own "≥24px tap target" constraint was unreachable, not unmet

The original plan's Global Constraints listed "every tap/hit target is ≥24px even though the visible mark stays small" as something the band-based hit regions (finding 4, above) would satisfy. They don't, and can't, once a series gets dense enough — and this was found by doing the arithmetic the plan itself supplies, not by guessing.

The plot area is the ~330 CSS px viewBox width already measured above (the 0.55 scale factor), minus the left gutter and padding — call it roughly 300 CSS px of usable width. A 365-day window at 90-95% coverage packs somewhere around 330-350 points into that space: **roughly 1 CSS px between neighboring points**, two orders of magnitude under 24px. Since each point's band runs from the midpoint to its left neighbor to the midpoint to its right neighbor, no per-point hit region — band or fixed-size circle, it doesn't matter which — can be wider than that spacing. The constraint was never satisfiable for a chart like this; only a window sparse enough (a handful of points across the same width) would ever clear 24px per band.

Raised with Matty rather than silently reworded: the decision was to keep the band-based interaction exactly as implemented (it resolves every tap to its nearest point, which is the property that actually matters for usability) and fix the plan's wording instead of the code — amended in `docs/superpowers/plans/2026-08-04-trends-charts-readability.md`'s Global Constraints to state the real guarantee (nearest-point resolution) rather than a fixed minimum size that data density makes impossible. Worth filing next to finding 4's "anything sized in user units needs the 0.55 factor applied before you believe it" — this is the same lesson one level up: a plan constraint written before real data density was known can be exactly as wrong as code written the same way, and the fix is to correct the plan, not to quietly ship something that doesn't meet it.

## Cross-domain correlation investigation (#15) — the actionable events mostly don't exist yet

A repo review turned up that every signal in `lib/signals/` reads exactly one domain's
rows — nothing ever joins nutrition, recovery, lifting, sleep, or steps to compute a
verdict, despite advisory copy inside a few signals ("back off volume or eat more,"
"expected on a deficit") gesturing at relationships the code never actually checks.
Before writing any cross-domain signal, checked whether the three most obvious
hypotheses actually hold against real history. They don't get a real test, and the
reason why is itself the finding.

**Lifting stalls, tier-filtered, have never happened.** Reconstructed `stalling()`'s
exact "same weight missed 2+ consecutive targeted sessions" logic in SQL against the
full Liftosaur/GZCLP history (2024-02-19 → present, 185 sessions). Excluding T3
accessories: **zero** T1/T2 stalls, ever. Without the exclusion, all 6 raw hits are
Triceps Pushdown — precisely the false positive the tier filter exists to catch
(confirmed separately by `tests/signals.test.ts`'s own "a T3 sitting at one weight is
the program working, not a stall" case). There is no stall event in this program's
entire life to correlate anything against.

**`overreaching()`'s `act` status has never fired, in 9+ years of RHR/HRV data.**
Rather than hand-approximating the baseline/SD-threshold math in SQL — which risks
getting subtly wrong the exact class of mistake this log keeps finding — ran the real
function from `lib/signals/recovery.ts` against every day in the full recovery
history via a one-off script (`getPool()` + `overreaching()` imported directly,
same 63-day rolling window `loadSignals()` uses). 2,402 distinct days simulated:
**`act` = 0, `watch` = 15**, and every `watch` predates 2024-06-27 — none at all in
2025 or 2026. The 3 `watch` hits that overlap the Liftosaur era sit under a
completely different training program (cycling + "5x5 A/B" splits, not GZCLP
Blacknoir) with almost no nutrition data logged nearby (3 logged days across two
multi-week windows) — not comparable to anything current.

**Consistent nutrition logging is ~3-4 weeks old, nowhere near enough to test
anything against lifting performance.** Weekly miss-rate vs. logging comparison over
the last 180 days shows missed sets appearing *only* in the three weeks with full
7-day logging (2026-07-13 onward) — but that's fully explained by "essentially
nothing was logged before mid-July" (0-1 days/week), not a real relationship. Three
overlapping weeks is an anecdote, not a sample.

**Sleep remains too sparse** (~10% of the last 180 days) for any correlation check.

**Conclusion, and why it belongs in this log rather than just a closed issue:** the
absence of a testable correlation is itself the useful result here, and the method
matters as much as the number — this is the second time in this project (see the
`overreaching`/`recentMisses` fixture history, and the `run_playground` incident) that
running the *actual* code against real data caught something a plausible-sounding
hand-derivation would have gotten wrong or missed the significance of. Filed back on
#15 as a dated follow-up (~November 2026, once nutrition logging has 2-3 months of
history) rather than closed outright — the hypotheses aren't rejected, they're just
not answerable with the data on hand today.
