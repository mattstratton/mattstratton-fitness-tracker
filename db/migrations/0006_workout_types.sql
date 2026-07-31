-- Workout type catalog, and a training_sessions view that uses it.
--
-- Added after parsing ten years of real exports, which contradicted the
-- assumption the first version was built on. The original view hardcoded the
-- single string 'Traditional Strength Training'; the archive actually holds 20
-- distinct types, including 285 Indoor Cycling sessions and 47 Functional
-- Strength Training ones. The latter is lifting and was being misfiled as
-- "other"; the former makes a binary lifting/not-lifting split useless.
--
-- Same shape as metric_catalog: a lookup table, so reclassifying a workout type
-- is an UPDATE rather than a migration, and an unseen type still lands.

CREATE TABLE workout_types (
    type text PRIMARY KEY,
    kind text NOT NULL,
    CONSTRAINT workout_types_kind_known
        CHECK (kind IN ('lifting', 'cardio', 'mobility', 'other'))
);

COMMENT ON TABLE workout_types IS
    'Classification for health_workouts.type. Types absent from this table are '
    'treated as ''other''. Only ''lifting'' types are reconciled against Liftosaur.';

INSERT INTO workout_types (type, kind) VALUES
    ('Traditional Strength Training', 'lifting'),
    ('Functional Strength Training',  'lifting'),
    ('Core Training',                 'lifting'),
    ('Cross Training',                'lifting'),
    ('Indoor Cycling',                'cardio'),
    ('Outdoor Cycling',               'cardio'),
    ('Cycling',                       'cardio'),
    ('Run',                           'cardio'),
    ('Indoor Run',                    'cardio'),
    ('Outdoor Walk',                  'cardio'),
    ('Indoor Walk',                   'cardio'),
    ('Walk',                          'cardio'),
    ('Elliptical',                    'cardio'),
    ('Hiking',                        'cardio'),
    ('Yoga',                          'mobility'),
    ('Flexibility',                   'mobility'),
    ('Preparation & Recovery',        'mobility'),
    ('Mind & Body',                   'mobility'),
    ('Golf',                          'other'),
    ('Other',                         'other');

DROP VIEW training_sessions;

CREATE VIEW training_sessions AS
WITH classified AS (
    SELECT hw.*, COALESCE(wt.kind, 'other') AS kind
    FROM health_workouts hw
    LEFT JOIN workout_types wt ON wt.type = hw.type
),
matched AS (
    -- Pair each Liftosaur record with its closest-in-time Apple copy, ONE to
    -- one. Matching per-workout rather than per-day matters: a date-based
    -- guard would suppress every strength row on a lifting day, so a genuine
    -- second session Liftosaur never saw would silently vanish.
    -- Known limit: two Liftosaur records on one day can both claim the same
    -- Apple row, which then gets suppressed once. Acceptable at this volume.
    SELECT DISTINCT ON (r.record_id)
           r.record_id,
           c.started_at AS matched_started_at,
           c.duration_min,
           c.energy_kcal
    FROM lifting_records r
    JOIN classified c
      ON c.kind = 'lifting'
     AND c.observed_on = r.performed_on
    ORDER BY r.record_id, abs(extract(epoch FROM c.started_at - r.started_at))
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

-- Every Apple workout not consumed above: all cardio and mobility, genuine
-- second strength sessions, and -- the big one -- eight years of training from
-- before Liftosaur existed. Liftosaur history starts in 2024; Apple's goes back
-- to 2016 and holds 806 sessions against Liftosaur's 182.
SELECT c.observed_on,
       c.started_at,
       c.kind,
       c.type,
       NULL,
       c.duration_min,
       c.energy_kcal,
       NULL
FROM classified c
WHERE NOT EXISTS (
    SELECT 1 FROM matched m WHERE m.matched_started_at = c.started_at
);

-- Surfaces any workout type the catalog hasn't classified, so new ones get
-- noticed rather than silently defaulting to 'other' forever.
CREATE VIEW unclassified_workout_types AS
SELECT hw.type, count(*) AS sessions, max(hw.observed_on) AS most_recent
FROM health_workouts hw
LEFT JOIN workout_types wt ON wt.type = hw.type
WHERE wt.type IS NULL
GROUP BY hw.type ORDER BY 2 DESC;
