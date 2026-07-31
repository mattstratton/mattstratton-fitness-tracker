import { timingSafeEqual } from 'node:crypto'

/** Constant-time bearer-token check. */
function tokenMatches(header: string | null, expected: string): boolean {
  if (!header) return false
  const given = header.startsWith('Bearer ') ? header.slice(7) : header
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Authorise a request against a shared secret in an env var.
 *
 * Returns null when allowed, or the Response to send when not.
 *
 * A missing secret is treated as a HARD FAILURE rather than "auth disabled".
 * The opposite default -- skip the check when unconfigured -- is how an endpoint
 * accepting personal health data ends up open to the internet because someone
 * forgot an environment variable.
 */
export function requireBearer(request: Request, envVar: string): Response | null {
  const expected = process.env[envVar]
  if (!expected) {
    console.error(`${envVar} is not set; refusing all requests`)
    return json({ error: 'server misconfigured' }, 500)
  }
  if (!tokenMatches(request.headers.get('authorization'), expected)) {
    return json({ error: 'unauthorized' }, 401)
  }
  return null
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
