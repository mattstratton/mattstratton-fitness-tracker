# mattstratton-fitness-tracker

Personal fitness data: lifting from Liftosaur, nutrition from MacroFactor, and
everything else from Apple Health — landing in TimescaleDB on Tiger Cloud, with a
web app that grades it against deterministic rules and a chat that answers questions
about it.

Roughly 69,000 observations across 81 metrics going back to **2016**, plus 2,400
lifting sets and 800 workouts.

> **Not medical advice.** This is one person's tracker with thresholds tuned to one
> person's circumstances (including a GLP-1) — nothing here is clinical guidance, and
> the signals may be wrong or actively harmful for anyone else.

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
                        ┌─────────────────┴─────────────────┐
                        ▼                                   ▼
          fitness.mattstratton.com                  `npm run q`
          (Next.js on Vercel)                       / the /coach skill
```

No files, no iCloud, no laptop. The Mac is not infrastructure —
[docs/adr/0004](docs/adr/0004-hae-pushes-to-an-api.md).

## The app

**https://fitness.mattstratton.com** — Google sign-in, allowlisted to one address.

- **today** — what's logged so far, then anything needing attention
- **coach** — every signal with its reasoning
- **ask** — a chat that answers questions about the data
- **workouts** — session history set by set, and what the program prescribes next
- **trends** — charts over 30/90/365 days
- **settings** — nutrition and exercise targets, with their change history

It exists because the `/coach` skill can't run on Claude iOS, so coaching on a
phone — which is where the question actually gets asked — had no other route.

There are two coaching modes and they are deliberately kept apart.

**coach is deterministic.** Protein adherence, deficit-vs-scale, weight trend,
overreaching, stalled lifts, freshness. Each is a pure function in `lib/signals/`,
unit-tested against fixtures, so a verdict traces to a rule rather than a vibe.
No LLM is involved in any of it, and `unknown` is a distinct verdict from `ok` —
this dataset produces it constantly.

**ask is an LLM** — Claude, server-side, over 13 read-only tools. It answers the
questions nobody wrote a rule for: "am I stalling on squat", "how big is my deficit
actually", "what's my VO2max doing". Every number in an answer comes from a tool
call you can read in `lib/coach/tools.ts`.

### Why ask is built the way it is

The obvious design — hand the model SQL — is the one this repo rejects. Six traps in
this data have each already produced a wrong answer here at least once: today is a
Partial Day, a gap is not a zero, Apple shadow-copies every Liftosaur session so its
workout view roughly doubles training volume, `energy_balance` overstates the deficit
by ~2.6x, a single weigh-in is noise, and `reps: 0` is a set that was attempted and
failed rather than one that is missing.

Given SQL, a model walks into all six. Told about them in a prompt, it gets them
right *most* of the time — which is the worse failure mode, because rare wrong
answers get trusted. So they are foreclosed by the shape of the tools instead:
windowed queries end `AND observed_on < today_local()`, gaps stay absent rows, no
tool reaches Apple's workout view at all, and `energy_balance` cannot be fetched
without its reality check in the same payload. The prompt still describes the traps;
it is not what is holding them.

It is read-only — there is no write tool to disable. Program changes stay in
Liftosaur and macro targets stay MacroFactor's call.
[docs/adr/0006](docs/adr/0006-typed-tools-not-sql-for-the-chat.md) has the reasoning.

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

That matters because HAE keeps revising a day after that day has closed, and the
old SQLite schema overwrote silently. Of the observations this pipeline has
watched land live — a four-day sample, so read it as directional — **69% had their
value change after the day they describe had already closed** (measured 2026-08-12).
Two bugs hid in that overwriting: a five-day stretch where an iOS update dropped
HealthKit permission for weight while every sync reported success, and a midday
export that made a 1241 kcal day look like 333.
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
| `npm run dev` | run the app locally |
| `npm run q "SQL"` | query the database |
| `npm test` | 192 unit tests — parsers, signals, auth, chat tooling |
| `npm run typecheck` | tsc |
| `npm run migrate` | apply `db/migrations/*.sql` |
| `npm run backfill` | load `exports/*.json` |
| `npm run sync-liftosaur` | pull lifting history |
| `npm run scan-exports` | parse exports without touching a database |
| `npm run diff-oracle` | compare against the retired SQLite database |

## Repo

- `db/migrations/` — schema. Read `0001` first; the comments explain the choices.
- `lib/` — parsers and write path, shared by the API and the scripts so they cannot drift.
- `app/` — the Next.js app: pages, and the API routes under `app/api/`.
- `lib/signals/` — the coaching rules. Pure functions, fixture-tested.
- `lib/coach/` — the `/ask` chat's tools, prompt and auth guard. See `docs/adr/0006`.
- `docs/adr/` — six decisions that were hard to reverse.
- `docs/migration-log.md` — what went wrong on the way here, kept for a writeup.

Health data, secrets, exports and `node_modules` are gitignored. Keep it that way.

## License

Dual-licensed, deliberately:

- **Code** — MIT. See `LICENSE`. Applies to everything under `app/`, `lib/`, `scripts/`,
  `db/` and `tests/`.
- **Prose** — CC BY 4.0. See `LICENSE-docs`. Applies to the Markdown: `docs/` (including
  the migration log and the ADRs), this README, `CLAUDE.md`, `CONTEXT.md`, and the
  strategy and tactics notes. Quote and adapt it with credit; please link rather than
  repost in full.

Where MIT's boilerplate refers to "associated documentation files", the split above
governs: the prose is CC BY 4.0, not MIT.
