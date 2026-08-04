/**
 * Whether the local-dev auth bypass is active.
 *
 * This is the OTHER half of the security boundary lib/allowlist.ts guards --
 * that file decides who's allowed in for real; this decides whether the gate
 * gets skipped entirely for local development. Requires BOTH the explicit
 * opt-in env var AND a non-production NODE_ENV. `next dev` (what `npm run
 * dev` runs) always sets NODE_ENV=development automatically; `next
 * build`/`next start` -- what Vercel always runs, for preview deploys and
 * production alike -- always sets NODE_ENV=production. So even if
 * DEV_BYPASS_AUTH were ever set by mistake on a deployed environment, this
 * still returns false there. Two independent signals, not one flag.
 */
export function isDevBypassActive(
  env: { NODE_ENV: string | undefined; DEV_BYPASS_AUTH: string | undefined },
): boolean {
  return env.NODE_ENV !== 'production' && env.DEV_BYPASS_AUTH === '1'
}
