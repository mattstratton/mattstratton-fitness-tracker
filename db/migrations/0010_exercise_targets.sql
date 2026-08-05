-- Exercise-minutes target, editable from /settings -- mirrors
-- nutrition_targets (0009): append-only, same reasoning as observations
-- (docs/adr/0001). An edit is a new effective-dated row, never an UPDATE, so
-- the settings page can show a real history and a past day's target is never
-- rewritten by a later change.
--
-- Unlike steps (no established goal anywhere in this app), exercise minutes
-- has a real, intentional daily target -- Apple's own Exercise ring -- so
-- grading adherence against it (like protein/calories) is the right shape
-- here, in a way it isn't for steps.

CREATE TABLE exercise_targets (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    minutes_target numeric NOT NULL,
    effective_on   date    NOT NULL DEFAULT today_local(),
    note           text,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- The dominant read: "what's current" -- latest row whose effective_on has
-- arrived yet.
CREATE INDEX exercise_targets_effective_on
    ON exercise_targets (effective_on DESC, created_at DESC);

COMMENT ON TABLE exercise_targets IS
    'Append-only log of exercise-minutes target changes. Current truth is the '
    'latest row with effective_on <= today_local(). Never updated -- an edit is a new row.';

-- Seed with the real value from Matty's Apple Watch Exercise ring so the app
-- has a row to read on first deploy.
INSERT INTO exercise_targets (minutes_target, effective_on, note)
VALUES (45, today_local(), 'Apple Watch Exercise ring goal, carried over at migration time');
