# Backups and recovery

## What must survive

| Asset                           | Where                                         | Backup                                                                                                                                           |
| ------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The `control` database          | PostgreSQL 16                                 | Continuous archiving with point-in-time recovery, 35-day window; a daily logical dump (`pg_dump -Fc`) kept 90 days, encrypted, in another region |
| The licence signing private key | Secret store                                  | Offline copy, encrypted, under two-person control, in two places                                                                                 |
| The configuration               | Secret store and the deployment's environment | Infrastructure as code (`infra/terraform/`) plus the secret store's own versioning                                                               |

Nothing else is state: the API and the portal are stateless.

## Verify (monthly, and before every release)

1. Restore the latest dump into a scratch database (`createdb control_restore && pg_restore -d …`).
2. Apply grants: `DATABASE_MIGRATION_URL=…/control_restore pnpm db:migrate` (a no-op for migrations,
   reapplies grants).
3. Point a scratch API at it and call `GET /health/ready` and one product's entitlement request.
4. Compare counts of customers, subscriptions and audit events with production at the dump's time.

## Restore

1. Stop the API (products keep working on their remembered answers for an hour, degraded after that;
   `docs/integration.md`).
2. Restore to the chosen point in time into a new database; apply grants as above.
3. Point the API at it, roll it, check readiness, then the portal.
4. Reconcile: anything done in the portal after the recovery point is lost and must be redone from
   the audit trail of the old database if it is readable, or from operators' records. Licences
   issued after the point are still valid offline (they are signed files); record them again by
   re-issuing for the same installation.

## Losing the signing key

With the offline backup: restore it to the secret store. Without one: generate a new key and follow
the compromise procedure in `licence-signing.md` (every installation needs the new public key and a
reissued licence at its next renewal).

## The control plane down for days

Products follow the shared outage policy: full for an hour, no growth for a day, read-only for a
week, then nothing. If an outage will exceed a day, products may be switched to a licence file per
deployment as a stopgap only with the owner's decision; that is an operational change on the product
side, not here.
