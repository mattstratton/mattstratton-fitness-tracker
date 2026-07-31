# Nutrition Tactics — living notes

Unlike `nutrition-strategy.md` (settled decisions, don't re-litigate), this file is
meant to change. It's a running scratchpad of what actually helps hit the 198g
protein target given GLP-1 appetite suppression — food options, prep tips, and
patterns noticed from the MacroFactor logs. Add to it, edit it, delete stuff that
stops being true. Nothing here is locked.

## High protein-density options (low effort / low appetite demand)

Good for days appetite is trashed but protein still needs to happen:

- **Fairlife (ultra-filtered) milk** — ~23g protein/bottle, drinks like regular milk
- **Whey/casein shake** — 30-33g protein per shake, ~160-230 kcal, near-zero chewing effort
- **Greek yogurt (nonfat, plain)** — ~20g/cup
- **Cottage cheese** — similar density to Greek yogurt
- **Liquid egg whites** — near-zero calories, all protein, scrambles into anything
- **Canned tuna/chicken** — 20-43g protein, shelf-stable, no cooking required
- **Protein bars** (e.g. Pure Protein Chocolate Deluxe) — ~21g/180 kcal
- **Landjaeger sticks** — surprisingly dense, ~27g protein for 6 sticks

## Prep tips

### Canned tuna (fixing the "dry" texture complaint)

- Buy packed in **water**, not oil — leaner, more protein-dense per can.
- Swap mayo for **plain nonfat Greek yogurt** as the binder — same creaminess,
  adds protein instead of just fat.
- Combos that work:
  - **Everything bagel:** Greek yogurt + lemon juice + everything-bagel seasoning
  - **Dijon + pickle:** mustard + diced pickle/relish + lemon
  - **Mediterranean:** olive oil (small amount) + lemon + capers + diced red onion
  - **Buffalo:** hot sauce + a little yogurt to mellow it
  - **Avocado mash-in:** quarter avocado mashed in — real moisture, ~80 kcal cost
- Let the mixed tuna sit 5-10 min before eating — lets the binder actually absorb
  into the flakes instead of just coating them, which is most of the "dry" fix.

## Patterns observed from logs (update as more data comes in)

### 7/14–7/30, 17 complete days of unbroken logging

The first stretch long enough to mean anything (the strategy doc asks for 2-3 weeks
before drawing conclusions — this clears it).

| | Actual | Target |
|---|---|---|
| Calories | **1656** | 1660 |
| Protein | **143g** | 198g |

Calorie adherence is essentially perfect. Protein is 55g/day short — 3 of 17 days hit
198g, 9 of 17 came in under 150g.

**The useful reframe: this is not an "eat more" problem, it's a swap problem.** Hitting
the calorie number dead-on while missing protein by 55g means roughly 55g worth of
protein calories are arriving as carbs and fat instead. At 1656 kcal, 198g protein is
48% of intake — which is exactly what the MacroFactor split already prescribes
(198p/55f/91c ≈ 1651 kcal). The target is internally consistent; it just demands
genuinely protein-dense choices rather than more food. Two shakes swapped in for
equivalent calories closes most of the gap.

Lifting days average **148g** protein vs **134g** on rest days, so the instinct to eat
more around training is already there — both numbers are just short.

Good example day: **7/30 — 1241 kcal / 175g protein.** Proof the density is achievable
without extra calories.

### From the 7/17-7/23 MacroFactor export:

- **Good protein days (7/18: 214g, 7/20: 149g, 7/22: 151g)** all had either 2
  shakes, or one big protein-anchor item (a large chicken serving, canned tuna),
  spread across the day.
- **Bad protein days (7/19: 60g, 7/21: 55g)** each had exactly **one** deliberate
  protein source (a single morning shake) — everything else logged that day was
  low-protein convenience/fast food (pretzel, ice cream, fries, a Whopper Jr,
  a McDonald's snack wrap, a sushi platter that's mostly rice).
- On 7/21, first food didn't land until 3:42pm, and the day's only real protein
  hit (a shake) landed at 9:53pm — already past the nominal 8pm window cutoff.
  The window is already slipping on exactly the days appetite is worst.

## Ideas to try

- On days appetite is visibly bad early, **bank a second shake before noon**
  rather than hoping a later meal covers it — good days aren't about willpower,
  they're about having 2 protein anchors instead of 1.
- Keep tuna, landjaeger, and a protein bar on hand as zero-cook backstops for
  exactly the "not hungry but still need protein" moment.
- Consider whether the 8pm end of the feeding window needs to move later,
  given it's already being missed on the two worst-protein days observed so far.

## Reading the data — a trap worth remembering

Never read a single implausibly low day as real without checking whether it's the
newest date in `nutrition`. Today's row is always a partial day, because HAE exports
whatever has been logged at the moment it runs. On 7/31 this made 7/30 look like a
333 kcal / 23g-protein fast that Matty deadlifted through; the real day was 1241 kcal
and 175g, one of his better ones. `data_freshness` labels the partial day explicitly.
