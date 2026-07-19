"""Shared helpers for the fitness pipeline: db connection, schema, .env, sync_log."""

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent
DB_PATH = REPO_DIR / "fitness.db"
SCHEMA_PATH = REPO_DIR / "schema.sql"
ENV_PATH = REPO_DIR / ".env"

KG_TO_LBS = 2.2046226218


def load_env() -> dict:
    env = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip().strip("'\"")
    # Real environment variables override .env
    for key in ("LIFTOSAUR_API_KEY", "HAE_EXPORT_DIR"):
        if key in os.environ:
            env[key] = os.environ[key]
    return env


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA_PATH.read_text())
    return conn


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log_sync(conn, source: str, files: int, rows: int, status: str, message: str = ""):
    conn.execute(
        "INSERT INTO sync_log (source, run_ts, files_processed, rows_upserted, status, message) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (source, now_iso(), files, rows, status, message),
    )
    conn.commit()


def last_ok_run(conn, source: str):
    row = conn.execute(
        "SELECT run_ts FROM sync_log WHERE source = ? AND status = 'ok' "
        "ORDER BY run_ts DESC LIMIT 1",
        (source,),
    ).fetchone()
    return row[0] if row else None


def fail(source: str, message: str):
    try:
        conn = get_db()
        log_sync(conn, source, 0, 0, "error", message)
    except Exception:
        pass
    print(f"ERROR [{source}]: {message}", file=sys.stderr)
    sys.exit(1)
