import { existsSync } from 'node:fs'
import pg from 'pg'

/**
 * Load .env if present. Node has this built in since 21.7, so no dotenv.
 * Real environment variables win, which is what Vercel supplies in production.
 */
export function loadEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path)
}

/**
 * A connection pool.
 *
 * On Vercel this MUST be Tiger Cloud's *pooled* connection string. Serverless
 * functions are stateless and scale horizontally, so each concurrent invocation
 * opens its own connections; a direct connection string exhausts the server's
 * limit under trivial load.
 */
export function makePool(): pg.Pool {
  loadEnv()
  const connectionString = process.env['DATABASE_URL']
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set (put it in .env or the environment)')
  }
  return new pg.Pool({
    connectionString,
    // Tiger Cloud requires TLS. Local docker doesn't offer it.
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: true },
    max: 4,
  })
}
