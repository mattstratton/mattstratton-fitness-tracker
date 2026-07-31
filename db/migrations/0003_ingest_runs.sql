-- Ingest runs: what each delivery actually contained.
--
-- Replaces sync_log, which recorded only that a run happened. That distinction
-- is the whole reason this table is shaped differently: sync_log reported
-- status='ok' hourly for five days while an iOS update had silently dropped
-- HealthKit read permission for weight, so every run genuinely succeeded and
-- genuinely delivered nothing. Freshness is never judged from this table --
-- that is data_freshness's job, and it asks about data recency instead.

CREATE TABLE ingest_runs (
    started_at   timestamptz NOT NULL,
    source       text        NOT NULL,   -- 'hae' | 'liftosaur'
    finished_at  timestamptz,
    status       text        NOT NULL,   -- 'ok' | 'error'
    -- What the run FOUND, which is the part sync_log couldn't answer.
    metrics_seen integer     NOT NULL DEFAULT 0,
    rows_written integer     NOT NULL DEFAULT 0,
    detail       jsonb,                  -- per-metric counts, error text

    CONSTRAINT ingest_runs_status_known CHECK (status IN ('ok', 'error')),
    CONSTRAINT ingest_runs_source_known CHECK (source IN ('hae', 'liftosaur'))
) WITH (
    tsdb.hypertable,
    tsdb.partition_column = 'started_at',
    tsdb.enable_columnstore = true,
    -- Only two sources, both with high row counts per chunk, so unlike the
    -- other tables this one genuinely clears the density bar for segmentby.
    tsdb.segmentby = 'source',
    tsdb.orderby = 'started_at DESC'
);

SELECT set_chunk_time_interval('ingest_runs', INTERVAL '1 month');

-- The one table here with an obvious expiry. sync_log reached 611 rows in
-- twelve days -- a quarter of the row count of 2.5 years of actual training --
-- and nothing ever pruned it.
SELECT add_retention_policy('ingest_runs', INTERVAL '90 days');

CREATE INDEX ingest_runs_source_started_at ON ingest_runs (source, started_at DESC);
