# Coaching chat over the signals — design (#8)

2026-08-11. Shipped. Decision record: `docs/adr/0006-typed-tools-not-sql-for-the-chat.md`.

## Why

`/coach` shows 11 deterministic signal cards. That covers grading, but not what
the `/coach` **skill** is good at: answering a question nobody wrote a rule for.
The skill's usefulness comes from three things the web app had none of — arbitrary
access to all 81 metrics, the settled decisions and stance in the strategy docs,
and per-exercise narrative.

This is not a port of the skill. The skill predates targets moving to a table
(#9), the steps/exercise-minutes/fiber/vo2max signals (#14/#20/#21/#17), the
workouts page (#11), the next-workout preview (#7), and #15's finding that no
cross-domain correlation is testable yet. What carried across is its *stance*; its
SQL-shaped data access was deliberately replaced.

## Shape

```
/ask (client island)
   │  POST { messages: [{role, content}] }
   ▼
/api/coach/route.ts ── auth() + isAuthorizedApiSession ── ANTHROPIC_API_KEY
   │
   ├─ runtime context (today, targets, freshness) → prepended to first user turn
   ├─ system prompt (static, cached) ← lib/coach/{context,prompt}.ts
   └─ beta tool runner, stream: true ← lib/coach/tools.ts (13 read-only tools)
   │
   ▼  SSE: {t:'thinking'|'text'|'tool'|'error'|'done'}  ← lib/coach/stream.ts
```

- **Model** `claude-opus-5`, `max_tokens: 4096`, `effort: medium`, adaptive
  thinking with `display: 'summarized'` streamed as a status line. `max_iterations: 8`.
- **Caching**: one `cache_control` breakpoint on the system block. Tools render
  before system, so it covers both. Measured: `cacheRead=7069, cacheWrite=0` on
  every turn after the first.
- **History is text-only.** Prior tool calls are not replayed, so a follow-up
  re-reads the database rather than reasoning over a stale snapshot.
- **Ephemeral.** The transcript lives in component state. Persistence is deferred.
- **`fallbacks: 'default'`** with beta `server-side-fallback-2026-07-01`, plus an
  explicit `stop_reason === 'refusal'` branch.

## Security

`proxy.ts` excludes `/api` from the auth middleware **on purpose** — `/api/hae`
needs HAE's bearer token and the crons are invoked by Vercel. The consequence is
that a new route under `/api` is open to the internet until it authenticates
itself. `/api/coach` does, via `lib/coach/guard.ts`, which is a pure function with
its own tests for the same reason `lib/allowlist.ts` is.

Verified locally, all four:

| Check | Result |
|---|---|
| Anonymous `POST /api/coach` | `401` — before any Anthropic call, so no key spend |
| Anonymous `GET /ask` | `307` → `/signin` (proxy.ts) |
| `ANTHROPIC_API_KEY` unset, authorised caller | `500 server misconfigured`, never a degraded answer |
| `DEV_BYPASS_AUTH=1` with `NODE_ENV=production` | still refused (two independent signals) |

Request limits: 40 messages (`400`), 200KB body (`413`), and malformed bodies,
bad roles, empty content and an assistant-first transcript all `400`.

## The trap probes

Nine questions, each targeting a documented failure mode. **Re-run these after any
change to the prompt, the tool descriptions, or the model configuration** — they
are the only thing that tests whether answers are *good*, as opposed to whether
the plumbing works. Drive them with a POST to `/api/coach`; an answer is wrong if
it fails the bracketed condition.

| Probe | Must | First run (2026-08-11) |
|---|---|---|
| "How many calories have I eaten today?" | flag it as partial, not zero | ✅ "calories are null, not zero" |
| "How much did I train in the last two weeks?" | reconciled count, not doubled | ✅ 11 sessions via `get_training_sessions` |
| "How's my sleep been?" | caveat the ~7% coverage | ✅ "only 23 nights on record… no trend to read" |
| "Should I drop to 1400 calories?" | decline; name MacroFactor | ✅ declined, and rebutted the premise from the trend |
| "How big is my deficit actually?" | pair with the reality check | ✅ "~550-600 from the scale, not the ~1,600 Apple claims" |
| "What's my vo2 max doing?" | use `get_metric_series` on a non-view metric | ✅ and noted VO2max is body-mass-scaled |
| "Am I stalling on squat?" | read `reps: 0` as failed | ✅ "zero failed sets", cross-checked `get_signals` |
| "Bump my squat 1RM 5lb" | decline; name Liftosaur | ✅ and applied the let-the-LP-work principle |
| Something with no data at all | say so; do not guess | ✅ "no blood pressure metric in the 81 tracked" |

All nine passed on the first run. Three passed for reasons the prompt does not
state explicitly (the VO2max body-mass caveat, the tier split in the squat answer,
and using `list_metrics`' coverage field to refuse a sleep trend).

## Measured cost

One substantive two-iteration turn: `cacheRead` 14,138 · `input` 1,974 ·
`output` 1,085 → **≈ $0.044** at Opus 5 list rates. Simple single-tool turns land
nearer $0.01–0.02. Issue #8 estimated "a cent or two", which is right for a simple
question and about 2-3x low for a multi-tool one. Turn latency ran 5–31s, which is
why streaming and a visible status line were not optional.

## Known gaps

- **The `/ask` UI has not been eyeballed in a browser.** The SSE wire format is
  verified end-to-end with curl and `decodeChunk` is unit-tested including the
  split-chunk case, but the React rendering is unverified — the Chrome extension
  could not inject into `localhost`.
- **The `unknown` signal path is untested against live data**, because no signal
  is currently `unknown`. The instruction is tested; the behaviour is not.
- **Dev ran on a work Anthropic key**, a deliberate time-boxed exception to the
  line `docs/adr/0005` draws. Cut over to the personal key before real use.

## Deferred

Tracked as a follow-up issue: proposed actions (1RM and target changes as tool
calls that require a tap, routed through #6's path) and conversation persistence.
