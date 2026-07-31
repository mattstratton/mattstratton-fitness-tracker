# Health Auto Export pushes to an API; the laptop is not infrastructure

Reports used to arrive as JSON files that HAE wrote into two iCloud folders, which a
launchd agent on a MacBook polled hourly. HAE supports posting to a REST endpoint
instead. We took it: HAE now pushes to a deployed API, and the Liftosaur pull runs as a
scheduled job next to it.

## Consequences

This deletes roughly 150 lines of code that existed solely to survive iCloud, and every
line of it was written in response to something that actually broke. Files under
`~/Library/Mobile Documents` can exist as metadata-only placeholders that a launchd agent
cannot materialise, failing with `EDEADLK` — a bug that stranded four days of workouts
and looked like file corruption. Two automations wrote the same data to two folders, so
whichever sorted last alphabetically won, until it was changed to whichever had the later
mtime — on files whose mtimes iCloud does not update reliably. None of this code has a
successor; it has no reason to exist once nobody is reading files.

It also makes Report Time honest for free. Ordering Restatements previously depended on
inferring delivery order from unreliable filesystem metadata; it is now the HTTP receipt
time, which is exactly the thing being modelled.

Accepted in exchange: this is a real deployment with real uptime and real secrets, and
if the endpoint returns 500 then HAE's retry behaviour becomes this project's problem
rather than a file sitting patiently on disk. Coaching now requires a network. The
laptop being closed, asleep, or elsewhere stops mattering, which was the point.
