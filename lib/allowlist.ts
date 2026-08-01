/**
 * Who is allowed in.
 *
 * This function IS the security boundary. Anyone on the internet can complete a
 * Google sign-in and reach the callback; the only thing standing between them
 * and ten years of health data is the check below. Hence a pure function with
 * its own tests rather than an inline comparison buried in a callback.
 */
const ALLOWED = new Set(['matt.stratton@gmail.com'])

export function isAllowed(
  email: unknown,
  emailVerified: unknown,
): boolean {
  if (typeof email !== 'string' || email === '') return false
  // Google only asserts email_verified for addresses it actually controls. On a
  // Workspace domain it can be false, and an unverified address is just a claim
  // -- treating it as identity would let someone assert any address they liked.
  // Anything other than a literal true is refused.
  if (emailVerified !== true) return false
  // Addresses are case-insensitive in practice; compare normalised so
  // Matt.Stratton@... cannot slip past a case-sensitive Set lookup.
  return ALLOWED.has(email.trim().toLowerCase())
}
