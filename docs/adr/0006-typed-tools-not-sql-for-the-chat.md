# 0006 — The chat gets typed tools, not SQL, and the tools enforce the traps

Accepted, 2026-08-11. Implements #8.

## Context

The `/coach` skill answers coaching questions by writing SQL. That is most of
where its usefulness comes from: 81 metrics, arbitrary joins, whatever question
gets asked. Reproducing that inside the web app was the obvious design, and it is
the one we rejected.

The reason is that this dataset has a documented set of traps, every one of which
has already produced a wrong answer in this project at least once:

- today is a Partial Day and averaging it understates intake (a midday export
  once made a real 1241 kcal / 175g day look like 333 kcal / 23g);
- a gap is not a zero, so an unlogged day is not a fast;
- `health_workouts` shadow-copies every Liftosaur session, so counting it roughly
  doubles training volume;
- `energy_balance` overstates the deficit by ~2.6x because it subtracts one
  estimate from another;
- a single weigh-in is noise;
- `reps = 0` is a failed set, not missing data.

Handed SQL, a model will hit all six. Told about them in a prompt, it will hit
them less often — which is a worse failure mode than hitting them always, because
the wrong answers become rare enough to trust.

## Decision

The chat gets a fixed set of hand-written, typed tools (`lib/coach/tools.ts`), and
**each trap is foreclosed by the shape of a tool rather than by prompt text**:

| Trap | Structural foreclosure |
|---|---|
| Partial Day | every windowed tool's SQL ends `AND observed_on < today_local()`. Today is unreachable except through `get_today`, whose payload is `{partial: true, caveat: ...}`. |
| Gaps as zeros | missing days are absent rows. Tools return `daysLogged` next to `days` so coverage is a number the model is handed, not one it must notice. |
| Double-counted training | no tool reads `health_workouts`. There is no argument to get at it. |
| Overstated deficit | `get_energy_balance` returns `energy_balance` **and** `energy_reality_check` in one payload with the caveat inline. Fetching one without the other is not an available operation. |
| Weigh-in noise | there is no tool that returns a bare weight reading. `get_weight_trend` returns regressions plus the outliers it excluded. |
| Failed sets | `groupSets` counts `reps: 0` into a `failedSets` field per group, and the tool description says `FAILED` in capitals. |

Two supporting decisions fall out of it:

- **No SQL from the model, and no allowlisted-view query builder either.** A view
  allowlist would have made the allowlist the security boundary and still allowed
  `SELECT avg(calories) FROM nutrition` including today.
- **Read-only.** There is no write tool. Program and 1RM changes go through
  Liftosaur; macro targets are MacroFactor's call, recorded at `/settings`.

## Consequences

**What we lose.** Genuinely open-ended questions the tool set does not anticipate
cannot be answered — a question needing a join nobody wrote is answered with what
the tools can reach, or not at all. Adding reach means writing a tool and
deploying. `get_metric_series` plus `list_metrics` recovers most of it (all 81
metrics, generically), which is why the loss is tolerable rather than crippling.

**What we gain.** Every query the chat can run is in one reviewed file, and the
correctness properties hold whether or not the prompt is right, whether or not the
model is having a good day, and whether or not someone later trims the system
prompt to save tokens. The prompt still describes the traps — belt and braces —
but it is not what is holding them.

**Reversibility.** Moderate. Adding a SQL tool later is a small change and the
tools would remain useful alongside it. What would be hard to undo is the habit:
once the model has SQL, every tool description that currently carries a caveat
becomes optional, and the caveats are the actual asset.

## What this is not

It is not a claim that the answers are correct. It is a claim about which wrong
answers are impossible. The rest is verified by the trap probes in
`docs/superpowers/specs/2026-08-11-coach-chat-design.md`, which are run by hand
against real data — and on the first run all nine passed, including three the
prompt does not explicitly cover.
