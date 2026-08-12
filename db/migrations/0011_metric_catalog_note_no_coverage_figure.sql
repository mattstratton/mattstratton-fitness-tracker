-- Take the stale coverage percentage out of metric_catalog.note.
--
-- WHY THIS EXISTS AS A MIGRATION rather than as a hand-run UPDATE: it was
-- originally a hand-run UPDATE. That is the bug. The note on `sleep_asleep_min`
-- read "Only ~7% coverage. Excluded from freshness until watch-wear improves."
-- and that figure had gone badly stale -- the trailing year was still 6.3% but
-- the last 30 days were at 70%, because overnight watch-wear changed in July
-- 2026. It was corrected in the live database with `ALLOW_WRITES=1 npm run q`
-- and 0004's INSERT was corrected to match, which left the two agreeing only
-- because someone did it by hand on the same afternoon and would have to
-- remember that forever.
--
-- 0004 is the record for a database built from scratch. This is the record for
-- every database that already exists. Idempotent, so it is a no-op on a fresh
-- install where 0004 already inserted the corrected text.
--
-- The general rule this is enforcing: a coverage figure is a measurement, not a
-- property, and does not belong written down anywhere as a standing fact.
-- `list_metrics` computes days-in-the-last-365 on demand. The copy of this same
-- number that lived in the coach system prompt was read aloud to the user as
-- current long after it stopped being true, and was held in place by a unit
-- test asserting the prompt must contain it (see tests/coach.test.ts).

UPDATE metric_catalog
   SET note = 'Excluded from freshness: coverage swings with watch-wear. '
              'Read current coverage from list_metrics rather than assuming a figure.'
 WHERE metric = 'sleep_asleep_min';
