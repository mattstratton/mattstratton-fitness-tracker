# Personal health data lives in a managed cloud

This repository previously promised, in its README, that "health data and secrets never
leave this machine". That is no longer true. Weight, body composition, food logs, sleep
and training history now live in a hosted Tiger Cloud service. The decision is
deliberate: it is what makes the data reachable from a phone, survivable across laptops,
and usable by a service rather than a cron job on someone's desk.

## Consequences

The service lives in a **personal** Tiger Cloud project, not the TigerData corporate one.
That distinction is the substance of this decision rather than an implementation detail —
the corporate project has a dozen services and colleagues with access to them, and body
composition data does not belong next to a PR preview environment.

The old promise is retired explicitly rather than quietly dropped. Any writing about this
project should say plainly that personal health data was moved into a hosted database and
why, because a post about dogfooding that omits the part where you uploaded your own body
fat percentage is not a candid post.

Rejected: a local Postgres container, which keeps the promise intact and delivers most of
the same technical ground. It was turned down because it keeps the laptop as
infrastructure, which is the thing being escaped, and forecloses the phone-facing
frontend entirely.
