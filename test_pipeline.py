import unittest
from datetime import date

from check_freshness import FRESH, MISSING, PARTIAL, STALE, classify
from ingest_hae import _utc_key
from sync_liftosaur import parse_record, parse_target


class ParseTargetTests(unittest.TestCase):
    def test_expands_target_groups_with_amrap_marker(self):
        self.assertEqual(
            parse_target("2x5 215lb, 1x5+ 215lb"),
            [(5, False), (5, False), (5, True)],
        )

    def test_expands_target_groups_with_trailing_rest_timer(self):
        self.assertEqual(
            parse_target("3x12 93.75lb 90s, 1x12+ 93.75lb 90s"),
            [(12, False), (12, False), (12, False), (12, True)],
        )


class ParseRecordTargetTests(unittest.TestCase):
    def test_attaches_target_reps_and_amrap_flag_to_each_row(self):
        record = {
            "id": 1,
            "text": (
                '2026-07-17 23:48:39 +00:00 / program: "GZCLP: Blacknoir version" '
                '/ dayName: "Day 4" / exercises: {\n'
                "  Deadlift / 3x5 215lb / warmup: 1x5 107.5lb / target: 2x5 215lb, 1x5+ 215lb\n"
                "}"
            ),
        }

        rows = parse_record(record)

        self.assertEqual(len(rows), 3)
        target_reps_and_amrap = [(row[10], row[11]) for row in rows]
        self.assertEqual(
            target_reps_and_amrap,
            [(5, 0), (5, 0), (5, 1)],
        )


class FreshnessTests(unittest.TestCase):
    TODAY = date(2026, 7, 31)

    def test_today_is_partial_because_the_day_is_still_in_progress(self):
        self.assertEqual(classify("2026-07-31", self.TODAY, 2), (PARTIAL, 0))

    def test_yesterday_is_fresh(self):
        self.assertEqual(classify("2026-07-30", self.TODAY, 2), (FRESH, 1))

    def test_flags_the_five_day_weight_gap_that_sync_log_reported_as_ok(self):
        self.assertEqual(classify("2026-07-26", self.TODAY, 4), (STALE, 5))

    def test_gap_inside_the_allowance_is_fresh_not_stale(self):
        self.assertEqual(classify("2026-07-27", self.TODAY, 4), (FRESH, 4))

    def test_empty_table_is_missing_rather_than_infinitely_stale(self):
        self.assertEqual(classify(None, self.TODAY, 2), (MISSING, None))


class WorkoutKeyTests(unittest.TestCase):
    def test_same_instant_in_two_timezones_collapses_to_one_key(self):
        self.assertEqual(
            _utc_key("2026-07-26 10:33:41 -0500"),
            _utc_key("2026-07-26 11:33:41 -0400"),
        )

    def test_genuinely_different_workouts_keep_distinct_keys(self):
        self.assertNotEqual(
            _utc_key("2026-07-26 10:33:41 -0500"),
            _utc_key("2026-07-26 10:33:41 -0400"),
        )

    def test_unparseable_timestamp_passes_through_instead_of_raising(self):
        self.assertEqual(_utc_key("not a timestamp"), "not a timestamp")


if __name__ == "__main__":
    unittest.main()
