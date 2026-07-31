import { existsSync } from 'node:fs'
import pg from 'pg'

/**
 * Load .env if present. Node has this built in since 21.7, so no dotenv.
 * Real environment variables win, which is what Vercel supplies in production.
 */
export function loadEnv(path = '.env'): void {
  if (existsSync(path)) {
    try {
      process.loadEnvFile(path)
    } catch {
      // Absent or unreadable is fine -- production has real env vars.
    }
  }
}

function connectionString(): string {
  loadEnv()
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('DATABASE_URL is not set (put it in .env or the environment)')
  return url
}

// TLS: Tiger Cloud issues a temporary self-signed certificate when a service is
// first created, then replaces it with a publicly-signed one within minutes. If
// a brand-new service fails verification, WAIT rather than reaching for
// rejectUnauthorized:false -- that would punch a permanent hole in a connection
// carrying personal health data to work around a condition that resolves itself.
function sslFor(url: string): pg.PoolConfig['ssl'] {
  if (url.includes('localhost') || url.includes('127.0.0.1')) return false
  return { rejectUnauthorized: true }
}

/** A pool for scripts and one-shot jobs, where a few connections are free. */
export function makePool(): pg.Pool {
  const url = connectionString()
  return new pg.Pool({ connectionString: url, ssl: sslFor(url), max: 4 })
}

let serverlessPool: pg.Pool | undefined

/**
 * A pool sized for a serverless function.
 *
 * Module-scoped so warm invocations reuse it, and capped at ONE connection:
 * Vercel scales horizontally, so every concurrent instance opens its own pool.
 * This service has no connection pooler in front of it (only a direct endpoint)
 * and runs on 0.5 CPU, so a generous per-instance pool multiplied by instance
 * count is how you exhaust the server. Traffic here is one HAE push and two
 * crons a day, so one connection each is ample.
 */
export function getPool(): pg.Pool {
  if (serverlessPool === undefined) {
    const url = connectionString()
    serverlessPool = new pg.Pool({
      connectionString: url,
      ssl: sslFor(url),
      max: 1,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    })
    // A pool error on an idle client must not take the process down.
    serverlessPool.on('error', (err) => console.error('pg pool error:', err.message))
  }
  return serverlessPool
}
