# Nutrition & IF Strategy — Context for Claude Code

Companion to `training-strategy.md` (which covers the GZCLP program setup). This one covers
the MacroFactor / intermittent fasting side, decided July 2026. Feed this into
`fitness.db`-aware conversations (`/coach`) so nutrition questions have the same
"don't re-litigate the settled stuff" grounding the lifting side already has.

---

## Who / situation

- Cutting, fairly aggressive: -1.18 lb/wk goal rate off an estimated ~2247 kcal
  expenditure → 1660 kcal/day target.
- Starting bodyweight ~274-278 lb, ~36% body fat (see Data sources below).
- **On a GLP-1.** Several months in, appetite significantly suppressed. This is the
  single most important modifier on everything else in this doc — see Guardrails.
- Been inconsistent with logging for a while; only in the last ~week getting back
  to actually logging in MacroFactor daily. The recent apparent weight-loss
  plateau is more likely an under-logging artifact than a true metabolic
  plateau — see Plateau note below.
- Lifting GZCLP (per `training-strategy.md`), training days vary — usually evening (6-7pm),
  occasionally morning, schedule isn't fixed.

## Decisions already made (do not re-litigate)

| Setting | Value | Why |
|---|---|---|
| Fasting protocol | 16:8 style, feeding window **10am–8pm** | Loosened from a stricter 16:8 specifically because of the GLP-1 appetite suppression — see Guardrails. Window is a habit/adherence tool, not a metabolic lever; don't tighten it back up to chase a "purer" fasting number. |
| MacroFactor diet setting | **Balanced** (was Low-carb) | Low-carb was quietly starving carbs (down to 50g) to protect an already-generous fat allocation (73g), which is bad fuel allocation for someone lifting real training volume. Balanced fixed this without touching protein. |
| MacroFactor protein preference | **High** | Verified against actual body comp data (see below) — lands at ~198g, which is right at the top of the 1-1.1g/lb-lean-mass range appropriate for a cut this size while on a GLP-1. **Don't lower this.** If it drifts, the fix is logistics (shakes, denser meals), not a lower target. |
| Current macro split (as of July 2026) | 1660 kcal / 198g protein / 55g fat / 91g carbs | This is the reference point. Re-derive lean-mass math (below) if bodyweight or body fat % shifts meaningfully before assuming the target needs to change. |

## Data sources — how this actually flows

- MacroFactor **is** connected to Apple Health and pulls both `weight_lbs` and
  `body_fat_percentage` automatically (synced entries show the Health heart icon;
  manual entries show the MacroFactor logo). Do not assume this needs manual
  entry — it's already live. `body_metrics` in `fitness.db` should already be
  getting this via the HAE export pipeline.
- Protein target math, if it ever needs re-checking by hand:
  `lean_mass_lb = weight_lbs * (1 - body_fat_percentage)`, then target
  **1.0–1.1 g protein per lb lean mass** as the range to stay inside on this cut.
  At 275.9 lb / 36.3% BF that's ~175.7 lb lean → 176-193g range; the app's 198g
  sits right at the top of it, which is appropriate given the GLP-1 lean-mass-loss
  risk (see Guardrails) — don't second-guess it downward.

## Guardrails

- **GLP-1 + deficit + resistance training is a specific risk combo**: a meaningful
  share of weight lost on GLP-1s can be lean mass if protein and training aren't
  both prioritized. Protein target and lifting consistency are the two levers
  protecting against this — treat the protein number as closer to non-negotiable
  than the other macros.
- **GLP-1 appetite suppression + an 8-10hr eating window compress food intake from
  two directions at once.** If protein starts consistently missing target, the
  fix is a wider window (12-14hr) or easier-to-eat-in-volume food (shakes, dense
  meals) — not lowering the protein target itself.
- **Fasting window has no fat-loss magic.** It's an adherence/habit-forming tool
  given a history of inconsistent logging, nothing more. Resist any temptation
  (from either of us) to treat a tighter window as "more optimal" — 10-11 hours
  vs. 8 hours makes ~no difference to outcomes, and does make protein easier to
  hit.
- **Diet-setting extremes (low-carb, keto, low-fat) aren't specially better for
  fat loss at matched calories/protein** — this is fairly well-settled in the
  literature. Balanced is the default unless a *non-fat-loss* reason shows up
  (a real, stated food preference — not "I heard low-carb was better").

## Plateau note (don't overreact to this)

A perceived plateau over the last couple months coincides with a logging gap, not
necessarily a true metabolic one. MacroFactor's expenditure algorithm was likely
running on sparse data during that period, so the current 2247 kcal estimate may
be stale. **Give 2-3 weeks of consistent logging under the current settings
before concluding anything about a real plateau or adjusting the deficit size.**
If `sync_log` / `nutrition` show a solid unbroken logging streak and weight still
isn't trending down after that window, that's the point to revisit deficit size —
not before.

## Open / to monitor

- Whether 198g protein is actually hitting most days once real logging data comes
  in (vs. being a number that looks fine on paper but gets missed due to appetite
  suppression).
- Whether the 10am-8pm window needs to widen further if protein is a struggle.
- Re-run the lean-mass math periodically as body fat % changes — the app should
  handle this automatically via the Health sync, but worth a manual sanity check
  every few weeks against `body_metrics`.