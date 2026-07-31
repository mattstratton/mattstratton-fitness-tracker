// The write path. Shared by scripts/backfill.ts and the push endpoint, so a fix
// to one is a fix to both -- the parser already makes that promise and it would
// be hollow if the two wrote rows differently.
import type pg from 'pg'

import type { HealthWorkout, Observation } from './domain.ts'

const BATCH = 2000

/**
 * Append Reports. Never updates: `observations` is an append-only log and has no
 * unique constraint, precisely so a Restatement can coexist with what it revises.
 */
export async function writeObservations(
  client: pg.Pool | pg.PoolClient,
  rows: Observation[],
): Promise<number> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const values: unknown[] = []
    const tuples = chunk.map((o, n) => {
      values.push(o.observedOn, o.metric, o.value, o.unit, o.source, o.recordedBy, o.reportedAt)
      const b = n * 7
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7})`
    })
    await client.query(
      `INSERT INTO observations
         (observed_on, metric, value, unit, source, recorded_by, reported_at)
       VALUES ${tuples.join(',')}`,
      values,
    )
  }
  return rows.length
}

/**
 * Upsert workouts on their natural key. Unlike observations these DO have one,
 * which is also what makes the same session exported under two timezone offsets
 * collapse to a single row without any helper.
 */
export async function writeWorkouts(
  client: pg.Pool | pg.PoolClient,
  rows: HealthWorkout[],
): Promise<number> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH)
    const values: unknown[] = []
    const tuples = chunk.map((w, n) => {
      values.push(w.startedAt, w.type, w.endedAt, w.durationMin, w.energyKcal)
      const b = n * 5
      return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5})`
    })
    await client.query(
      `INSERT INTO health_workouts (started_at, type, ended_at, duration_min, energy_kcal)
       VALUES ${tuples.join(',')}
       ON CONFLICT (started_at, type) DO UPDATE SET
         ended_at = excluded.ended_at,
         duration_min = excluded.duration_min,
         energy_kcal = excluded.energy_kcal`,
      values,
    )
  }
  return rows.length
}
