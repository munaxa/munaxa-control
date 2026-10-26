# Munaxa Control — architecture rules

## Dependency direction

```text
munaxa-platform ──► munaxa-control
```

That is the only code edge. This repository never imports Munaxa School, Work, Docs or Identity,
and none of them imports it. What crosses between them is HTTP, a signed token, a public key and
the shared `@munaxa/licensing` contract.

## What this service owns

Customers; which product tenants each holds; product deployments and their service credentials;
plans and their immutable versions; subscriptions and their history; licence issuance and
installation registration; reported usage; and its own audit trail.

## What it does not own

| Not here                                      | Where                                                                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts, passwords, sessions, roles          | Munaxa Identity. Operators sign in there; this service verifies the token with Identity's public key and could not mint one.                                     |
| A product's data, users, documents or records | The product. This service never reaches a product database.                                                                                                      |
| Enforcement                                   | The product. It evaluates the snapshot it is given through `@munaxa/licensing`; a subscription never bypasses the product's own permissions or tenant isolation. |
| Payment collection                            | Nobody yet. Prices are informational; nothing here charges anything.                                                                                             |

## Boundaries enforced in code

1. **Two audiences, never crossed.** Every controller declares `@ForOperators()` or
   `@ForServices()`. Operator routes read only an Identity access token; service routes read only a
   service credential. A controller that declares neither is refused.
2. **Operators are Munaxa Group staff.** The token's organisation must be `OPERATOR_ORGANISATION_ID`,
   and every operator route names the `control:` permission it requires. Wildcards and other
   products' namespaces confer nothing.
3. **A service credential sees its own deployment's tenants only.** The product in the path, the
   tenant's product and the credential's deployment must all agree, or the answer is the same `404`
   as a tenant that does not exist.
4. **The private signing key exists in this process only**, read from a mounted file. It is never in
   a response, a log, the portal, the database, a product repository or an installation.
5. **Nothing is deleted.** The runtime role has no `DELETE` on any business table; the audit trail,
   subscription history and usage are append-only by grant; published plan versions are immutable
   by trigger.

## Layout

```text
apps/api/       NestJS API: auth, customers, catalogue, subscriptions, entitlements, licensing, usage
apps/portal/    Next.js Super Admin portal, behind the same front door as Identity
prisma/         schema and migrations — this service's database, shared with no one
infra/sql/      cluster roles and runtime grants
scripts/        migrate, grants, key generation, permission catalogue
artifacts/      control-permissions.json, for Identity to seed roles from
```
