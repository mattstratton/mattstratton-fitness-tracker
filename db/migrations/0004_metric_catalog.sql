-- Metric catalog: which Metrics we pay attention to, and what they should look
-- like. Optional metadata OVER observations, never a gate on it -- a Metric with
-- no catalog row still lands and is still queryable. That is the whole point of
-- docs/adr/0002, and a catalog that could reject rows would quietly undo it.
--
-- It also restores, as data, the two things EAV gave up: a canonical unit per
-- Metric (checkable, see unit_anomalies below) and a human name.
--
-- Note on the word: this is `attention`, NOT `tier`. Tier already means GZCLP's
-- T1/T2/T3 in this domain (see CONTEXT.md) and must not be overloaded.

CREATE TABLE metric_catalog (
    metric         text PRIMARY KEY,
    display_name   text    NOT NULL,
    canonical_unit text    NOT NULL,
    attention      text    NOT NULL,
    -- NULL means "not freshness-monitored". Most Metrics are NULL: monitoring
    -- something with 6% coverage manufactures permanent false alarms, and an
    -- alert you've learned to ignore is how a real five-day weight gap survives
    -- five days.
    max_age_days   integer,
    automatic      boolean NOT NULL DEFAULT false,
    note           text,

    CONSTRAINT metric_catalog_attention_known
        CHECK (attention IN ('core', 'tracked', 'ambient'))
);

COMMENT ON COLUMN metric_catalog.attention IS
    'core = view + freshness + coached on; tracked = stored and viewable, not '
    'monitored; ambient = lands and is ignored. Absence from this table means ambient.';
COMMENT ON COLUMN metric_catalog.automatic IS
    'True when the Watch writes it unprompted, so a gap is always a broken '
    'pipeline. False when it needs Matty to log food or stand on a scale.';

INSERT INTO metric_catalog
    (metric, display_name, canonical_unit, attention, max_age_days, automatic, note) VALUES

-- ---- core: body composition -------------------------------------------------
-- The question a GLP-1 cut actually turns on is whether the loss is fat or
-- lean mass, which needs all three together. ~44% coverage in 2026.
('weight_lbs',         'Weight',            'lb',        'core',    4, false, null),
('body_fat_pct',       'Body fat',          '%',         'core',    5, false, null),
('lean_mass_lbs',      'Lean body mass',    'lb',        'core',    5, false, null),

-- ---- core: energy balance ---------------------------------------------------
-- basal + active - dietary is the real deficit. Previously not stored at all,
-- so deficit was assumed rather than measured. Best-covered signals after steps.
('calories',           'Calories eaten',    'kcal',      'core',    2, false, null),
('basal_energy_kcal',  'Basal energy',      'kcal',      'core',    3, true,  null),
('active_energy_kcal', 'Active energy',     'kcal',      'core',    3, true,  null),

-- ---- core: macros -----------------------------------------------------------
('protein_g',          'Protein',           'g',         'core',    2, false,
    'Near-non-negotiable on a GLP-1 cut; shortfalls are a logistics problem.'),
('carbs_g',            'Carbohydrates',     'g',         'core',    null, false, null),
('fat_g',              'Fat',               'g',         'core',    null, false, null),
('fiber_g',            'Fibre',             'g',         'core',    null, false, null),

-- ---- core: activity ---------------------------------------------------------
('steps',              'Steps',             'count',     'core',    2, true,
    'The only metric with 100% coverage in 2026. The canary for the whole pipeline.'),
('exercise_minutes',   'Exercise minutes',  'min',       'core',    3, true,  null),

-- ---- core: recovery ---------------------------------------------------------
-- ~250 points each in 2025; the earliest warning of overreaching on a deficit.
-- Monitored loosely (7d, warn-only) because 2026 watch-wear is ~40%.
('resting_hr',         'Resting heart rate','count/min', 'core',    7, false, null),
('hrv_ms',             'HRV',               'ms',        'core',    7, false, null),

-- ---- tracked: real, but too sparse or too slow to monitor -------------------
-- Sleep is deliberately NOT monitored: 16 points in 19 months (6.6% of 2026).
-- It matters enormously in principle and is worth accumulating forward, but
-- alerting on it today would be pure noise.
('sleep_asleep_min',   'Asleep',            'min',       'tracked', null, false,
    'Only ~7% coverage. Excluded from freshness until watch-wear improves.'),
('sleep_in_bed_min',   'In bed',            'min',       'tracked', null, false, null),
('sleep_core_min',     'Core sleep',        'min',       'tracked', null, false, null),
('sleep_deep_min',     'Deep sleep',        'min',       'tracked', null, false, null),
('sleep_rem_min',      'REM sleep',         'min',       'tracked', null, false, null),
('sleep_awake_min',    'Awake',             'min',       'tracked', null, false, null),

('vo2_max',            'VO2 max',           'ml/(kg·min)','tracked', null, false,
    'Quarterly-ish. A long-run fitness trend, meaningless day to day.'),
('bmi',                'BMI',               'count',     'tracked', null, false, null),
('respiratory_rate',   'Respiratory rate',  'count/min', 'tracked', null, false, null),
('blood_oxygen_pct',   'Blood oxygen',      '%',         'tracked', null, false, null),
('wrist_temp_f',       'Sleeping wrist temp','degF',     'tracked', null, false, null),
('heart_rate_min',     'Heart rate (min)',  'count/min', 'tracked', null, false, null),
('heart_rate_max',     'Heart rate (max)',  'count/min', 'tracked', null, false, null),
('heart_rate_avg',     'Heart rate (avg)',  'count/min', 'tracked', null, false, null),

-- Micronutrients: low individual value, occasionally relevant on a cut where
-- total food volume is small. Zero cost to keep, so they are kept.
('sodium_mg',          'Sodium',            'mg',        'tracked', null, false, null),
('potassium_mg',       'Potassium',         'mg',        'tracked', null, false, null),
('calcium_mg',         'Calcium',           'mg',        'tracked', null, false, null),
('iron_mg',            'Iron',              'mg',        'tracked', null, false, null),
('magnesium_mg',       'Magnesium',         'mg',        'tracked', null, false, null),
('zinc_mg',            'Zinc',              'mg',        'tracked', null, false, null),
('saturated_fat_g',    'Saturated fat',     'g',         'tracked', null, false, null),
('dietary_sugar_g',    'Sugar',             'g',         'tracked', null, false, null),
('water_floz',         'Water',             'fl_oz_us',  'tracked', null, false, null),
('caffeine_mg',        'Caffeine',          'mg',        'tracked', null, false, null);

-- Everything not listed -- gait metrics, audio exposure, flights climbed,
-- daylight, handwashing, toothbrushing, mindful minutes -- is ambient by
-- omission. It lands, it costs nothing, nobody looks at it. Roughly 40% of all
-- rows, and that is fine.

-- Cheap safety net for the one thing EAV genuinely gave up. Ten years of
-- exports currently show zero unit drift; this is how we find out if that ever
-- stops being true.
CREATE VIEW unit_anomalies AS
SELECT o.metric, c.canonical_unit, o.unit AS seen_unit, count(*) AS rows
FROM observations o
JOIN metric_catalog c USING (metric)
WHERE o.unit IS DISTINCT FROM c.canonical_unit
GROUP BY 1, 2, 3;
