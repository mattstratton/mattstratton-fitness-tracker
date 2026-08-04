import {
  loadLiftingSetsForRecords, loadNextWorkoutPreview, loadRecentLiftingSessions,
} from '../../lib/queries.js'
import { classifySet, groupSessionSets } from '../../lib/session-history.js'
import { NextWorkoutCard } from '../ui.js'

export const dynamic = 'force-dynamic'

export default async function Workouts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const params = await searchParams
  const sessionParam = params['session']

  const [preview, sessions] = await Promise.all([
    loadNextWorkoutPreview(),
    loadRecentLiftingSessions(),
  ])
  // Depends on sessions' record ids, so it can't join the Promise.all above.
  const sets = await loadLiftingSetsForRecords(sessions.map((s) => s.recordId))
  const groups = new Map(groupSessionSets(sets).map((g) => [g.recordId, g]))

  // With no ?session= param, only the single most-recent session opens by
  // default; with one, that specific session forces open (regardless of
  // recency) and its id="session-<id>" fragment gives free native scroll-to.
  const mostRecentId = sessions[0]?.recordId
  const isOpen = (recordId: number) =>
    sessionParam !== undefined ? String(recordId) === sessionParam : recordId === mostRecentId

  return (
    <main>
      <h2>Next up</h2>
      <NextWorkoutCard preview={preview} />

      <h2>Session history</h2>
      {sessions.length === 0 ? (
        <p className="empty">No lifting sessions recorded yet.</p>
      ) : (
        sessions.map((session) => {
          const group = groups.get(session.recordId)
          return (
            <details
              key={session.recordId}
              className="session"
              id={`session-${session.recordId}`}
              open={isOpen(session.recordId)}
            >
              <summary>
                {session.observedOn} · {session.label ?? 'lifting'}
                {session.durationMin !== null ? ` · ${Math.round(session.durationMin)} min` : ''}
                {session.energyKcal !== null ? ` · ${Math.round(session.energyKcal)} kcal` : ''}
                {' '}· {session.setCount} sets
              </summary>
              {group
                ? group.exercises.map((ex) => (
                    <div className="session-exercise" key={ex.exercise}>
                      <div className="name">{ex.exercise}</div>
                      <ul>
                        {ex.sets.map((s) => (
                          <li key={s.setIndex} data-c={classifySet(s)}>
                            {s.reps} reps{s.weightLbs !== null ? ` @ ${s.weightLbs}lb` : ''}
                            {s.targetReps !== null ? ` (target ${s.targetReps}${s.isAmrap ? '+' : ''})` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))
                : null}
            </details>
          )
        })
      )}
    </main>
  )
}
