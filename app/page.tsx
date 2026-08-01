import { loadSignals, loadToday } from '../lib/queries.js'
import { SignalCard, Tile } from './ui.js'

// Always live: a coaching glance that shows cached numbers is worse than none.
export const dynamic = 'force-dynamic'

export default async function Today() {
  const [today, signals] = await Promise.all([loadToday(), loadSignals()])
  // Anything needing a decision, plus data problems, floats to the top.
  const rank = { act: 0, watch: 1, unknown: 2, ok: 3 } as const
  const sorted = [...signals].sort((a, b) => rank[a.status] - rank[b.status])

  return (
    <main>
      <h2>Today so far</h2>
      <div className="tiles">
        <Tile label="Weight" value={today.weightLbs} unit="lb" />
        <Tile label="Protein" value={today.proteinG} unit="g" />
        <Tile label="Calories" value={today.caloriesIn} />
        <Tile label="Steps" value={today.steps} />
      </div>
      <p className="empty">
        Today is still in progress — these are whatever has been logged so far, and
        are excluded from every average below.
      </p>

      <h2>Needs attention</h2>
      {sorted.filter((s) => s.status === 'act' || s.status === 'watch').length === 0 ? (
        <p className="empty">Nothing flagged.</p>
      ) : (
        sorted
          .filter((s) => s.status === 'act' || s.status === 'watch')
          .map((s) => <SignalCard key={s.id} signal={s} showDetail={false} />)
      )}

      <h2>Everything else</h2>
      {sorted
        .filter((s) => s.status === 'ok' || s.status === 'unknown')
        .map((s) => <SignalCard key={s.id} signal={s} showDetail={false} />)}

      {today.lastSession ? (
        <>
          <h2>Last session</h2>
          <p className="empty">
            {today.lastSession.observedOn} · {today.lastSession.label ?? 'lifting'} ·{' '}
            {today.lastSession.setCount ?? 0} sets
          </p>
        </>
      ) : null}
    </main>
  )
}
