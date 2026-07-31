# Append Reports; never update an Observation

Health Auto Export re-sends a rolling window of recent days on every push, so the same
Observation arrives repeatedly and later Reports revise earlier ones — food logged after
dinner changes what 6pm's Report claimed. The old SQLite schema resolved this with
`ON CONFLICT DO UPDATE`, keeping one row per day and discarding every prior Report. We
now append every Report and never update one, deriving the current answer as
`last(value, reported_at)`.

## Consequences

The two worst failures in this project's history were both invisible under
last-write-wins-in-place: five days where an iOS update silently dropped HealthKit
permission for weight while syncs kept reporting success, and a midday Report that made
a normal 1241 kcal day look like a 333 kcal fast. Both are now directly queryable — the
first as "no Reports arrived for this Metric", the second as two Reports for one
Observed Day that disagree.

The costs are real and accepted: rows grow with delivery frequency rather than with
lived days, retention on the Report log becomes mandatory rather than optional, and
"what is true" is a derived answer rather than something you can read off a row. That
last one is mitigated by exposing the derivation as a continuous aggregate, so no caller
has to remember to do it.

Rejected: appending only when a value changed. It halves nothing that matters — Reports
now arrive daily, not hourly — and buys that saving with a read-before-write on every
point, which is both slower and a correctness hazard.
