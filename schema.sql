-- Fitness data warehouse schema. Applied idempotently on every ingest run.
PRAGMA journal_mode = WAL;

-- Daily nutrition totals, sourced from MacroFactor via Apple Health -> HAE
CREATE TABLE IF NOT EXISTS nutrition (
    date        TEXT PRIMARY KEY,          -- YYYY-MM-DD
    calories    REAL,
    protein_g   REAL,
    carbs_g     REAL,
    fat_g       REAL,
    source      TEXT DEFAULT 'apple_health'
);

-- Weight, body fat, and any other per-day body measurements
CREATE TABLE IF NOT EXISTS body_metrics (
    date        TEXT NOT NULL,             -- YYYY-MM-DD
    metric      TEXT NOT NULL,             -- e.g. 'weight_lbs', 'body_fat_pct'
    value       REAL NOT NULL,
    unit        TEXT,
    source      TEXT DEFAULT 'apple_health',
    PRIMARY KEY (date, metric)
);

CREATE TABLE IF NOT EXISTS sleep (
    date            TEXT PRIMARY KEY,      -- date of waking, YYYY-MM-DD
    asleep_minutes  REAL,
    in_bed_minutes  REAL,
    stages_json     TEXT                   -- raw stage breakdown when available
);

CREATE TABLE IF NOT EXISTS activity (
    date                TEXT PRIMARY KEY,  -- YYYY-MM-DD
    steps               REAL,
    active_energy_kcal  REAL,
    exercise_minutes    REAL
);

-- Apple Health workouts: yoga, walks, anything logged outside Liftosaur
CREATE TABLE IF NOT EXISTS workouts (
    id           TEXT PRIMARY KEY,         -- HAE workout id, or start_ts|type fallback
    start_ts     TEXT NOT NULL,            -- ISO 8601
    end_ts       TEXT,
    type         TEXT,                     -- e.g. 'Yoga', 'Walking'
    duration_min REAL,
    energy_kcal  REAL,
    source       TEXT DEFAULT 'apple_health'
);

-- One row per set, full Liftosaur history
CREATE TABLE IF NOT EXISTS liftosaur_sets (
    record_id    INTEGER NOT NULL,         -- Liftosaur history record id
    date         TEXT NOT NULL,            -- YYYY-MM-DD
    program      TEXT,
    day_name     TEXT,
    exercise     TEXT NOT NULL,            -- e.g. 'benchPress_barbell'
    set_index    INTEGER NOT NULL,
    reps         INTEGER,
    weight_lbs   REAL,
    is_completed INTEGER,                  -- 0/1
    tier         TEXT,                     -- T1/T2/T3 when derivable, else NULL
    target_reps  INTEGER,                  -- prescribed reps for this set, from Liftosaur's target: segment
    is_amrap     INTEGER,                  -- 0/1, whether target_reps was an AMRAP ("5+") set
    PRIMARY KEY (record_id, exercise, set_index)
);

CREATE INDEX IF NOT EXISTS idx_liftosaur_sets_date ON liftosaur_sets(date);
CREATE INDEX IF NOT EXISTS idx_liftosaur_sets_exercise ON liftosaur_sets(exercise);

CREATE TABLE IF NOT EXISTS sync_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL,         -- 'hae' | 'liftosaur'
    run_ts          TEXT NOT NULL,         -- ISO 8601
    files_processed INTEGER DEFAULT 0,
    rows_upserted   INTEGER DEFAULT 0,
    status          TEXT NOT NULL,         -- 'ok' | 'error'
    message         TEXT
);
