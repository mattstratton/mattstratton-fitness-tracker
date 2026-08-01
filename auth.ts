import NextAuth from 'next-auth'
import Google from 'next-auth/providers/google'

import { isAllowed } from './lib/allowlist.js'

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
      return auth?.user != null
    },
  },
  pages: {
    // Default Auth.js error page leaks provider details; ours just says no.
    signIn: '/signin',
    error: '/signin',
  },
})
