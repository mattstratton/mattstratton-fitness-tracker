export { auth as middleware } from './auth.js'

export const config = {
  // Guard the UI, never the machine endpoints.
  //
  // /api is excluded wholesale and on purpose: /api/hae is how Health Auto
  // Export delivers data and the crons are invoked by Vercel, none of which
  // carry a browser session. Those routes have their own bearer tokens, which
  // fail closed when unset. /api/auth must also stay open or signing in would
  // require being signed in.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
}
