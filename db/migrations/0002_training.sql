-- Training: Liftosaur's account (lifting_records / lifting_sets) and Apple
-- Health's account (health_workouts) of the same physical sessions, kept apart.
-- Reconciliation happens in the training_sessions view, never at write time.

-- One Liftosaur session. Small dimension table, not a hypertable.
-- text_hash exists so a sync only re-expands records whose text actually
-- changed: the old pipeline DELETE-INSERTed all 2.5 years on every run, which
-- would force decompression of every chunk, every hour, forever.
CREATE TABLE lifting_records (
    record_id    bigint      PRIMARY KEY,
    performed_on date        NOT NULL,
    started_at   timestamptz NOT NULL,
    program      text,
    day_name     text,
    text_hash    text        NOT NULL,
    synced_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN lifting_records.program IS
    'Liftosaur program name. Some values name a prior app rather than a program '
    '(1218 rows say "Hevy") because history was imported wholesale.';

CREATE TABLE lifting_sets (
    performed_on date             NOT NULL,
    record_id    bigint           NOT NULL,
    exercise     text             NOT NULL,  -- display name, e.g. 'Bench Press, Dumbbell'
    set_index    integer          NOT NULL,
    reps         integer          NOT NULL,  -- 0 means attempted and failed; not missing
    weight_lbs   double precision,           -- NULL for bodyweight movements
    target_reps  integer,
    is_amrap     boolean,

    -- Timescale requires the partition column in every unique index, which is
    -- why performed_on leads here; the old SQLite PK omitted the date entirely.
    PRIMARY KEY (performed_on, record_id, exercise, set_index),
    CONSTRAINT lifting_sets_reps_sane   CHECK (reps >= 0),
    CONSTRAINT lifting_sets_weight_sane CHECK (weight_lbs IS NULL OR weight_lbs > 0)
) WITH (
    tsdb.hypertable,
    tsdb.partition_column = 'performed_on',
    tsdb.enable_columnstore = true,
    -- Same reasoning as observations: 47 exercises across 2416 rows is ~51 rows
    -- per exercise in total, well under the >100-per-chunk bar for segmentby.
    tsdb.orderby = 'exercise, performed_on DESC'
);

-- 2416 rows across three calendar years, very unevenly (1776 in 2024, 306 in
-- 2025, 334 so far in 2026). Yearly chunks give a handful of fat chunks rather
-- than dozens of near-empty ones.
SELECT set_chunk_time_interval('lifting_sets', INTERVAL '1 year');

-- Override the auto-created 7-day policy. Liftosaur only re-expands records
-- whose text_hash changed, but an edit to a session weeks later is plausible,
-- and 90 days keeps that out of compressed chunks.
CALL remove_columnstore_policy('lifting_sets', if_exists => true);
CALL add_columnstore_policy('lifting_sets', after => INTERVAL '90 days');

-- `tier` (T1/T2/T3) and `is_completed` are deliberately absent. Both existed in
-- the SQLite schema; `tier` was NULL in all 2416 rows because nothing ever
-- derived it, and `is_completed` equalled `reps > 0` in all 2416 rows, making it
-- a restatement rather than a fact. Tier remains real vocabulary (see
-- CONTEXT.md) and can return when something can actually populate it.

-- Apple Health's separate account of a session. Carries energy and duration,
-- which Liftosaur never sees. A barbell session appears here AND in
-- lifting_records; that is expected, not duplication.
CREATE TABLE health_workouts (
    started_at   timestamptz      NOT NULL,
    type         text             NOT NULL,  -- 'Traditional Strength Training', 'Yoga', ...
    observed_on  date GENERATED ALWAYS AS (local_day(started_at)) STORED,
    ended_at     timestamptz,
    duration_min double precision,
    energy_kcal  double precision,
    source       text             NOT NULL DEFAULT 'hae',

    -- The natural key. Storing the instant as timestamptz is what makes this
    -- work: the old schema keyed on a raw offset-bearing string, so one workout
    -- exported by two automations either side of a timezone change filed as two
    -- rows and needed a hand-written repair migration. Cannot recur.
    PRIMARY KEY (started_at, type)
) WITH (
    tsdb.hypertable,
    tsdb.partition_column = 'started_at',
    tsdb.enable_columnstore = true,
    tsdb.orderby = 'type, started_at DESC'
);

SELECT set_chunk_time_interval('health_workouts', INTERVAL '1 year');

CREATE INDEX health_workouts_observed_on ON health_workouts (observed_on DESC);
