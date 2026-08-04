import { loadLatestSleep, loadSignals } from '../../lib/queries.js'
import { describeSleepAge, formatSleepDuration } from '../../lib/sleep.js'
import { SignalCard, signalHref } from '../ui.js'

export const dynamic = 'force-dynamic'

export default async function Coach() {
  const [signals, sleep] = await Promise.all([loadSignals(), loadLatestSleep()])
  const rank = { act: 0, watch: 1, unknown: 2, ok: 3 } as const
  const sorted = [...signals].sort((a, b) => rank[a.status] - rank[b.status])

  return (
    <main>
      <h2>Signals</h2>
      {sorted.map((s) => <SignalCard key={s.id} signal={s} href={signalHref(s.id)} />)}
      <p className="empty" style={{ marginTop: '1.5rem' }}>
        Every verdict here is a deterministic rule over the data, not a judgement
        call — the logic lives in <code>lib/signals/</code> and is unit-tested.
        &ldquo;Unknown&rdquo; means there isn&rsquo;t enough data to answer, which is
        deliberately not the same as &ldquo;fine&rdquo;.
      </p>

      <h2 style={{ marginTop: '1.5rem' }}>Sleep</h2>
      {sleep ? (
        <p className="empty">
          {describeSleepAge(sleep.ageDays)} ({sleep.observedOn}) — {formatSleepDuration(sleep.asleepMin ?? 0)} asleep
          {sleep.inBedMin !== null ? ` of ${formatSleepDuration(sleep.inBedMin)} in bed` : ''}. Tracked but not
          monitored here — coverage is too sparse (~7%) to grade, so this is informational only, never a signal.
        </p>
      ) : (
        <p className="empty">No sleep data recorded.</p>
      )}
    </main>
  )
}
