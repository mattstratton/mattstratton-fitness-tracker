# Deploying

The app is three serverless functions and two crons. There is no frontend yet.

> **Deploy into the personal Vercel scope, not TigerData's.** The CLI and the
> Vercel MCP both have access to more than one team, and this endpoint serves
> personal health data — it does not belong in company infrastructure, for the
> same reason the database lives in a personal Tiger Cloud project
> (docs/adr/0005). Pass `--scope` explicitly on every command rather than
> trusting whichever team happens to be active.

## 1. Secrets

```bash
openssl rand -hex 32   # HAE_INGEST_TOKEN
openssl rand -hex 32   # CRON_SECRET
```

Set four variables in the Vercel project: `DATABASE_URL`, `LIFTOSAUR_API_KEY`,
`HAE_INGEST_TOKEN`, `CRON_SECRET`. See `.env.example`.

Both tokens fail **closed**: if unset, the routes reject every request rather
than running unauthenticated.

## 2. Link and deploy

```bash
vercel whoami                      # confirm the scope before anything else
vercel link   --scope mattystratton
vercel deploy --scope mattystratton --prod
```

Crons only run on production deployments.

## 3. Point Health Auto Export at it

In HAE, add an automation:

- Export destination: **REST API**
- URL: `https://<deployment>/api/hae`
- Header: `Authorization: Bearer <HAE_INGEST_TOKEN>`
- Format JSON, aggregate by day, and **enable every metric** — unknown metrics
  land under their own names and cost nothing (docs/adr/0002).

Leave the existing iCloud automations running during the parallel run. Verify
with `node scripts/diff-oracle.ts` until the two stores agree, then delete them
along with the Python pipeline and the launchd agent.

## 4. Check it

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<deployment>/api/cron/freshness
```

Returns 503 when an automatic source has gone stale, so a broken pipeline shows
up as a failed cron run rather than a cheerful 200 with bad news in the body.

## Runtime notes

- **One DB connection per function instance** (`lib/db.ts`). This service has no
  connection pooler in front of it, so a generous per-instance pool multiplied by
  Vercel's horizontal scaling is how you exhaust a 0.5 CPU server.
- **A brand-new Tiger Cloud service serves a temporary self-signed certificate**
  for a few minutes before a publicly-signed one replaces it. If TLS verification
  fails on a fresh service, wait — do not reach for `rejectUnauthorized: false`.
- **Never `refresh_continuous_aggregate(..., NULL, NULL)`.** Materialising
  today's bucket stops real-time aggregation consulting raw rows for it, so
  pushes arriving later that day stay invisible until the next scheduled
  refresh. Refresh up to `today_local()` and let today be served live.
