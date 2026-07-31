-- Reality checks: views whose job is to say how much to trust another view.
--
-- Added because energy_balance, the metric this migration was most pleased to
-- finally store, turned out to be wrong the moment it met real data. Over 20
-- days it reported a 1,542 kcal/day deficit, which predicts ~3 lb/week; the
-- actual weight trend over the same window was ~1.25 lb/week, implying a real
-- deficit nearer 625.
--
-- Nothing is broken. basal_energy_kcal is a formula estimate from
-- weight/height/age, and watch active_energy runs generous. Both are real
-- numbers whose *difference* is not a measurement. The fix isn't to hide the
-- view, it's to make the gap visible -- a caveat in a comment is invisible at
-- 6am when an agent reads the number and reports it as fact, which is exactly
-- how the sleep-stage unit bug survived: documented, and wrong.

-- Weight readings that disagree with their own neighbourhood.
--
-- One exists in ten years: 343.5 lb on 2021-11-30, between scale readings of
-- 316.8 and 302.1. Its recorded_by is 'MyFitnessPal' alone while every reading
-- around it is 'MyFitnessPal | Withings' -- so it never came off the scale, it
-- was typed in. A hand-entered typo, not a body doing something impossible
-- (41 lb in ten days). Nothing was wrong with the parsing; the field that
-- explained it was simply being discarded.
CREATE VIEW weight_outliers AS
SELECT w.observed_on,
       ROUND(w.value::numeric, 1)         AS value_lb,
       ROUND(m.local_median::numeric, 1)  AS local_median_lb,
       ROUND((100 * (w.value - m.local_median) / m.local_median)::numeric, 1) AS pct_off,
       w.recorded_by,
       -- A reading with no scale in its provenance was typed in by hand. Not
       -- automatically wrong -- everything before 2018 is manual, because there
       -- was no scale yet -- but it is how the one real outlier got in.
       (w.recorded_by IS NULL OR w.recorded_by NOT ILIKE '%withings%') AS hand_entered
FROM observations_daily w
CROSS JOIN LATERAL (
    -- Median of everything within three weeks either side, so a single bad
    -- reading can't defend itself.
    SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY n.value) AS local_median
    FROM observations_daily n
    WHERE n.metric = 'weight_lbs'
      AND n.observed_on BETWEEN w.observed_on - 21 AND w.observed_on + 21
) m
WHERE w.metric = 'weight_lbs'
  AND m.local_median IS NOT NULL
  AND abs(w.value - m.local_median) / m.local_median > 0.08;

COMMENT ON VIEW weight_outliers IS
    'Weigh-ins more than 8% from their own three-week neighbourhood median. '
    'Almost certainly bad scale readings; exclude from trends.';

-- Weight trend, outliers removed, as lb/week over trailing windows.
CREATE VIEW weight_trend AS
SELECT wd.days,
       count(*) AS weigh_ins,
       -- regr_slope over day offsets gives lb/day directly, and uses every
       -- reading rather than just the endpoints -- two noisy weigh-ins at the
       -- edges of a window would otherwise decide the whole answer.
       ROUND((regr_slope(o.value, (o.observed_on - today_local())::int) * 7)::numeric, 2)
           AS lbs_per_week
FROM (VALUES (14), (28), (90)) AS wd(days)
JOIN observations_daily o
  ON o.metric = 'weight_lbs'
 AND o.observed_on > today_local() - wd.days
 AND o.observed_on <= today_local()
WHERE NOT EXISTS (
    SELECT 1 FROM weight_outliers x WHERE x.observed_on = o.observed_on
)
GROUP BY wd.days
HAVING count(*) >= 3;   -- a slope through two points is not a trend

-- The point of this migration: what energy_balance implies, next to what the
-- scale actually did.
CREATE VIEW energy_reality_check AS
SELECT t.days                                            AS window_days,
       e.days_logged,
       -- Read overstatement_factor only when this is high. avg_net_kcal is an
       -- average over LOGGED days, compared against a weight trend over ALL
       -- days -- so at 19 days logged out of 90 the comparison is meaningless,
       -- and it duly reports a nonsense 4.9x. Unlogged days are unlogged, not
       -- fasted; the same "gaps are not zeros" trap as everywhere else.
       ROUND(100.0 * e.days_logged / t.days)             AS coverage_pct,
       ROUND(e.avg_net_kcal)                             AS avg_net_kcal,
       -- ~3500 kcal per pound of bodyfat. A rule of thumb, not physics, but
       -- good enough to expose a 2x discrepancy.
       ROUND((e.avg_net_kcal * 7 / 3500)::numeric, 2)    AS implied_lbs_per_week,
       t.lbs_per_week                                    AS actual_lbs_per_week,
       CASE WHEN t.lbs_per_week <> 0
            THEN ROUND((e.avg_net_kcal * 7 / 3500 / t.lbs_per_week)::numeric, 2)
       END                                               AS overstatement_factor
FROM weight_trend t
LEFT JOIN LATERAL (
    SELECT avg(net_kcal) AS avg_net_kcal, count(*) AS days_logged
    FROM energy_balance
    WHERE net_kcal IS NOT NULL
      AND observed_on > today_local() - t.days
      -- Today is a Partial Day: its intake is whatever has been logged so far,
      -- so including it drags the apparent deficit down every morning.
      AND observed_on < today_local()
) e ON true;

COMMENT ON VIEW energy_reality_check IS
    'How far energy_balance disagrees with the scale. overstatement_factor near '
    '1.0 means the calorie maths matches reality; 2.4 means Apple''s expenditure '
    'estimate, under-logged intake, or both. Use energy_balance for direction, '
    'this for magnitude -- and ignore any row whose coverage_pct is low.';
