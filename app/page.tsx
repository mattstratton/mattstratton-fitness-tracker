import { loadLatestSleep, loadSignals, loadToday } from '../lib/queries.js'
import { isSleepRecent } from '../lib/sleep.js'
import { SignalCard, signalHref, SleepTile, Tile } from './ui.js'

// Always live: a coaching glance that shows cached numbers is worse than none.
export const dynamic = 'force-dynamic'

export default async function Today() {
  const [today, signals, sleep] = await Promise.all([loadToday(), loadSignals(), loadLatestSleep()])
  // Anything needing a decision, plus data problems, floats to the top.
  const rank = { act: 0, watch: 1, unknown: 2, ok: 3 } as const
  const sorted = [...signals].sort((a, b) => rank[a.status] - rank[b.status])
  // Sleep is too sparse to expect daily -- only show it while it's still
  // fresh enough to read as "recent," never as a stale stand-in for today.
  const recentSleep = sleep && isSleepRecent(sleep.ageDays) ? sleep : null

  return (
    <main>
      <h2>Today so far</h2>
      <div className="tiles">
        <Tile label="Weight" value={today.weightLbs} unit="lb" />
        <Tile label="Protein" value={today.proteinG} unit="g" />
        <Tile label="Calories" value={today.caloriesIn} />
        <Tile label="Steps" value={today.steps} />
        {recentSleep ? <SleepTile sleep={recentSleep} /> : null}
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
          .map((s) => <SignalCard key={s.id} signal={s} showDetail={false} href={signalHref(s.id)} />)
      )}

      <h2>Everything else</h2>
      {sorted
        .filter((s) => s.status === 'ok' || s.status === 'unknown')
        .map((s) => <SignalCard key={s.id} signal={s} showDetail={false} href={signalHref(s.id)} />)}

      {today.lastSession ? (
        <>
          <h2>Last session</h2>
          <a
            className="empty"
            href={`/workouts?session=${today.lastSession.recordId}#session-${today.lastSession.recordId}`}
          >
            {today.lastSession.observedOn} · {today.lastSession.label ?? 'lifting'} ·{' '}
            {today.lastSession.setCount ?? 0} sets
          </a>
        </>
      ) : null}
    </main>
  )
}
