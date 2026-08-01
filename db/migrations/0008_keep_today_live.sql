-- Stop the continuous aggregate materialising TODAY.
--
-- Symptom: MacroFactor showed 1556 kcal, the site showed 688. The raw Report log
-- had 1556 (pushed 21:05); observations_daily served 688 (materialised 16:10).
--
-- Cause: once a bucket is materialised, real-time aggregation stops consulting
-- raw rows for it, so every Report arriving later that day is invisible. The
-- watermark had advanced to 2026-08-01 -- past today -- which means the hourly
-- refresh policy DID materialise the current day's bucket.
--
-- That contradicts the assumption behind the original end_offset of 1 hour: that
-- a bucket ending at midnight tonight could never be "older than now minus an
-- hour". It can, and the backfill's earlier (NULL, NULL) refresh was not the
-- only culprit. Second time this bug has appeared, first time the cause is
-- actually understood.
--
-- Fix: an end_offset comfortably wider than one bucket, so the current day is
-- never a refresh candidate and is always served live from raw rows. Two days
-- rather than one leaves margin for timezone skew between the date-typed
-- partition column and now(). Restatements to older days are unaffected --
-- start_offset stays NULL, so the invalidation log re-materialises them.
--
-- Cost: today and yesterday are computed at query time. At ~200 rows a day that
-- is nothing, and correctness on today is the entire point of the page.

SELECT remove_continuous_aggregate_policy('observations_daily');

SELECT add_continuous_aggregate_policy('observations_daily',
    start_offset      => NULL,
    end_offset        => INTERVAL '2 days',
    schedule_interval => INTERVAL '1 hour');
