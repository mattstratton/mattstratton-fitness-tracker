#!/usr/bin/env python3
"""Sync full Liftosaur workout history into fitness.db via the REST API.

Requires LIFTOSAUR_API_KEY in .env (create in Liftosaur app: Settings -> API Keys).
Records arrive in Liftohistory text format, e.g.:

  2026-07-17 23:48:39 +00:00 / program: "GZCLP: Blacknoir version" / dayName: "Day 4" / ...
  / exercises: {
    Deadlift / 3x5 215lb / warmup: 1x5 107.5lb / target: 2x5 215lb, 1x5+ 215lb
  }

Each performed set group (NxR WEIGHT) expands to N rows in liftosaur_sets.
Warmup segments are ignored; target segments are parsed for target_reps/is_amrap
so a low-but-nonzero rep count (e.g. missing an AMRAP target) can be told apart
from a full success. Idempotent: PK (record_id, exercise, set_index), and each
record's sets are deleted before re-insert so edits in Liftosaur propagate.
"""

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

from lib import KG_TO_LBS, fail, get_db, load_env, log_sync

API_BASE = "https://www.liftosaur.com/api/v1"

HEADER_RE = {
    "program": re.compile(r'program:\s*"([^"]*)"'),
    "day_name": re.compile(r'dayName:\s*"([^"]*)"'),
}
# e.g. "3x5 215lb", "1x13 88.75lb", "2x5 60kg @8", "3x12" (bodyweight)
SET_GROUP_RE = re.compile(r"(\d+)x(\d+)(?:\s+([\d.]+)\s*(lb|kg))?(?:\s+@[\d.]+)?$")
# same shape as SET_GROUP_RE but reps may carry a trailing "+" for AMRAP, e.g. "1x5+ 215lb",
# and a rest-timer suffix like "90s" (seen on T3 accessory targets) may follow the weight
TARGET_GROUP_RE = re.compile(
    r"(\d+)x(\d+)(\+)?(?:\s+([\d.]+)\s*(lb|kg))?(?:\s+@[\d.]+)?(?:\s+\d+s)?$"
)


def fetch_page(api_key: str, cursor=None) -> dict:
    params = {"limit": "200"}
    if cursor is not None:
        params["cursor"] = str(cursor)
    url = f"{API_BASE}/history?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read())
    return payload.get("data", payload)


def parse_sets(segment: str) -> list[tuple[int, float | None]]:
    """'2x5 125lb, 1x6 125lb' -> [(5, 125.0), (5, 125.0), (6, 125.0)]"""
    sets = []
    for group in segment.split(","):
        m = SET_GROUP_RE.match(group.strip())
        if not m:
            continue
        count, reps = int(m.group(1)), int(m.group(2))
        weight = float(m.group(3)) if m.group(3) else None
        if weight is not None and m.group(4) == "kg":
            weight *= KG_TO_LBS
        sets.extend([(reps, weight)] * count)
    return sets


def parse_target(segment: str) -> list[tuple[int, bool]]:
    """'2x5 215lb, 1x5+ 215lb' -> [(5, False), (5, False), (5, True)]"""
    sets = []
    for group in segment.split(","):
        m = TARGET_GROUP_RE.match(group.strip())
        if not m:
            continue
        count, reps, is_amrap = int(m.group(1)), int(m.group(2)), m.group(3) == "+"
        sets.extend([(reps, is_amrap)] * count)
    return sets


def parse_record(record: dict) -> list[tuple]:
    """Return liftosaur_sets rows for one history record."""
    text = record["text"]
    record_id = record["id"]
    header, _, body = text.partition("exercises:")
    # Timestamps arrive as UTC ("2026-07-17 00:20:20 +00:00"); store the LOCAL
    # date so evening sessions land on the same day as nutrition/activity data.
    try:
        ts = datetime.strptime(header.split(" / ")[0].strip(), "%Y-%m-%d %H:%M:%S %z")
        date = ts.astimezone().strftime("%Y-%m-%d")
    except ValueError:
        date = text[:10]
    program = (HEADER_RE["program"].search(header) or [None, None])[1]
    day_name = (HEADER_RE["day_name"].search(header) or [None, None])[1]

    rows = []
    for line in body.strip().strip("{}").strip().splitlines():
        segments = [s.strip() for s in line.strip().split(" / ")]
        if len(segments) < 2:
            continue
        exercise = segments[0]
        performed = next(
            (s for s in segments[1:] if not s.startswith(("warmup:", "target:"))), None
        )
        if performed is None:
            continue
        target_segment = next(
            (s for s in segments[1:] if s.startswith("target:")), None
        )
        targets = parse_target(target_segment.partition(":")[2]) if target_segment else []
        for i, (reps, weight) in enumerate(parse_sets(performed)):
            target_reps, is_amrap = targets[i] if i < len(targets) else (None, None)
            rows.append(
                (record_id, date, program, day_name, exercise, i,
                 reps, weight, 1 if reps > 0 else 0, None,
                 target_reps, None if is_amrap is None else (1 if is_amrap else 0))
            )
    return rows


def main():
    env = load_env()
    api_key = env.get("LIFTOSAUR_API_KEY")
    if not api_key:
        fail("liftosaur", "LIFTOSAUR_API_KEY not set in .env")

    conn = get_db()
    total_rows, records_seen, cursor = 0, 0, None
    try:
        while True:
            page = fetch_page(api_key, cursor)
            for record in page.get("records", []):
                records_seen += 1
                rows = parse_record(record)
                conn.execute("DELETE FROM liftosaur_sets WHERE record_id = ?", (record["id"],))
                conn.executemany(
                    "INSERT INTO liftosaur_sets (record_id, date, program, day_name, "
                    "exercise, set_index, reps, weight_lbs, is_completed, tier, "
                    "target_reps, is_amrap) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    rows,
                )
                total_rows += len(rows)
            if not page.get("hasMore"):
                break
            cursor = page.get("nextCursor")
    except urllib.error.HTTPError as e:
        fail("liftosaur", f"API error {e.code}: {e.read().decode()[:200]}")
    except urllib.error.URLError as e:
        fail("liftosaur", f"network error: {e.reason}")

    conn.commit()
    log_sync(conn, "liftosaur", records_seen, total_rows, "ok")
    print(f"liftosaur: {records_seen} workouts, {total_rows} sets upserted")


if __name__ == "__main__":
    main()
