# Munaxa Control

The Munaxa Group control plane: one place to manage customers, product subscriptions, plans,
licences and usage for **Munaxa School**, **Munaxa Work** and **Munaxa Docs**.

It is a peer of the products, not part of any of them. It is authoritative for SaaS subscriptions
and for on-premises licence issuance; each product still enforces its own features and quotas, and
its own permissions and tenant isolation, against what this service tells it.

```text
              Munaxa Identity ── signs operator tokens (public key here)
                     │
   Super Admin portal ──► Control API ──► PostgreSQL (control)
                              │
      ┌───────────────────────┼────────────────────────┐
      ▼                       ▼                        ▼
 Munaxa Docs            Munaxa School             Munaxa Work
 GET …/entitlements     GET …/entitlements        GET …/entitlements
 POST …/usage           (or a signed licence      (or a signed licence
                         file, on premises)        file, on premises)
```

## What crosses, and what never does

| Crosses                                                                       | Never crosses                                               |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| An Identity access token (operators), verified with Identity's **public** key | A password, a session, any authentication record            |
| A service credential per product deployment (`mxc_…`)                         | A product's data, or a tenant's records                     |
| An `EntitlementSnapshot` from `@munaxa/licensing`                             | The licence **private** key — it lives in this process only |
| A signed licence file (`mxl1`) for an on-premises installation                | Payment details — nothing here collects payment             |

## The API

Every route is under `/api/v1`, except the probes.

| Audience                                           | Routes                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public                                             | `GET /health/live`, `GET /health/ready`, `GET /api/v1/licensing/public-keys`                                                                                                                                                                    |
| Products (service credential)                      | `GET /products/{product}/tenants/{tenantId}/entitlements`, `POST /products/{product}/usage`                                                                                                                                                     |
| Operators (Identity token + `control:` permission) | `/admin/customers`, `/admin/tenants`, `/admin/deployments`, `/admin/credentials`, `/admin/plans`, `/admin/plan-versions`, `/admin/subscriptions`, `/admin/activations`, `/admin/licences`, `/admin/dashboard`, `/admin/reports`, `/admin/audit` |

The full contract, with every endpoint, status and error code: [`docs/api.md`](./docs/api.md).
Product integration contracts: [`docs/integration.md`](./docs/integration.md).

## Running it

```bash
pnpm install                         # needs read:packages on the munaxa org (see .npmrc)
psql "$ADMIN_URL" -f infra/sql/roles.sql
createdb -O control_owner control
DATABASE_MIGRATION_URL=postgresql://control_owner@…/control pnpm db:migrate
pnpm prisma:generate
pnpm keys:generate --out deploy/secrets/licence_signing_private_key.pem --kid licence-dev-1
cp .env.example .env                 # then fill it in
pnpm --filter @control/api dev
```

Tests run against a real database as the runtime role:

```bash
TEST_DATABASE_URL=postgresql://control_app@…/control_test \
TEST_DATABASE_MIGRATION_URL=postgresql://control_owner@…/control_test pnpm test
```

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — boundaries, and why each one is where it is
- [`docs/adr/`](./docs/adr) — decisions
- [`docs/api.md`](./docs/api.md) — every endpoint, permission and error code
- [`docs/integration.md`](./docs/integration.md) — how School, Work and Docs integrate, and the contract each keeps
- [`docs/operations/`](./docs/operations) — [deployment](./docs/operations/deployment.md),
  [secrets](./docs/operations/secrets.md), [licence signing and key rotation](./docs/operations/licence-signing.md),
  [backups and recovery](./docs/operations/recovery.md)

## Status

Not deployed, and nothing published. Depends on `@munaxa/licensing@0.1.0`, which is not yet
published; until it is, `pnpm install --frozen-lockfile` fails here and in CI.
