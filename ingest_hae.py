#!/usr/bin/env python3
"""Ingest Health Auto Export JSON files from the iCloud export folder into fitness.db.

HAE payload format (github.com/Lybron/health-auto-export):
  {"data": {"metrics": [{"name", "units", "data": [{"date", "qty", ...}]}],
            "workouts": [{"name"/"workoutName", "start", "end", ...}]}}
Some file exports omit the top-level "data" wrapper; both shapes are handled.
Re-runs are safe: everything is an upsert on natural keys, and files are
re-parsed only if modified since the last successful run.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from lib import KG_TO_LBS, fail, get_db, last_ok_run, load_env, log_sync

# Automations write into HAE's own iCloud container (shown as the app's folder
# in Files); manual exports go to iCloud Drive proper. Scan both, recursively —
# non-export JSONs (automation configs) parse to zero rows and are harmless.
ICLOUD = Path.home() / "Library/Mobile Documents"
DEFAULT_EXPORT_DIRS = [
    ICLOUD / "iCloud~com~ifunography~HealthExport/Documents",
    ICLOUD / "com~apple~CloudDocs/HealthExport",
]

# HAE metric name -> (table, column). Weight/fat handled separately.
NUTRITION_METRICS = {
    "dietary_energy": "calories",
    "protein": "protein_g",
    "carbohydrates": "carbs_g",
    "total_fat": "fat_g",
}
ACTIVITY_METRICS = {
    "step_count": "steps",
    "active_energy": "active_energy_kcal",
    "apple_exercise_time": "exercise_minutes",
}


def metric_date(point: dict) -> str | None:
    raw = point.get("date") or point.get("start") or ""
    return raw[:10] if len(raw) >= 10 else None


def upsert_nutrition(conn, column: str, points: list) -> int:
    n = 0
    for p in points:
        date, qty = metric_date(p), p.get("qty")
        if date is None or qty is None:
            continue
        conn.execute(
            f"INSERT INTO nutrition (date, {column}) VALUES (?, ?) "
            f"ON CONFLICT(date) DO UPDATE SET {column} = excluded.{column}",
            (date, qty),
        )
        n += 1
    return n


def upsert_activity(conn, column: str, points: list) -> int:
    n = 0
    for p in points:
        date, qty = metric_date(p), p.get("qty")
        if date is None or qty is None:
            continue
        conn.execute(
            f"INSERT INTO activity (date, {column}) VALUES (?, ?) "
            f"ON CONFLICT(date) DO UPDATE SET {column} = excluded.{column}",
            (date, qty),
        )
        n += 1
    return n


def upsert_body_metric(conn, metric_name: str, units: str, points: list) -> int:
    n = 0
    for p in points:
        date, qty = metric_date(p), p.get("qty")
        if date is None or qty is None:
            continue
        if metric_name == "weight_body_mass":
            name = "weight_lbs"
            value = qty * KG_TO_LBS if units == "kg" else qty
            unit = "lbs"
        else:
            name, value, unit = metric_name, qty, units
        conn.execute(
            "INSERT INTO body_metrics (date, metric, value, unit) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(date, metric) DO UPDATE SET value = excluded.value, unit = excluded.unit",
            (date, name, value, unit),
        )
        n += 1
    return n


def upsert_sleep(conn, units: str, points: list) -> int:
    to_minutes = {"hr": 60.0, "min": 1.0}.get(units, 60.0)
    n = 0
    for p in points:
        date = metric_date(p)
        if date is None:
            continue
        asleep = p.get("asleep") or p.get("totalSleep")
        in_bed = p.get("inBed") or p.get("inBedTime")
        stages = {k: v for k, v in p.items()
                  if k in ("core", "deep", "rem", "awake") and v is not None}
        conn.execute(
            "INSERT INTO sleep (date, asleep_minutes, in_bed_minutes, stages_json) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(date) DO UPDATE SET asleep_minutes = excluded.asleep_minutes, "
            "in_bed_minutes = excluded.in_bed_minutes, stages_json = excluded.stages_json",
            (
                date,
                asleep * to_minutes if asleep is not None else None,
                in_bed * to_minutes if in_bed is not None else None,
                json.dumps(stages) if stages else None,
            ),
        )
        n += 1
    return n


def upsert_workouts(conn, workouts: list) -> int:
    n = 0
    for w in workouts:
        start = w.get("start")
        wtype = w.get("name") or w.get("workoutName") or "Unknown"
        if not start:
            continue
        # HAE writes each automation's output to two folders, and only some
        # variants carry an id — key on start|type so duplicates collapse.
        wid = f"{start}|{wtype}"
        duration = w.get("duration")
        energy = w.get("activeEnergyBurned")
        if isinstance(energy, dict):
            energy = energy.get("qty")
        if isinstance(duration, dict):
            duration = duration.get("qty")
        if duration is not None:
            duration = duration / 60.0  # HAE reports seconds
        conn.execute(
            "INSERT INTO workouts (id, start_ts, end_ts, type, duration_min, energy_kcal) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET end_ts = excluded.end_ts, type = excluded.type, "
            "duration_min = excluded.duration_min, energy_kcal = excluded.energy_kcal",
            (wid, start, w.get("end"), wtype, duration, energy),
        )
        n += 1
    return n


def ingest_file(conn, path: Path) -> tuple[int, list]:
    payload = json.loads(path.read_text())
    data = payload.get("data", payload)
    rows = 0
    unknown = []
    if not isinstance(data, dict):
        return 0, []
    for metric in data.get("metrics", []):
        if not isinstance(metric, dict):
            continue  # automation config files list metric names as strings
        name = metric.get("name", "")
        units = metric.get("units", "")
        points = metric.get("data", [])
        if name in NUTRITION_METRICS:
            rows += upsert_nutrition(conn, NUTRITION_METRICS[name], points)
        elif name in ACTIVITY_METRICS:
            rows += upsert_activity(conn, ACTIVITY_METRICS[name], points)
        elif name in ("weight_body_mass", "body_fat_percentage", "lean_body_mass"):
            rows += upsert_body_metric(conn, name, units, points)
        elif name == "sleep_analysis":
            rows += upsert_sleep(conn, units, points)
        else:
            unknown.append(name)
    workouts = [w for w in data.get("workouts", []) if isinstance(w, dict)]
    rows += upsert_workouts(conn, workouts)
    return rows, unknown


def main():
    env = load_env()
    if "HAE_EXPORT_DIR" in env:
        export_dirs = [Path(env["HAE_EXPORT_DIR"]).expanduser()]
    else:
        export_dirs = DEFAULT_EXPORT_DIRS
    export_dirs = [d for d in export_dirs if d.is_dir()]
    force = "--force" in sys.argv
    if not export_dirs:
        fail("hae", "no export dir found (looked for AutoExport/HealthExport in iCloud)")

    conn = get_db()
    since = None if force else last_ok_run(conn, "hae")

    files, total_rows, all_unknown, errors = 0, 0, set(), []
    for path in sorted(p for d in export_dirs for p in d.rglob("*.json")):
        mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
        if since and mtime <= since:
            continue
        try:
            rows, unknown = ingest_file(conn, path)
            total_rows += rows
            all_unknown.update(unknown)
            files += 1
        except Exception as e:
            errors.append(f"{path.name}: {e}")

    conn.commit()
    message = ""
    if all_unknown:
        message += f"unmapped metrics: {sorted(all_unknown)} "
    if errors:
        message += f"skipped: {errors}"
    log_sync(conn, "hae", files, total_rows, "ok" if not errors else "partial", message.strip())
    print(f"hae: {files} files, {total_rows} rows upserted"
          + (f" — {message.strip()}" if message.strip() else ""))


if __name__ == "__main__":
    main()
