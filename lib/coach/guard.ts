/**
 * Who may talk to /api/coach.
 *
 * THIS MATTERS MORE THAN ANYTHING ELSE IN lib/coach. `proxy.ts` excludes `/api`
 * from the auth middleware wholesale and deliberately -- /api/hae needs to accept
 * Health Auto Export's bearer token and the crons are invoked by Vercel, none of
 * which carry a browser session. The consequence is that **a new route under
 * /api is open to the internet until it authenticates itself.** Every other
 * machine endpoint in this app has its own bearer check for exactly this reason;
 * this is the browser-session equivalent, and it is why the check is a pure
 * function with its own tests rather than an inline comparison in a route handler.
 *
 * The thing on the other side of it is ten years of health data plus an API key.
 */
import { isAllowed } from '../allowlist.js'
import { isDevBypassActive } from '../devBypass.js'

/** The shape of an Auth.js session, narrowed to what the decision needs. */
export type SessionLike = { user?: { email?: string | null } | null } | null | undefined

export function isAuthorizedApiSession(
  session: SessionLike,
  env: { NODE_ENV: string | undefined; DEV_BYPASS_AUTH: string | undefined },
): boolean {
  // Local dev only, and only when explicitly opted in. isDevBypassActive also
  // requires NODE_ENV !== 'production', which `next build`/`next start` always
  // set -- so this cannot take effect on anything Vercel deploys, preview
  // included. Two independent signals, not one flag. See lib/devBypass.ts.
  if (isDevBypassActive(env)) return true

  // A session existing at all already implies the allowlist passed: auth.ts's
  // signIn callback runs isAllowed(profile.email, profile.email_verified) and
  // refuses everyone else. Re-checking the address here is defence in depth
  // against a future refactor that loosens the callback, and costs nothing.
  //
  // `true` is passed for emailVerified because the session does not carry the
  // claim -- Google asserts it at sign-in and it was checked there, against the
  // provider's own profile rather than anything the browser could supply. This
  // second check is therefore "is this the allowed address", not a re-run of
  // verification. Passing the session's own value would be worse, not better:
  // there isn't one, and a missing field would read as unverified and lock the
  // real user out.
  return isAllowed(session?.user?.email, true)
}
