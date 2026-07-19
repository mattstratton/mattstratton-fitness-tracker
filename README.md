# mattstratton-fitness-tracker

Personal fitness data pipeline: Liftosaur (lifting) + MacroFactor (nutrition, via
Apple Health) + Apple Health (weight, sleep, activity, yoga/other workouts) → a local
SQLite database (`fitness.db`) that Claude Code queries for coaching conversations.

## Data flow

```
MacroFactor ─────► Apple Health ─────► Health Auto Export (iOS, scheduled)
(cal/macros/weight)  (sleep, steps,          │ JSON files
                      workouts too)          ▼
                                     iCloud Drive/HealthExport
                                             │
Liftosaur REST API ──► sync_liftosaur.py    ingest_hae.py
                              └──────┬───────┘
                                     ▼
                                fitness.db (SQLite, local only, gitignored)
```

## Setup

1. **Phone**: MacroFactor → enable Apple Health write. Install Health Auto Export
   (premium), schedule a daily JSON export of nutrition, weight, sleep, steps, and
   workouts to iCloud Drive folder `HealthExport`.
2. **Secrets**: create `.env` (gitignored) in this directory:

   ```
   # Liftosaur app -> Settings -> API Keys -> Create API Key (requires premium)
   LIFTOSAUR_API_KEY=lftsk_...
   # Optional override; default is iCloud Drive/HealthExport
   # HAE_EXPORT_DIR=/path/to/exports
   ```

3. **Sync**: `make sync` (or `make sync-hae` / `make sync-liftosaur` individually).
4. **Automation**: `make install-agent` loads a launchd agent that runs the sync
   daily at 06:00. `make uninstall-agent` removes it.

## Usage

- `make db` — open a sqlite3 shell against `fitness.db`
- `/coach` in Claude Code — coaching conversation over all the data
- Schema lives in `schema.sql`; every ingest is an idempotent upsert, re-running
  anything is always safe. `sync_log` records every run.

Health data and secrets never leave this machine: `fitness.db`, `.env`, raw exports,
and logs are all gitignored.
