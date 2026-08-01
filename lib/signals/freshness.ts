import type { FreshnessRow, Signal } from './types.js'

/**
 * Is the data current enough to coach on?
 *
 * The distinction that matters, and the reason this table exists at all: an
 * automatic source is written by the Watch without anyone doing anything, so a
 * gap is always a broken pipeline. A user-driven source needs Matty to log food
 * or stand on a scale, so a gap is usually just travel. Treating them the same
 * either cries wolf or misses the real thing — and in July 2026 the real thing
 * was five days of no weight while every sync reported success.
 */
export function freshness(rows: FreshnessRow[]): Signal {
  const base = { id: 'freshness', title: 'Data' } as const
  const bad = (r: FreshnessRow) => r.status === 'stale' || r.status === 'missing'
  const broken = rows.filter((r) => r.automatic && bad(r))
  const warnings = rows.filter((r) => !r.automatic && bad(r))

  if (broken.length > 0) {
    return {
      ...base,
      status: 'act',
      headline: `Pipeline broken: ${broken.map((r) => r.label).join(', ')}`,
      detail: `${broken
        .map((r) => `${r.label} last saw data ${r.ageDays ?? '?'} days ago (expected within ${r.maxAgeDays})`)
        .join('; ')}. These arrive from the Watch without you doing anything, so a gap means something is actually broken. Everything below is coached on stale data.`,
    }
  }

  if (warnings.length > 0) {
    return {
      ...base,
      status: 'watch',
      headline: `Behind: ${warnings.map((r) => r.label).join(', ')}`,
      detail: 'These need you to log or weigh in, so a gap may just be travel rather than a fault.',
    }
  }

  return { ...base, status: 'ok', headline: 'All sources current' }
}
