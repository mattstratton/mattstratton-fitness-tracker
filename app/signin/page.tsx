import { signIn } from '../../auth.js'

export default function SignIn({ searchParams }: { searchParams?: Record<string, string> }) {
  const failed = searchParams?.['error'] !== undefined
  return (
    <main style={{ fontFamily: 'system-ui', padding: '3rem 1.5rem', maxWidth: 420 }}>
      <h1 style={{ fontSize: '1.25rem' }}>fitness</h1>
      {failed && (
        // Deliberately vague: telling an unauthorised visitor whether the
        // address exists, or that an allowlist is what stopped them, is free
        // reconnaissance.
        <p style={{ color: '#b00' }}>Sign-in failed.</p>
      )}
      <form action={async () => { 'use server'; await signIn('google', { redirectTo: '/' }) }}>
        <button type="submit" style={{ padding: '0.6rem 1rem', fontSize: '1rem' }}>
          Sign in with Google
        </button>
      </form>
    </main>
  )
}
