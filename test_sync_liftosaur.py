import unittest

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


if __name__ == "__main__":
    unittest.main()
