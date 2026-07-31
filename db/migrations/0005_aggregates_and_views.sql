-- migrate:no-transaction
--
-- Current truth, derived from the Report log, plus the friendly shapes that
-- keep /coach queries looking like they did under SQLite.
--
-- Runs outside a transaction: CREATE MATERIALIZED VIEW ... WITH
-- (timescaledb.continuous) cannot run inside a transaction block.

-- ---------------------------------------------------------------------------
-- The single most load-bearing object in the schema.
--
-- last(value, reported_at) IS last-write-wins, expressed as an aggregate rather
-- than as something every query has to remember to write. Under the old schema
-- this was implicit in ON CONFLICT DO UPDATE and the prior Reports were gone.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW observations_daily
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 day', observed_on) AS observed_on,
       metric,
       last(value, reported_at)  AS value,
       last(unit,  reported_at)  AS unit,
       last(recorded_by, reported_at) AS recorded_by,
       max(reported_at)          AS last_reported_at,
       count(*)                  AS report_count      -- >1 means it was Restated
FROM observations
GROUP BY 1, 2
-- Materialise later rather than during the migration. The backfill calls
-- refresh_continuous_aggregate once the rows are in, which is both faster and
-- keeps the migration from doing minutes of work.
WITH NO DATA;

-- Real-time aggregation ON, deliberately. Today's Reports must be visible the
-- moment they land -- a coaching conversation that can't see this morning's
-- weigh-in is useless -- and the query cost is irrelevant at this data volume.
ALTER MATERIALIZED VIEW observations_daily SET (timescaledb.materialized_only = false);

