# mattstratton-fitness-tracker

Personal fitness data: lifting from Liftosaur, nutrition from MacroFactor, and
everything else from Apple Health — landing in TimescaleDB on Tiger Cloud, where
Claude Code queries it for coaching conversations.

Roughly 69,000 observations across 81 metrics going back to **2016**, plus 2,400
lifting sets and 800 workouts.

## Where the data lives

> **Personal health data is in a hosted database.** An earlier version of this
> README promised it never left the laptop. That is no longer true, and the
> trade was deliberate: see [docs/adr/0005](docs/adr/0005-health-data-in-a-managed-cloud.md).
> The service is in a personal Tiger Cloud project, not a work one.

```
MacroFactor ─┐
             ├─► Apple Health ──► Health Auto Export (iOS)
Apple Watch ─┘                            │ HTTPS POST, daily
                                          ▼
                              POST /api/hae  (Vercel)
                                          │
Liftosaur REST API ◄── GET /api/cron/liftosaur (daily)
                                          │
                                          ▼
                              Tiger Cloud (TimescaleDB)
                                          │
                                          ▼
                         `npm run q` / the /coach skill
```

No files, no iCloud, no laptop. The Mac is not infrastructure —
[docs/adr/0004](docs/adr/0004-hae-pushes-to-an-api.md).

## Reading the data

```bash
npm run q "SELECT * FROM data_freshness"
npm run q -- --json "SELECT * FROM energy_reality_check"
```

`q` reads `DATABASE_URL` from this repo's `.env` and refuses writes unless
`ALLOW_WRITES=1`. It deliberately does not use the Tiger MCP: that is user-level
config on a machine also used for work, and coaching access should be scoped by
which directory you are in, not by global state.

Friendly views over the raw log: `nutrition`, `activity`, `body`, `sleep`,
`recovery`, `energy_balance`, `training_sessions`, `data_freshness`.

## The one idea worth knowing

Everything from Apple Health is stored as an append-only log of **Reports** — "a
source told us, at this time, what this metric was on this day". Nothing is ever
updated. Current truth is `observations_daily`, a continuous aggregate computing
`last(value, reported_at)`.

That matters because HAE revises a day for about a week after it happens, and the
old SQLite schema overwrote silently. Two bugs hid in that: a five-day stretch
where an iOS update dropped HealthKit permission for weight while every sync
reported success, and a midday export that made a 1241 kcal day look like 333.
Both are now visible as data. See
[docs/adr/0001](docs/adr/0001-append-reports-never-update-observations.md).

Vocabulary — Observation, Report, Observed Day, Partial Day, Restatement — is
defined in [CONTEXT.md](CONTEXT.md). It is worth two minutes.

## Setup

1. **Database.** A Tiger Cloud service, then `npm run migrate`.
2. **Secrets.** Copy `.env.example` to `.env` and fill it in.
3. **Backfill.** Drop HAE range exports into `exports/` and `npm run backfill`.
   Idempotent; re-run freely.
4. **Lifting.** `npm run sync-liftosaur`.
5. **Deploy.** See [DEPLOY.md](DEPLOY.md), then point two HAE automations (health
   metrics, workouts) at `/api/hae`.

## Commands

| | |
|---|---|
| `npm run q "SQL"` | query the database |
| `npm test` | 35 parser and auth tests |
| `npm run typecheck` | tsc |
| `npm run migrate` | apply `db/migrations/*.sql` |
| `npm run backfill` | load `exports/*.json` |
| `npm run sync-liftosaur` | pull lifting history |
| `npm run scan-exports` | parse exports without touching a database |
| `npm run diff-oracle` | compare against the retired SQLite database |

## Repo

- `db/migrations/` — schema. Read `0001` first; the comments explain the choices.
- `lib/` — parsers and write path, shared by the API and the scripts so they cannot drift.
- `api/` — the three Vercel functions.
- `docs/adr/` — five decisions that were hard to reverse.
- `docs/migration-log.md` — what went wrong on the way here, kept for a writeup.

Health data, secrets, exports and `node_modules` are gitignored. Keep it that way.
