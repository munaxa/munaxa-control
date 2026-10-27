# Deploying Munaxa Control

**Status:** not deployed. Nothing in this repository has been deployed or published; every step
below needs the owner's go-ahead, and the first production deployment needs `@munaxa/licensing`
published (see the repository README).

## Topology

```text
                 operators (browser)                       product deployments
                        │                                            │
        https://control.munaxa.com  (front door)        https://control-api.munaxa.com
          ├── /api/auth/*  ──► Munaxa Identity                       │
          └── /*           ──► portal (Next.js) ──► control API ◄────┘
                                        (CONTROL_API_URL, private)    /api/v1/products/*
                                                                     /api/v1/licensing/public-keys
                                                                     /health/*
                                     control API ──► PostgreSQL 16 (control)
```

- **One origin for operators.** The portal and Identity share a host so Identity's host-only
  session cookie (`__Host-mx_session`, Identity ADR-0004) reaches the portal. Sign-in is
  `/api/auth/login?returnTo=…`, sign-out `POST /api/auth/logout`.
- **The admin API is not public.** Only the portal calls `/api/v1/admin/*`, over the private network
  (`CONTROL_API_URL`). Expose to the internet only `/api/v1/products/*`, `/api/v1/licensing/public-keys`
  and the probes, on the products' hostname; deny `/api/v1/admin/*` there at the load balancer as a
  second line (the API refuses it anyway without an operator token).
- **TLS everywhere outside the host.** Products refuse an `http://` `CONTROL_PLANE_URL` in production.
- **The operator front door is not on the open internet** while operators have one factor (ADR-0006):
  restrict it to Munaxa Group's network or VPN at the load balancer or WAF.

## Database

```bash
psql "$ADMIN_URL" -f infra/sql/roles.sql            # control_owner (schema owner), control_app (runtime)
createdb -O control_owner control
DATABASE_MIGRATION_URL=postgresql://control_owner@…/control pnpm db:migrate   # migrations, then grants
```

`pnpm db:migrate` runs `prisma migrate deploy` as the owner and then re-applies
`infra/sql/grants.sql`, which gives `control_app` no `DELETE` or `TRUNCATE` anywhere and only
`INSERT`/`SELECT` on history, usage and audit. The API runs as `control_app` and never sees the
owner's credentials. Run migrations as a release step, before the new API version starts; they are
additive.

## Images

One `Dockerfile`, three targets, each built from the committed lockfile on a digest-pinned base, with
the `@munaxa/*` registry token as a BuildKit secret that never reaches a layer:

```bash
for target in api migrate portal; do
  docker buildx build --secret id=node_auth_token,env=NODE_AUTH_TOKEN \
    --target "$target" -t "munaxa-control-$target:$(git rev-parse --short HEAD)" .
done
```

| Target    | Runs                                    | Notes                                                                                                                                                                                                                              |
| --------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api`     | `node dist/main.js` as `node`           | Production dependencies only. Works on a read-only root filesystem with a `/tmp` tmpfs. Mount the signing key read-only at `LICENCE_SIGNING_PRIVATE_KEY_FILE`, owned by uid 1000, mode 0400. Has a `HEALTHCHECK` on `/health/live` |
| `migrate` | `node scripts/migrate.mjs` as `node`    | The release job: migrations and runtime grants as the owner role (`DATABASE_MIGRATION_URL`). Run once, before the new API                                                                                                          |
| `portal`  | the Next.js standalone server as `node` | `CONTROL_API_URL`, `PORT` (3200). No secret                                                                                                                                                                                        |

## The API

Build `pnpm --filter @control/api build`; run `node apps/api/dist/main.js` (or the `api` image). Configuration is
`.env.example`; everything is validated at startup and a bad value stops the process.

| Variable                                                                       | Notes                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `DATABASE_URL`                                                                 | `control_app`. From the secret store                                           |
| `OPERATOR_AUTH_ISSUER`                                                         | Identity's `IDENTITY_BASE_URL`, character for character; `https` in production |
| `OPERATOR_AUTH_AUDIENCE`                                                       | `munaxa-control` — and Identity's `IDENTITY_AUTH_AUDIENCE` must include it     |
| `OPERATOR_AUTH_PUBLIC_KEYS`                                                    | Identity's **public** key(s)                                                   |
| `OPERATOR_ORGANISATION_ID`                                                     | The Identity organisation Munaxa Group staff belong to                         |
| `OPERATOR_REQUIRE_MFA`                                                         | `true` as soon as Identity issues `mfa` claims                                 |
| `LICENCE_SIGNING_PRIVATE_KEY_FILE`                                             | A mounted secret file, mode 0400 (`licence-signing.md`)                        |
| `LICENCE_SIGNING_KID`, `LICENCE_PREVIOUS_PUBLIC_KEYS`, `LICENCE_MAX_TERM_DAYS` | `licence-signing.md`                                                           |
| `ENTITLEMENT_CACHE_SECONDS`                                                    | 30 — how long products may reuse an answer                                     |
| `IDEMPOTENCY_RETENTION_HOURS`                                                  | 48                                                                             |

Probes: liveness `GET /health/live`, readiness `GET /health/ready` (the database answers). Logs are
JSON lines on stdout (pino) with the request id; authorization headers and secrets are redacted.

Run at least two instances; the API is stateless and every cross-request guarantee (idempotency,
versions) is in the database.

## The sweep

`node apps/api/dist/sweep.js` records the status moves term dates have already made (trial ended,
term ended, grace ended) in the subscription history. Products never depend on it — each snapshot's
status is computed from dates at the moment it is served — but the portal's lists, reports and the
audit trail do. Run it **hourly** from the platform scheduler (a cron job or scheduled task with the
API's image and environment); it is idempotent and safe to overlap. It exits non-zero on failure:
alert on that.

## The portal

Build `pnpm --filter @control/portal build`; run the standalone server
`node apps/portal/.next/standalone/apps/portal/server.js` (not `next start`), with
`CONTROL_API_URL` (the API's private URL), `PORT` and `NODE_ENV=production`. It holds no secret and
no state.

## Munaxa Identity

1. Add `munaxa-control` to `IDENTITY_AUTH_AUDIENCE`.
2. Route `/api/auth/*` on the operator front door to Identity.
3. Seed roles from `artifacts/control-permissions.json` (regenerate with `pnpm catalogue:emit`), and
   grant them to Munaxa Group staff in the operator organisation only.

## Products

See `docs/integration.md`. Per deployment: create it in the portal, issue its credential into the
product's secret store, set `LICENSING_MODE=CONTROL_PLANE`, `CONTROL_PLANE_URL` (and Docs'
`OUTBOUND_HTTP_ALLOWLIST`). Roll products to `CONTROL_PLANE` one deployment at a time, after the
customers and subscriptions for that deployment exist here — a tenant with no subscription here gets
nothing beyond its core modules.

## Release checklist

1. `pnpm install --frozen-lockfile && pnpm verify` green on the commit (CI).
2. Backups verified within the last day (`recovery.md`).
3. Migrations applied as the owner.
4. API rolled, readiness green; then the portal.
5. Smoke: sign in, open the dashboard, `GET /api/v1/licensing/public-keys`, and one product's
   entitlement request with its credential.
