import Chat from './chat.js'

export const metadata = { title: 'ask' }

/**
 * The coaching chat (#8).
 *
 * Separate from /coach on purpose. /coach is the deterministic view -- every
 * verdict there is a unit-tested rule, and it stays that way. This page is the
 * layer that answers questions nobody wrote a rule for, which is a different
 * trust level and shouldn't be mixed in with the cards.
 */
export default function Ask() {
  return (
    <main>
      <h2>Ask</h2>
      <Chat />
    </main>
  )
}
