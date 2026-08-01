/**
 * Which tier each exercise is trained at, parsed from Liftoscript.
 *
 * Tier is not in the database — the old schema had a `tier` column that was NULL
 * in all 2,416 rows and it was dropped. It lives in the program instead, which
 * is the better home: it is a property of how you are training an exercise this
 * cycle, not of the set.
 *
 * It matters because T3 is *supposed* to sit at one weight. GZCLP progresses a
 * T3 only when the AMRAP clears 18 reps, so two sessions at the same load is the
 * program working correctly. Without this, the stall rule reports "Triceps
 * Pushdown stalled" every single week.
 *
 * Pure function over program text, so it stays testable without the network.
 *
 * DURABILITY: this is GZCL-family specific and it is deliberately a HINT, not a
 * dependency. A program without t1:/t2:/t3: labels -- 5/3/1, PPL, anything --
 * parses to an empty map, and every consumer treats that as "no information"
 * rather than an error. Verified against a real 5/3/1 program: zero entries, and
 * `stalling` reverts to judging every exercise, which is what it did before
 * tiers existed. Changing programs degrades the T3 suppression; it breaks
 * nothing.
 *
 * The program-agnostic replacement is to ask Liftosaur, via `run_playground`,
 * what weight it prescribes next: a stall is then "the program wants more weight
 * and history says it hasn't moved", which holds for any progression scheme.
 * That is Phase 4 work and it retires this file.
 */
export type Tier = 't1' | 't2' | 't3'

// e.g. `t1: Squat / ...t1_modified / 197.5lb / warmup: ...`
// Template definitions (`t3_modified / used: none / ...`) have no colon and are
// skipped, which matters because they'd otherwise register as exercises.
const LINE = /^(t[123]):\s*([^/\n]+?)\s*(?:\/|$)/gm

export function parseTiers(programText: string): Map<string, Tier> {
  const tiers = new Map<string, Tier>()
  for (const m of programText.matchAll(LINE)) {
    const tier = m[1] as Tier
    const exercise = m[2]?.trim()
    if (!exercise) continue
    // An exercise can appear at two tiers in one program -- Squat is T1 on day 1
    // and T2 on day 3. Keep the most demanding, since that's the one whose
    // stalling actually matters.
    const existing = tiers.get(exercise)
    if (existing === undefined || tier < existing) tiers.set(exercise, tier)
  }
  return tiers
}