-- start_offset NULL so Restatements of older days are always re-materialized.
-- HAE restates within roughly a week, and there is no retention on observations
-- to bound this against.
SELECT add_continuous_aggregate_policy('observations_daily',
    start_offset      => NULL,
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');

CREATE INDEX observations_daily_metric ON observations_daily (metric, observed_on DESC);

-- ---------------------------------------------------------------------------
-- Pivots. These exist so common questions keep an obvious shape while adding a
-- Metric stays a zero-migration event. A Metric with no view is not lost --
-- it is queryable in observations_daily by name.
-- ---------------------------------------------------------------------------

CREATE VIEW nutrition AS
SELECT observed_on,
       max(value) FILTER (WHERE metric = 'calories')  AS calories,
       max(value) FILTER (WHERE metric = 'protein_g') AS protein_g,
       max(value) FILTER (WHERE metric = 'carbs_g')   AS carbs_g,
       max(value) FILTER (WHERE metric = 'fat_g')     AS fat_g,
       max(value) FILTER (WHERE metric = 'fiber_g')   AS fiber_g
FROM observations_daily
WHERE metric IN ('calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g')
GROUP BY observed_on;

CREATE VIEW activity AS
SELECT observed_on,
       max(value) FILTER (WHERE metric = 'steps')            AS steps,
       max(value) FILTER (WHERE metric = 'exercise_minutes') AS exercise_minutes
FROM observations_daily
WHERE metric IN ('steps', 'exercise_minutes')
GROUP BY observed_on;

CREATE VIEW body AS
SELECT observed_on,
       max(value) FILTER (WHERE metric = 'weight_lbs')    AS weight_lbs,
       max(value) FILTER (WHERE metric = 'body_fat_pct')  AS body_fat_pct,
       max(value) FILTER (WHERE metric = 'lean_mass_lbs') AS lean_mass_lbs,
       max(value) FILTER (WHERE metric = 'bmi')           AS bmi
FROM observations_daily
WHERE metric IN ('weight_lbs', 'body_fat_pct', 'lean_mass_lbs', 'bmi')
GROUP BY observed_on;

-- Stages are minutes here, like their siblings. Under SQLite they were dumped
-- into stages_json in HOURS while asleep_minutes/in_bed_minutes were minutes,
-- so anything summing stages against total sleep was wrong by 60x.
CREATE VIEW sleep AS
SELECT observed_on,
       max(value) FILTER (WHERE metric = 'sleep_asleep_min') AS asleep_min,
       max(value) FILTER (WHERE metric = 'sleep_in_bed_min') AS in_bed_min,
       max(value) FILTER (WHERE metric = 'sleep_core_min')   AS core_min,
       max(value) FILTER (WHERE metric = 'sleep_deep_min')   AS deep_min,
       max(value) FILTER (WHERE metric = 'sleep_rem_min')    AS rem_min,
       max(value) FILTER (WHERE metric = 'sleep_awake_min')  AS awake_min
FROM observations_daily
WHERE metric LIKE 'sleep\_%'
GROUP BY observed_on;

-- ---------------------------------------------------------------------------
-- Energy balance. New -- the old schema stored neither basal nor active energy,
-- so the size of the deficit was assumed rather than measured. On a GLP-1 cut
-- where appetite suppression makes intake erratic, this is the number that
-- actually says whether the loss rate is explicable.
--
-- NULL out unless both sides are present: a day with expenditure but no food
-- log is an unlogged day, not a 2400 kcal deficit. Conflating those is the
-- same "gaps are not zeros" mistake the coach skill already warns about.
-- ---------------------------------------------------------------------------
CREATE VIEW energy_balance AS
SELECT observed_on,
       calories_in,
       basal_kcal + active_kcal AS calories_out,
       CASE WHEN calories_in IS NOT NULL
             AND basal_kcal  IS NOT NULL
             AND active_kcal IS NOT NULL
            THEN calories_in - (basal_kcal + active_kcal)
       END AS net_kcal
FROM (
    SELECT observed_on,
           max(value) FILTER (WHERE metric = 'calories')           AS calories_in,
           max(value) FILTER (WHERE metric = 'basal_energy_kcal')  AS basal_kcal,
           max(value) FILTER (WHERE metric = 'active_energy_kcal') AS active_kcal
    FROM observations_daily
    WHERE metric IN ('calories', 'basal_energy_kcal', 'active_energy_kcal')
    GROUP BY observed_on
) d;

-- Recovery. ~250 points each in 2025, the earliest signal that a deficit plus
-- linear progression has tipped into overreaching.
CREATE VIEW recovery AS
SELECT observed_on,
       max(value) FILTER (WHERE metric = 'resting_hr')       AS resting_hr,
       max(value) FILTER (WHERE metric = 'hrv_ms')           AS hrv_ms,
       max(value) FILTER (WHERE metric = 'blood_oxygen_pct') AS blood_oxygen_pct,
       max(value) FILTER (WHERE metric = 'respiratory_rate') AS respiratory_rate
FROM observations_daily
WHERE metric IN ('resting_hr', 'hrv_ms', 'blood_oxygen_pct', 'respiratory_rate')
GROUP BY observed_on;

-- ---------------------------------------------------------------------------
-- Training Sessions: the reconciled answer to "how much did I train".
--
-- Counting health_workouts directly double-counts every barbell day, because
-- 27 of its first 30 rows were Apple's shadow copies of Liftosaur sessions.
-- Liftosaur wins for lifting (it has the sets); Apple contributes the energy
-- and duration Liftosaur never sees. Reconciliation lives here, in a view, so
-- a wrong guess is fixed by editing SQL rather than by repairing history.
-- ---------------------------------------------------------------------------
CREATE VIEW training_sessions AS
WITH matched AS (
    -- Pair each Liftosaur record with its closest-in-time Apple copy, ONE to
    -- one. Matching per-workout rather than per-day matters: a date-based
    -- guard would suppress every Apple strength row on a lifting day, so a
    -- genuine second session that Liftosaur never saw would silently vanish.
    -- Known limit: two Liftosaur records on one day can both claim the same
    -- Apple row, which then gets suppressed once. Acceptable at this volume.
    SELECT DISTINCT ON (r.record_id)
           r.record_id,
           hw.started_at AS matched_started_at,
           hw.duration_min,
           hw.energy_kcal
    FROM lifting_records r
    JOIN health_workouts hw
      ON hw.type = 'Traditional Strength Training'
     AND hw.observed_on = r.performed_on
    ORDER BY r.record_id, abs(extract(epoch FROM hw.started_at - r.started_at))
)
SELECT r.performed_on AS observed_on,
       r.started_at,
       'lifting'::text AS kind,
       r.day_name      AS label,
       r.program,
       m.duration_min,
       m.energy_kcal,
       (SELECT count(*) FROM lifting_sets s WHERE s.record_id = r.record_id) AS set_count
FROM lifting_records r
LEFT JOIN matched m ON m.record_id = r.record_id

UNION ALL

-- Every Apple workout that wasn't consumed above: all non-lifting sessions,
-- genuine second strength sessions, and -- the big one -- eight years of
-- training from before Liftosaur existed. Liftosaur history starts in 2024;
-- Apple's goes back to 2016.
SELECT hw.observed_on,
       hw.started_at,
       CASE WHEN hw.type = 'Traditional Strength Training' THEN 'lifting' ELSE 'other' END,
       hw.type,
       NULL,
       hw.duration_min,
       hw.energy_kcal,
       NULL
FROM health_workouts hw
WHERE NOT EXISTS (
    SELECT 1 FROM matched m WHERE m.matched_started_at = hw.started_at
);

-- ---------------------------------------------------------------------------
-- Freshness: is this data current enough to coach on?
--
-- Driven by metric_catalog rather than hardcoded, so promoting or demoting a
-- Metric is an UPDATE, not a migration. Never reads ingest_runs -- the failure
-- this exists to catch is precisely a run that succeeds and delivers nothing.
-- ---------------------------------------------------------------------------
CREATE VIEW data_freshness AS
WITH src (label, latest, max_age_days, automatic) AS (
    SELECT c.display_name,
           (SELECT max(o.observed_on) FROM observations_daily o WHERE o.metric = c.metric),
           c.max_age_days,
           c.automatic
    FROM metric_catalog c
    WHERE c.max_age_days IS NOT NULL

    -- The two sources that aren't Metrics.
    UNION ALL SELECT 'Apple workouts', max(observed_on),  5, false FROM health_workouts
    UNION ALL SELECT 'Liftosaur',      max(performed_on), 5, false FROM lifting_sets
)
SELECT label,
       latest,
       today_local() - latest AS age_days,
       CASE
           WHEN latest IS NULL                        THEN 'missing'
           WHEN today_local() - latest > max_age_days THEN 'stale'
           -- Today is always still accumulating: a midday Report once made a
           -- 1241 kcal day look like a 333 kcal fast. Its own status so that
           -- nothing mistakes it for a complete day.
           WHEN today_local() - latest <= 0           THEN 'partial'
           ELSE 'fresh'
       END AS status,
       automatic,
       max_age_days
FROM src
ORDER BY automatic DESC, label;

COMMENT ON VIEW data_freshness IS
    'Per-source data recency. Any automatic source that is stale or missing '
    'means the pipeline is broken. User-driven sources only warn.';
