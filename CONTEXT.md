# Fitness Tracker

A personal training and nutrition data store. Lifting comes from Liftosaur; food, body,
sleep and activity come from Apple Health via Health Auto Export. Its purpose is to
answer coaching questions honestly — which means being precise about what was observed,
when we were told, and how much to trust it.

## Language

### Observations

**Observation**:
A single scalar fact about one Metric on one Observed Day — "215.4 lbs on 2026-07-30".
_Avoid_: reading, data point, measurement, sample

**Report**:
One delivery of an Observation from a source. Several Reports can describe the same
Observation and disagree; the most recent one is the answer.
_Avoid_: export, sync, upload, payload

**Metric**:
The named, unit-bearing quantity an Observation is about, such as `protein_g` or
`sleep_core_min`. New Metrics may appear at any time without warning.
_Avoid_: field, column, measure, stat

**Restatement**:
A later Report that revises an earlier one for the same Observed Day — usually because
food was logged after the first Report went out. Normal, expected, and never destructive.
_Avoid_: correction, update, overwrite

### Time

**Observed Day**:
The calendar day in `America/Chicago` that an Observation belongs to. Fixed to that zone
deliberately, so the same input always yields the same day regardless of where a sync
runs from.
_Avoid_: date, local date, log date

**Report Time**:
The instant a source handed us a Report. It orders Restatements and decides which Report
wins; it is never the day the Observation is about.
_Avoid_: timestamp, ingest time, sync time, created at

**Partial Day**:
Today. Still accumulating, so every Report about it understates the truth. Excluded from
every average and trend.
_Avoid_: incomplete day, current day

### Training

**Lifting Set**:
One performed set within a Lifting Record. Zero reps means attempted and failed, which is
a meaningful training event — not missing data.
_Avoid_: rep set, entry

**Lifting Record**:
One Liftosaur session, comprising its Lifting Sets. Liftosaur's own term for it, kept
deliberately.
_Avoid_: workout, session, history entry

**Health Workout**:
Apple Health's separate account of a session, carrying energy and duration that Liftosaur
never sees. A barbell session produces both a Lifting Record and a Health Workout.
_Avoid_: workout, activity

**Training Session**:
The reconciled single truth about one session, whichever sources described it. The only
correct thing to count when asking "how much did I train".
_Avoid_: workout, session

**Working Set**:
A set that counts. Warmups are reported by Liftosaur but discarded — they are not
Lifting Sets.
_Avoid_: real set, main set

**Target**:
What a Lifting Set was prescribed to do, as distinct from what it did. Needed to tell a
missed AMRAP apart from a failed set.
_Avoid_: goal, prescription, planned reps

**AMRAP**:
A Target marked "as many reps as possible" — exceeding it is success, and falling short
of the written number is not automatically failure.

**Tier**:
GZCLP's T1/T2/T3 role for a lift within a session — primary, secondary, accessory. Real
vocabulary for talking about training; not currently derivable from any source.

**Program**:
The Liftosaur program a Lifting Record was performed under. Some values name a prior app
rather than a program, because history was imported wholesale — `Hevy` is imported
history, not a training program.
_Avoid_: routine, plan, template

### Trust

**Freshness**:
How close a source's newest Observation is to now — the only honest measure of whether
this data can be coached on. Graded **fresh**, **partial** (today, still accumulating),
**stale** (older than that source allows), or **missing** (nothing at all).
_Avoid_: sync status, health, up to date

**Automatic Source**:
A source that reports without Matty doing anything, because the Watch writes it. A gap is
always a broken pipeline.
_Avoid_: passive source

**User-Driven Source**:
A source needing Matty to log food or step on a scale. A gap may just be travel or a
missed weigh-in, so it warns rather than fails.
_Avoid_: manual source, active source
