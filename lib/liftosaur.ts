// Liftosaur history sync. Shared by the CLI script and the Vercel cron.
//
// The API returns the FULL history on every call, paginated. The old Python
// therefore DELETE-INSERTed all 2.5 years on every run, which against a
// compressed hypertable would mean decompressing every chunk, hourly, forever.
// Instead each record's text is hashed and only changed records are rewritten.
import type pg from 'pg'

import { parseRecord } from './parse/liftohistory.ts'
import type { LiftosaurRecord } from './parse/liftohistory.ts'

const API_BASE = 'https://www.liftosaur.com/api/v1'
const PAGE_SIZE = 200
// Liftosaur history is ~200 records; this is a runaway guard, not a limit.
const MAX_PAGES = 100

export type SyncResult = {
  recordsSeen: number
  recordsChanged: number
  setsWritten: number
  recordsPruned: number
}

/** Every history record, following the cursor to the end. */
export async function fetchAllRecords(apiKey: string): Promise<LiftosaurRecord[]> {
  const out: LiftosaurRecord[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (cursor !== undefined) params.set('cursor', cursor)
    const res = await fetch(`${API_BASE}/history?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) {
      throw new Error(`Liftosaur API ${res.status}: ${(await res.text()).slice(0, 200)}`)
    }
    const body = (await res.json()) as Record<string, unknown>
    const data = (body['data'] ?? body) as Record<string, unknown>
    const records = Array.isArray(data['records']) ? data['records'] : []
    for (const r of records) {
      if (r && typeof r === 'object' && 'id' in r && 'text' in r) out.push(r as LiftosaurRecord)
    }
    if (!data['hasMore']) return out
    cursor = String(data['nextCursor'])
  }
  throw new Error(`Liftosaur pagination exceeded ${MAX_PAGES} pages; refusing to loop`)
}

export async function syncLiftosaur(pool: pg.Pool, apiKey: string): Promise<SyncResult> {
  const records = await fetchAllRecords(apiKey)

  const existing = new Map<number, string>(
    (
      await pool.query<{ record_id: string; text_hash: string }>(
        'SELECT record_id, text_hash FROM lifting_records',
      )
    ).rows.map((r) => [Number(r.record_id), r.text_hash]),
  )

  let recordsChanged = 0
  let setsWritten = 0
  const seen = new Set<number>()

  for (const raw of records) {
    const { record, sets } = parseRecord(raw)
    seen.add(record.recordId)
    // The whole point: an unchanged record touches nothing, so historical
    // chunks stay compressed and untouched run after run.
    if (existing.get(record.recordId) === record.textHash) continue

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO lifting_records
           (record_id, performed_on, started_at, program, day_name, text_hash, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (record_id) DO UPDATE SET
           performed_on = excluded.performed_on, started_at = excluded.started_at,
           program = excluded.program, day_name = excluded.day_name,
           text_hash = excluded.text_hash, synced_at = now()`,
        [record.recordId, record.performedOn, record.startedAt, record.program,
         record.dayName, record.textHash],
      )
      // Sets are replaced wholesale for a changed record: an edit in Liftosaur
      // can remove a set, which an upsert alone would leave behind as a ghost.
      await client.query('DELETE FROM lifting_sets WHERE record_id = $1', [record.recordId])
      if (sets.length > 0) {
        const values: unknown[] = []
        const tuples = sets.map((s, n) => {
          values.push(s.performedOn, s.recordId, s.exercise, s.setIndex, s.reps,
                      s.weightLbs, s.targetReps, s.isAmrap)
          const b = n * 8
          return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`
        })
        await client.query(
          `INSERT INTO lifting_sets
             (performed_on, record_id, exercise, set_index, reps, weight_lbs, target_reps, is_amrap)
           VALUES ${tuples.join(',')}`,
          values,
        )
      }
      await client.query('COMMIT')
      recordsChanged++
      setsWritten += sets.length
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  // A session deleted in Liftosaur should disappear here too. Safe only because
  // we just fetched the COMPLETE history -- fetchAllRecords throws rather than
  // returning a partial list, so reaching this line means `seen` is authoritative.
  let recordsPruned = 0
  if (seen.size > 0) {
    const ids = [...seen]
    const pruned = await pool.query(
      'DELETE FROM lifting_records WHERE NOT (record_id = ANY($1::bigint[]))', [ids],
    )
    await pool.query(
      'DELETE FROM lifting_sets WHERE NOT (record_id = ANY($1::bigint[]))', [ids],
    )
    recordsPruned = pruned.rowCount ?? 0
  }

  return { recordsSeen: records.length, recordsChanged, setsWritten, recordsPruned }
}

/** Record what a run found, not merely that it ran. See db/migrations/0003. */
export async function logIngestRun(
  pool: pg.Pool,
  source: 'hae' | 'liftosaur',
  startedAt: Date,
  status: 'ok' | 'error',
  detail: unknown,
  rowsWritten = 0,
  metricsSeen = 0,
): Promise<void> {
  await pool.query(
    `INSERT INTO ingest_runs
       (started_at, source, finished_at, status, metrics_seen, rows_written, detail)
     VALUES ($1,$2, now(), $3,$4,$5,$6)`,
    [startedAt, source, status, metricsSeen, rowsWritten, JSON.stringify(detail)],
  )
}
