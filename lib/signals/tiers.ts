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
