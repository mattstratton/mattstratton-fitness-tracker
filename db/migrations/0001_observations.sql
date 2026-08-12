-- Observations: every daily scalar from every source, as an append-only Report log.
-- See docs/adr/0001 (append, never update) and docs/adr/0002 (one table, not four).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- The canonical day boundary, in one place. See docs/adr/0003.
-- Every Observed Day in this database is a calendar day in this zone.
CREATE OR REPLACE FUNCTION local_day(ts timestamptz)
    RETURNS date
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT (ts AT TIME ZONE 'America/Chicago')::date $$;

CREATE OR REPLACE FUNCTION today_local()
    RETURNS date
    LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT local_day(now()) $$;

CREATE TABLE observations (
    observed_on  date             NOT NULL,
    metric       text             NOT NULL,
    value        double precision NOT NULL,
    unit         text             NOT NULL,
    -- How the Report reached us. NOT the same thing as recorded_by.
    source       text             NOT NULL,
    -- What actually recorded the value: 'Withings', 'MyFitnessPal | Withings',
    -- 'Matthew's Apple Watch'. HAE supplies this per point and the first
    -- version of this schema threw it away -- which turned out to be the field
    -- that explained a 343.5 lb weigh-in sitting between scale readings of
    -- 316.8 and 302.1. It was hand-typed into MyFitnessPal; every reading
    -- around it came off the scale. Provenance is not decoration.
    recorded_by  text,
    reported_at  timestamptz      NOT NULL,

    CONSTRAINT observations_metric_not_blank CHECK (metric <> ''),
    CONSTRAINT observations_unit_not_blank   CHECK (unit <> ''),
    CONSTRAINT observations_source_known
        CHECK (source IN ('hae', 'hae_backfill', 'sqlite_backfill'))
) WITH (
    tsdb.hypertable,
    tsdb.partition_column = 'observed_on',
    tsdb.enable_columnstore = true,
    -- Deliberately NO segmentby, which is not the obvious choice -- `metric`
    -- is. What rules it out is the DISTRIBUTION of rows per metric per yearly
    -- chunk, not the average. The average is actively misleading here: a
    -- handful of every-single-day metrics (step_count and friends) drag it to
    -- ~135, comfortably past the >100 rows-per-segment-value guideline, while
    -- most metrics sit nowhere near it. Measured over 73k loaded rows across
    -- 81 metrics, the majority of years have more metrics below the guideline
    -- than above it -- 2025 has 23 at-or-above 100 against 53 below, 46 of
    -- those under 20 rows, median 3. Segmenting would produce dozens of
    -- near-empty compression batches and compress worse, not better.
    --
    -- An earlier version of this comment claimed "~69 rows per metric". That
    -- was computed from the 56k points in the export scan rather than from
    -- loaded rows, and the parser fans out (heart_rate -> 3 metrics,
    -- sleep_analysis -> 6), so 73k rows actually landed. Right conclusion,
    -- wrong arithmetic, and wrong in the direction that would have reversed
    -- the decision if anyone had trusted it. Compute rows-per-segment-value
    -- from the table, not from the input file, and look at the spread.
    --
    -- Ordering by metric instead groups each metric's rows contiguously, which
    -- is where the compression actually comes from, and the automatic minmax
    -- sparse index on an orderby column still gives batch exclusion for
    -- `WHERE metric = ...`.
    tsdb.orderby = 'metric, observed_on DESC'
);

-- Yearly chunks. 73k Reports across 2016-2026 is ~6.6k rows/year, so this
-- gives ~11 fat chunks rather than 44 thin ones, and each holds enough rows to
-- fill several compression batches.
--
-- The deciding reason is Restatements, though: HAE keeps revising a day after
-- that day has closed, so the revision window has to sit inside the chunk that
-- is still uncompressed. Quarterly chunks would put late Restatements of a
-- previous quarter into already-compressed data.
--
-- How wide is that window? MEASURED: one day. Live pushes that change a value
-- arrive at a lag of 1 -- the day ends, HAE reports on it again the next day,
-- and the value still moves (basal_energy_kcal for 2026-08-09 went 1842 ->
-- 1834 -> 2319 across reports on the 10th and 11th). Nothing observed at lag 2
-- or beyond has changed a value yet. ASSUMED: longer, because the live
-- pipeline has only been running since 2026-08-07 and a five-day sample cannot
-- rule out a tail it has not lived through.
--
-- Yearly chunks are wildly conservative for either figure, which is the point:
-- the interval was chosen so the answer does not have to be exact. Do not
-- restate the assumption as a measurement.
SELECT set_chunk_time_interval('observations', INTERVAL '1 year');

-- tsdb.enable_columnstore auto-creates a 7-day columnstore policy, so override
-- rather than add. Chunks close at year end and the observed Restatement
-- window is a day (see above; longer is assumed, not measured), so 30 days
-- past a chunk's range leaves margin for a tail several times wider than
-- anything seen so far.
CALL remove_columnstore_policy('observations', if_exists => true);
CALL add_columnstore_policy('observations', after => INTERVAL '30 days');

-- The dominant read is one metric over a date range.
CREATE INDEX observations_metric_observed_on
    ON observations (metric, observed_on DESC);

-- No primary key, and no unique constraint, by design: a Report log is allowed
-- to restate the same Observation. Uniqueness would make Restatement an error.

COMMENT ON TABLE observations IS
    'Append-only log of Reports. One row is "a source told us, at reported_at, '
    'that metric had this value on observed_on". Never updated. Current truth '
    'is observations_daily.';
COMMENT ON COLUMN observations.observed_on IS 'Observed Day: calendar day in America/Chicago.';
COMMENT ON COLUMN observations.reported_at IS 'Report Time: when the source told us. Orders Restatements.';
