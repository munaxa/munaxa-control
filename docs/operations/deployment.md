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
- **A rate rule at the front door as well.** The API limits each client per process (ADR-0007);
  with several replicas the front door's per-address rule is the outer bound. Set
  `TRUST_PROXY_HOPS` to the number of proxies in front so the API counts clients, not the balancer.

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
| `portal`  | the Next.js standalone server as `node` | `CONTROL_API_URL`, `PORT` (3200), `OPERATOR_ACCESS_TEAM_DOMAIN`, `OPERATOR_ACCESS_AUDIENCE`. No secret                                                                                                                             |

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
| `OPERATOR_SUBJECT_ALLOWLIST`                                                   | Identity subjects allowed to operate; required in production while MFA is off  |
| `OPERATOR_ACCESS_TEAM_DOMAIN`, `OPERATOR_ACCESS_AUDIENCE`                      | Cloudflare Access; required in production (below)                              |
| `LICENCE_SIGNING_PRIVATE_KEY_FILE`                                             | A mounted secret file, mode 0400 (`licence-signing.md`)                        |
| `LICENCE_SIGNING_KID`, `LICENCE_PREVIOUS_PUBLIC_KEYS`, `LICENCE_MAX_TERM_DAYS` | `licence-signing.md`                                                           |
| `ENTITLEMENT_CACHE_SECONDS`                                                    | 30 — how long products may reuse an answer                                     |
| `IDEMPOTENCY_RETENTION_HOURS`                                                  | 48                                                                             |
| `TRUST_PROXY_HOPS`                                                             | `1` behind one load balancer; `0` (default) trusts no `X-Forwarded-For`        |
| `RATE_LIMIT_PER_MINUTE`, `SERVICE_RATE_LIMIT_PER_MINUTE`                       | 600 per address, 6 000 per product credential (ADR-0007)                       |
| `AUTH_FAILURE_LIMIT_PER_MINUTE`                                                | 20 refused credentials per address before it is refused for the minute         |

Probes: liveness `GET /health/live`, readiness `GET /health/ready` (the database answers). Logs are
JSON lines on stdout (pino) with the request id; authorization headers and secrets are redacted.

Run at least two instances; the API is stateless and every cross-request guarantee (idempotency,
versions) is in the database.

## The sweep

`node apps/api/dist/sweep.js` records the status moves term dates have already made (trial ended,
term ended, grace ended) in the subscription history. Products never depend on it — each snapshot's
status is computed from dates at the moment it is served — but the portal's lists, reports and the
audit trail do. It also deletes idempotency records older than `IDEMPOTENCY_RETENTION_HOURS`
(ADR-0004). Run it **hourly** from the platform scheduler (a cron job or scheduled task with the
API's image and environment); it is idempotent and safe to overlap. It exits non-zero on failure:
alert on that.

## The portal

Build `pnpm --filter @control/portal build`; run the standalone server
`node apps/portal/.next/standalone/apps/portal/server.js` (not `next start`), with
`CONTROL_API_URL` (the API's private URL), `PORT`, `NODE_ENV=production` and the same
`OPERATOR_ACCESS_TEAM_DOMAIN` and `OPERATOR_ACCESS_AUDIENCE` as the API. It holds no secret and no
state. Point the load balancer health check at `GET /healthz`: every other path, assets included,
answers 401 without a Cloudflare Access token.

## Cloudflare Access

The operator console sits behind a Cloudflare Access self-hosted application (testing:
`operator-test.munaxa.com`). Access signs a JWT for every request it lets through and sends it in
`Cf-Access-Jwt-Assertion`. Both the portal (its middleware) and the API (every operator route)
verify it: RS256 against the keys at `<team domain>/cdn-cgi/access/certs`, the team domain as
`iss`, the application's AUD tag in `aud`, `exp`, `nbf` and `iat` within the clock skew, `type`
`app`, and an `email` and `sub` (a service token is not an operator). The portal forwards the
header with each API call, licence and revocation-list downloads included.

- It fails closed: no token, a bad one, or keys that cannot be read give 401 or 503, never a page.
  In production the processes refuse to run open: the API stops at startup and the portal answers
  503 without both values.
- It adds to Identity, never replaces it: the Identity token, the operator organisation, the
  subject allow-list and route permissions are still checked. Product routes and `/health/*` do not
  go through Access; they keep their own credentials.
- Configure, in Cloudflare Zero Trust: a self-hosted application on the operator hostname covering
  every path (no bypass policy), an Allow policy naming the operators' emails, a short session
  duration, and no service-token policy. Copy the team domain
  (`https://<team>.cloudflareaccess.com`) and the application's AUD tag into both services.
- The origin must not be reachable round Access: keep the ALB rule limited to Cloudflare's ranges
  or behind a tunnel; the token check is the second line, not the only one.

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

## On AWS (shared stack, not yet applied)

The shared AWS stack in `munaxa-platform/infra/aws` (draft) hosts Control in `eu-central-1`:

| Here                     | There                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Images                   | `.github/workflows/publish-images.yml` pushes `api`, `migrate` and `portal` to ECR on an `image/<sha>` tag             |
| `control-api.munaxa.com` | ALB host rule to the API; `/api/v1/admin/*` answers 403 there                                                          |
| Operator front door      | `operator-test.munaxa.com` behind Cloudflare Access: `/api/auth/*` to Identity, the rest to the portal                 |
| `CONTROL_API_URL`        | `http://control-api.<env>.munaxa.internal:3100` (Cloud Map), reachable from the portal only                            |
| Signing key              | `LICENCE_SIGNING_BACKEND=KMS` with a P-256 KMS key (ADR-0008, proposed)                                                |
| Database                 | `control` on the shared PostgreSQL 16 instance; `control_owner` in the migrate bundle, `control_app` in the API bundle |
| Release job              | The `control-migrate` task, run before each new API version                                                            |
| Sweep                    | An hourly EventBridge Scheduler task in production                                                                     |
| `TRUST_PROXY_HOPS`       | `1` (the ALB)                                                                                                          |
