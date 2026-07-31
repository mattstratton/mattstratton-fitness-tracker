#!/usr/bin/env python3
"""Report whether the data in fitness.db actually reaches the present.

`sync_log` only records whether an ingest *ran*. It cannot notice that the phone
stopped handing over weight because an iOS update quietly dropped HealthKit
permissions — which happened for five days in July 2026 while every sync kept
logging status='ok'. Checking data recency instead catches that class of failure,
because it asks the question anyone actually cares about: is this current?

Sources split two ways:
  * automatic — the Apple Watch writes these with no action from Matty, so a gap
    always means something is broken. These decide the exit code.
  * user-driven — needs Matty to log food or step on a scale. A gap is usually
    just life (travel, a skipped weigh-in), so these warn but never fail.
"""

import sys
from dataclasses import dataclass
from datetime import date

from lib import get_db

FRESH, PARTIAL, STALE, MISSING = "fresh", "partial", "stale", "missing"


@dataclass(frozen=True)
class Source:
    label: str
    query: str
    max_age_days: int
    automatic: bool


SOURCES = (
    Source("activity", "SELECT MAX(date) FROM activity", 2, True),
    Source("sleep", "SELECT MAX(date) FROM sleep", 2, True),
    Source("nutrition", "SELECT MAX(date) FROM nutrition", 2, False),
    Source("weight", "SELECT MAX(date) FROM body_metrics WHERE metric = 'weight_lbs'", 4, False),
    Source("workouts", "SELECT MAX(substr(start_ts, 1, 10)) FROM workouts", 5, False),
    Source("liftosaur", "SELECT MAX(date) FROM liftosaur_sets", 5, False),
)


def classify(latest: str | None, today: date, max_age_days: int) -> tuple[str, int | None]:
    """Grade one source's newest date. Returns (status, age_in_days)."""
    if not latest:
        return MISSING, None
    age = (today - date.fromisoformat(latest)).days
    if age > max_age_days:
        return STALE, age
    # Today's row is always a snapshot of a day still in progress — HAE exports
    # whatever has been logged so far, so a midday export turned a normal 1241
    # kcal day into an apparent 333 kcal fast. Callers must exclude it from any
    # average, which is why it gets its own status rather than counting as fresh.
    return (PARTIAL if age <= 0 else FRESH), age


def degraded_syncs(conn) -> list[tuple[str, str, str]]:
    """Latest run per source, where that run wasn't a clean 'ok'."""
    return conn.execute(
        "SELECT source, status, run_ts FROM sync_log AS s "
        "WHERE run_ts = (SELECT MAX(run_ts) FROM sync_log WHERE source = s.source) "
        "AND status != 'ok' ORDER BY source"
    ).fetchall()


def main():
    conn = get_db()
    today = date.today()

    broken, warnings = [], []
    print(f"{'source':<11} {'latest':<12} {'age':>4}  status")
    for src in SOURCES:
        latest = conn.execute(src.query).fetchone()[0]
        status, age = classify(latest, today, src.max_age_days)
        note = " (in progress — exclude from averages)" if status == PARTIAL else ""
        if status in (STALE, MISSING):
            note = f" (expected within {src.max_age_days}d)"
            (broken if src.automatic else warnings).append(src.label)
        print(f"{src.label:<11} {latest or '-':<12} {'-' if age is None else age:>4}  {status}{note}")

    for source, status, run_ts in degraded_syncs(conn):
        print(f"\nlast {source} sync was '{status}' at {run_ts} — see sync_log.message")
        broken.append(f"{source} sync")

    if broken:
        print(f"\nBROKEN: {', '.join(broken)} — the pipeline is not delivering data", file=sys.stderr)
    if warnings:
        print(f"warning: {', '.join(warnings)} is behind; may just be travel or a missed log")
    if not broken and not warnings:
        print("\nall sources current")
    sys.exit(1 if broken else 0)


if __name__ == "__main__":
    main()
