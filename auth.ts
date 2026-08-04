import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'

import { isAllowed } from './lib/allowlist.js'
import { isDevBypassActive } from './lib/devBypass.js'

let warnedAboutDevBypass = false

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  callbacks: {
    // The gate. Returning false here is what stops everyone who isn't Matty --
    // see lib/allowlist.ts, which has its own tests.
    signIn({ profile }) {
      return isAllowed(profile?.email, profile?.email_verified)
    },
    // Without this, exporting `auth` as middleware merely ATTACHES the session
    // and lets every request through -- it looks configured and protects
    // nothing. Verified: before adding it, `/` returned 200 to an anonymous
    // request. This callback is what turns the middleware into a gate.
    authorized({ auth }) {
      // See lib/devBypass.ts for why this can't take effect on anything
      // Vercel actually deploys -- local dev only, and only when opted in.
      if (isDevBypassActive({ NODE_ENV: process.env['NODE_ENV'], DEV_BYPASS_AUTH: process.env['DEV_BYPASS_AUTH'] })) {
        if (!warnedAboutDevBypass) {
          console.warn(
            '\n⚠️  DEV_BYPASS_AUTH is set — every route is open, no sign-in required. Never set this outside local dev.\n',
          )
          warnedAboutDevBypass = true
        }
        return true
      }
      return auth?.user != null
    },
  },
  pages: {
    // Default Auth.js error page leaks provider details; ours just says no.
    signIn: '/signin',
    error: '/signin',
  },
})
