# One `observations` table instead of typed per-domain tables

Nutrition, activity, body composition and sleep were four tables with typed columns —
`protein_g`, `steps`, `asleep_minutes` — plus one table (`body_metrics`) that was already
key/value for no articulated reason. All five hold the same shape of fact: a scalar for
one Metric on one Observed Day, with a unit. We collapsed them into a single
`observations` table keyed by Metric name, and rebuilt the four typed shapes as views
over it.

This is entity-attribute-value, which is normally an anti-pattern, so the reasoning
needs to be on the record rather than rediscovered by whoever tries to "fix" it.

## Consequences

Adding a Metric stops being a schema change. That is not hypothetical: the ingest was
silently discarding every Metric it didn't have a column for, and a full export turned
out to carry 64 Metrics against a schema that modelled 17 — resting heart rate, basal
energy, fibre, HRV, and MacroFactor's entire micronutrient panel, all landing in a
variable named `unknown` and then thrown away. Under typed tables, capturing them is 47
migrations and the next one is a 48th. Here, enabling a Metric in an iPhone app is the
entire deployment.

It also happens to be the best possible shape for a columnstore — tall, narrow, and
segmented by a low-cardinality key — which is a genuine benefit but was not the reason.

The accepted cost is that column-level typing is gone: nothing at the schema level stops
`protein_g` holding a weight. Queries wanting several Metrics at once must pivot, which
is why the friendly views exist. Units are stored per-Report rather than declared once,
so a source changing units mid-history is possible and must be caught by tests rather
than by the database.
