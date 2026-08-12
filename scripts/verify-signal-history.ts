/**
 * Replay the signal rules over the whole history, so claims about how often
 * they have ever fired are reproducible instead of remembered.
 *
 * This exists because docs/migration-log.md asserted "the overreaching rule's
 * `act` has never fired in 2,402 days" and "zero T1/T2 stalls, ever" on the
 * strength of a one-off script that was never committed. Those numbers then
 * got quoted in a writeup with nothing to check them against, which is exactly
 * the failure the log spends several sections complaining about.
 *
 * Runs the REAL functions from lib/signals rather than reimplementing their
 * logic in SQL -- the whole point is to avoid hand-deriving a rule and getting
 * subtly the wrong answer.
 *
 *   npm run verify-signals
 */
import { getPool } from '../lib/db.js'
import { loadRecoveryDays } from '../lib/queries.js'
import { overreaching } from '../lib/signals/recovery.js'
import { stalling } from '../lib/signals/lifting.js'
import type { LiftingSetRow, SignalStatus } from '../lib/signals/types.js'

/** Same rolling window loadSignals() uses for the recovery rule. */
const WINDOW_DAYS = 63

async function main() {
  const pool = getPool()

  // ---- overreaching, simulated day by day -------------------------------
  // loadRecoveryDays excludes today and takes a lookback in days; 20 years is
  // comfortably the whole history.
  const all = await loadRecoveryDays(365 * 20)
  const days = all.map((d) => ({
    observedOn: d.observedOn,
    restingHr: d.restingHr,
    hrvMs: d.hrvMs,
  }))

  const tally: Record<SignalStatus, number> = { ok: 0, watch: 0, act: 0, unknown: 0 }
  const fired: { on: string; status: SignalStatus; headline: string }[] = []

  for (let i = 0; i < days.length; i++) {
    // The window a person standing on day i would actually have had.
    const start = Math.max(0, i - WINDOW_DAYS + 1)
    const sig = overreaching(days.slice(start, i + 1))
    tally[sig.status]++
    if (sig.status === 'act' || sig.status === 'watch') {
      fired.push({ on: days[i]!.observedOn, status: sig.status, headline: sig.headline })
    }
  }

  console.log(`\noverreaching() over ${days.length} days of recovery history`)
  console.log(`  ok=${tally.ok}  watch=${tally.watch}  act=${tally.act}  unknown=${tally.unknown}`)
  if (fired.length) {
    const first = fired[0]!.on
    const last = fired[fired.length - 1]!.on
    console.log(`  non-ok verdicts span ${first} .. ${last}`)
    for (const f of fired) console.log(`    ${f.on}  ${f.status.padEnd(5)}  ${f.headline}`)
  }

  // ---- stalling, over the whole lifting history -------------------------
  // Tier lives in the Liftosaur program text, not the database, so this runs
  // UNFILTERED on purpose: if every raw hit is a T3 accessory, then the
  // tier-filtered answer is zero without needing the program text to prove it.
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT s.performed_on, s.record_id, s.exercise, s.set_index,
            s.reps, s.weight_lbs, s.target_reps, s.is_amrap
       FROM lifting_sets s ORDER BY s.performed_on, s.record_id, s.set_index`,
  )
  const sets: LiftingSetRow[] = rows.map((r) => ({
    performedOn: String(r['performed_on'] instanceof Date
      ? (r['performed_on'] as Date).toISOString().slice(0, 10)
      : r['performed_on']),
    recordId: Number(r['record_id']),
    exercise: String(r['exercise']),
    setIndex: Number(r['set_index']),
    reps: Number(r['reps']),
    weightLbs: r['weight_lbs'] === null ? null : Number(r['weight_lbs']),
    targetReps: r['target_reps'] === null ? null : Number(r['target_reps']),
    isAmrap: r['is_amrap'] === null ? null : Boolean(r['is_amrap']),
  }))

  const sessions = new Set(sets.map((s) => s.recordId)).size
  const raw = stalling(sets)
  console.log(`\nstalling() over ${sets.length} sets across ${sessions} sessions`)
  console.log(`  unfiltered (no tier map): ${raw.status}`)
  console.log(`  ${raw.headline}`)
  if (raw.detail) console.log(`  ${raw.detail}`)

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
