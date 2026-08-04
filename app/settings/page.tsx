import { MAINTAIN, BULK } from '../../lib/config.js'
import type { Phase } from '../../lib/config.js'
import { loadTargetHistory, saveTargets } from '../../lib/queries.js'

export const dynamic = 'force-dynamic'

// No redirect() here: Next.js re-renders the invoking route automatically
// once a <form action={...}> Server Action resolves, and this page is
// force-dynamic anyway so there's no route cache to invalidate.
async function updateTargets(formData: FormData): Promise<void> {
  'use server'
  const caloriesRaw = String(formData.get('calories') ?? '').trim()
  const note = String(formData.get('note') ?? '').trim()

  await saveTargets({
    phase: formData.get('phase') as Phase,
    proteinG: Number(formData.get('proteinG')),
    calories: caloriesRaw === '' ? null : Number(caloriesRaw),
    expected: Number(formData.get('expected')),
    concerning: Number(formData.get('concerning')),
    note: note === '' ? null : note,
  })
}

export default async function Settings() {
  const history = await loadTargetHistory()
  const current = history[0]

  return (
    <main>
      <h2>Current</h2>
      {current ? (
        <p className="empty">
          <strong>{current.phase}</strong> since {current.effectiveOn} — {current.proteinG}g
          protein
          {current.calories !== null ? `, ${current.calories} kcal` : ', calories not steered'},{' '}
          {current.expected.toFixed(1)} lb/week expected (concerning past ±
          {current.concerning})
        </p>
      ) : (
        <p className="empty">No targets set yet.</p>
      )}

      <h2>Update</h2>
      <form action={updateTargets} className="settings-form">
        <label>
          Phase
          <select name="phase" defaultValue={current?.phase ?? 'cut'}>
            <option value="cut">cut</option>
            <option value="maintain">maintain</option>
            <option value="bulk">bulk</option>
          </select>
        </label>
        <label>
          Protein (g/day)
          <input type="number" name="proteinG" step="1" min="0" defaultValue={current?.proteinG} required />
        </label>
        <label>
          Calories (blank if not steering by calories)
          <input type="number" name="calories" step="1" min="0" defaultValue={current?.calories ?? ''} />
        </label>
        <label>
          Expected lb/week (signed — negative is loss)
          <input type="number" name="expected" step="0.1" defaultValue={current?.expected} required />
        </label>
        <label>
          Concerning past (lb/week magnitude)
          <input type="number" name="concerning" step="0.1" min="0" defaultValue={current?.concerning} required />
        </label>
        <label>
          Note (optional)
          <input type="text" name="note" placeholder="e.g. MacroFactor re-tune after weigh-in" />
        </label>
        <button type="submit">Save</button>
      </form>

      <p className="empty">
        Presets to start from — maintain: {MAINTAIN.proteinG}g protein, no calorie target,
        ~0 lb/week. Bulk: {BULK.proteinG}g protein, no calorie target, +{BULK.expected} lb/week.
      </p>

      <h2>History</h2>
      {history.length === 0 ? (
        <p className="empty">Nothing recorded yet.</p>
      ) : (
        <ul className="target-history">
          {history.map((h) => (
            <li key={h.id}>
              <strong>{h.effectiveOn}</strong> — {h.phase}, {h.proteinG}g protein
              {h.calories !== null ? `, ${h.calories} kcal` : ''}, {h.expected.toFixed(1)} lb/week
              expected
              {h.note ? ` — ${h.note}` : ''}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
