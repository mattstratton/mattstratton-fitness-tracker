# `America/Chicago` is the canonical day boundary

Every interesting question here is a cross-source join on a day — protein on lifting days
versus rest days, sleep before a heavy session — and the two sources disagree about what
a day is. Health Auto Export writes dates in whatever zone the phone was in; Liftosaur
emits `+00:00` and never carries a local offset at all. We convert every instant from
every source to `America/Chicago` and take that calendar date as the Observed Day. The
zone is a named constant, not the machine's locale.

## Consequences

Reproducibility is the point: the same input yields the same Observed Day no matter where
the sync runs from. That closes a live bug — the Liftosaur sync called `astimezone()`
with no argument, meaning the machine's *current* zone, while also re-pulling and
rewriting the entire 2.5-year history on every run. One sync from a different timezone
would have silently re-dated every near-midnight session in the archive. It never fired
only because every sync so far has run from Central.

Preserving the zone each Observation was actually recorded in was considered and is
impossible: Liftosaur simply does not provide it, so that option can only ever mean "the
phone's zone for one source and UTC for the other", which makes every cross-source join
subtly wrong. It is also the exact shape of the travel-day duplicate this project already
had to repair by hand.

The accepted cost is that genuinely distant travel files sessions under the wrong local
day — an evening lift in Tokyo lands on the previous Chicago day, disagreeing with the
food logged alongside it. Raw instants are stored beside the Observed Day, so a
travel-aware reading remains possible later. Moving house means changing the constant and
backfilling, which is the correct amount of ceremony for redefining every date in the
system.
