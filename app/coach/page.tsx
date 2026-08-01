import { loadSignals } from '../../lib/queries.js'
import { SignalCard } from '../ui.js'

export const dynamic = 'force-dynamic'

export default async function Coach() {
  const signals = await loadSignals()
  const rank = { act: 0, watch: 1, unknown: 2, ok: 3 } as const
  const sorted = [...signals].sort((a, b) => rank[a.status] - rank[b.status])

  return (
    <main>
      <h2>Signals</h2>
      {sorted.map((s) => <SignalCard key={s.id} signal={s} />)}
      <p className="empty" style={{ marginTop: '1.5rem' }}>
        Every verdict here is a deterministic rule over the data, not a judgement
        call — the logic lives in <code>lib/signals/</code> and is unit-tested.
        &ldquo;Unknown&rdquo; means there isn&rsquo;t enough data to answer, which is
        deliberately not the same as &ldquo;fine&rdquo;.
      </p>
    </main>
  )
}
