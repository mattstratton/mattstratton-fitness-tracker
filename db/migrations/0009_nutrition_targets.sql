-- Nutrition targets, out of lib/config.ts and into the database.
--
-- MacroFactor re-tunes calories/protein roughly weekly as weight and body-fat%
-- shift, which is too often for a hardcoded constant edited by hand. This was
-- anticipated: the config.ts comment it replaces said almost word-for-word
-- "if it ever starts changing often, this becomes a table with effective
-- dates and the signals keep taking it as a parameter either way."
--
-- Append-only, same reasoning as observations (docs/adr/0001): an edit is a
-- new effective-dated row, never an UPDATE, so the settings page can show a
-- real history and a past day's target is never rewritten by a later change.

CREATE TABLE nutrition_targets (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phase        text    NOT NULL CHECK (phase IN ('cut', 'maintain', 'bulk')),
    protein_g    numeric NOT NULL,
    -- Null means "not being steered" -- same meaning as Targets.calories in
    -- lib/config.ts. Maintenance and bulk phases have shipped with this null.
    calories     numeric,
    -- Signed expected lb/week: negative on a cut, positive on a bulk, ~0 on
    -- maintenance. See lib/signals/body.ts, which derives direction from its
    -- sign rather than switching on phase directly.
    expected     numeric NOT NULL,
    concerning   numeric NOT NULL,
    effective_on date    NOT NULL DEFAULT today_local(),
    note         text,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- The dominant read: "what's current" -- latest row whose effective_on has
-- arrived yet.
CREATE INDEX nutrition_targets_effective_on
    ON nutrition_targets (effective_on DESC, created_at DESC);

COMMENT ON TABLE nutrition_targets IS
    'Append-only log of nutrition target changes. Current truth is the latest '
    'row with effective_on <= today_local(). Never updated -- an edit is a new row.';

-- Seed with the settled values from nutrition-strategy.md so the app has a
-- row to read on first deploy.
INSERT INTO nutrition_targets (phase, protein_g, calories, expected, concerning, effective_on, note)
VALUES ('cut', 198, 1660, -1.0, 1.5, '2026-07-01', 'Carried over from lib/config.ts at migration time');
