# Munaxa Control — API reference

Base path `/api/v1` for everything except the probes. JSON in and out. Every response carries an
`x-request-id` (the caller's, when it sent a well-formed one, otherwise a new one), and every log
line for that request carries it too.

## Conventions

**Errors** are RFC 7807 problem documents, `application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "CONFLICT",
  "status": 409,
  "code": "INVALID_TRANSITION",
  "detail": "A SUSPENDED subscription cannot RENEW.",
  "issues": ["…"]
}
```

`code` is stable and is what a client branches on; `detail` is for people. A `5xx` never carries a
detail — the cause is in the log under the request id.

| Code                          | Status | Meaning                                                                           |
| ----------------------------- | ------ | --------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`           | 422    | The body, query or path failed its schema; `issues` lists each failure            |
| `NOT_FOUND`                   | 404    | No such record — or one this caller may not know exists                           |
| `DUPLICATE`                   | 409    | A unique key is taken (a plan code, a tenant already linked, a deployment name)   |
| `RULE_VIOLATED`               | 409    | A database rule refused the change (a check constraint, the plan-version trigger) |
| `VERSION_CONFLICT`            | 409    | `expectedVersion` is stale: someone else changed the record. Read it again        |
| `INVALID_TRANSITION`          | 409    | The lifecycle (or a plan version's state) does not allow that move from here      |
| `SUBSCRIPTION_EXISTS`         | 409    | The tenant already has a subscription that is not cancelled                       |
| `PLAN_VERSION_NOT_PUBLISHED`  | 409    | Only a published version can be sold or moved to                                  |
| `PLAN_VERSION_FROZEN`         | 409    | Published and retired terms never change; draft a new version                     |
| `CUSTOMER_CLOSED`             | 409    | A closed customer takes no new tenants or subscriptions                           |
| `NO_CHANGE`                   | 409    | The request would change nothing (the same plan version, say)                     |
| `SUBSCRIPTION_NOT_LICENSABLE` | 409    | Licences are for on-premises tenants on a live subscription                       |
| `SUBSCRIPTION_HAS_NO_END`     | 409    | A licence needs an end; give the subscription or the licence one                  |
| `INSTALLATION_NOT_ACTIVE`     | 409    | The installation was replaced, or belongs to another tenant                       |
| `INSTALLATION_TAKEN`          | 409    | That installation reference is registered to another tenant                       |
| `LICENCE_REVOKED`             | 409    | The licence is already revoked                                                    |
| `INVALID_IDEMPOTENCY_KEY`     | 400    | `Idempotency-Key` must be 8–128 URL-safe characters                               |
| `IDEMPOTENCY_KEY_REUSED`      | 409    | The key was used for a different request                                          |
| `REQUEST_IN_PROGRESS`         | 409    | The first request with this key has not answered yet — retry shortly              |
| `UNAUTHORIZED`                | 401    | No token or credential, or one that does not verify                               |
| `FORBIDDEN`                   | 403    | Authenticated, but without the permission this route declares                     |

**Idempotency.** Every mutating request may carry `Idempotency-Key`. The key is _claimed before the
request runs_, atomically: a duplicate while the first runs gets `409 REQUEST_IN_PROGRESS`; once the
first has answered, the same key and body replays that answer with `Idempotent-Replay: true`; the
same key with a different body is `409 IDEMPOTENCY_KEY_REUSED`. A request whose action fails
releases its key; one whose action succeeded never does. Keys are scoped per caller and kept for
`IDEMPOTENCY_RETENTION_HOURS`. The portal sends one with every form.

**Optimistic concurrency.** Customers and subscriptions carry `version`; changes send
`expectedVersion` and get `409 VERSION_CONFLICT` when it is stale. Nothing is ever overwritten
blind.

**Paging.** The customer list takes `limit` (1–200, default 50) and `offset` and answers
`{ "items": [...], "total", "limit", "offset" }`; the subscription and tenant lists take the same
parameters and answer an array, as do the deployment and plan lists (whole, filtered by `product`).
The audit list pages by `before` (an audit id) instead.

**Money.** Prices are integer minor units (`priceMinor: 9900` with `currency: "JOD"` is 99.00 JOD).
They are informational: nothing in this service charges anybody.

## Authentication

Three audiences, and a route belongs to exactly one. A route that declares none is refused.

| Audience  | Credential                                             | Checked                                                                                                                                                                                                |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public    | none                                                   | `/health/*`, `/api/v1/licensing/public-keys` only                                                                                                                                                      |
| Operators | `Authorization: Bearer <Munaxa Identity access token>` | ES256 signature with Identity's **public** key, `iss`, `aud`, expiry; `tid` must be `OPERATOR_ORGANISATION_ID`; `mfa` when `OPERATOR_REQUIRE_MFA`; then the route's `control:` permission from `perms` |
| Products  | `Authorization: Bearer mxc_<credentialId>_<secret>`    | The credential's SHA-256 against the stored hash, in constant time; not revoked; and the path's `{product}` must be the credential's deployment's product                                              |

Operator permissions (seeded into Identity from `artifacts/control-permissions.json`):

| Permission                                                   | Grants                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `control:customers:read` / `control:customers:write`         | Customers and their tenant links                                         |
| `control:catalogue:read` / `control:catalogue:write`         | Deployments, plans and plan versions                                     |
| `control:credentials:manage`                                 | Issuing and revoking product service credentials                         |
| `control:subscriptions:read` / `control:subscriptions:write` | Subscriptions, lifecycle, plan changes, overrides; dashboard and reports |
| `control:licences:issue`                                     | Installations, licences, activations, revocations, downloads             |
| `control:usage:read`                                         | Reported usage                                                           |
| `control:audit:read`                                         | The audit trail                                                          |

## Public

| Route                               | Answer                                                                                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`                  | `200 {"status":"ok"}` while the process runs                                                                                                                           |
| `GET /health/ready`                 | `200` when the database answers, `503` otherwise                                                                                                                       |
| `GET /api/v1/licensing/public-keys` | `{ "keys": [{ "kid", "algorithm", "publicKey", "current" }] }` — the current and previous licence-signing **public** keys, for an installation's `LICENSE_PUBLIC_KEYS` |

## Products

### `GET /products/{product}/tenants/{tenantId}/entitlements`

`{product}` is `school`, `work` or `docs`; `{tenantId}` is the product's own tenant identifier.

- `200` with an `EntitlementSnapshot` (`@munaxa/licensing`, `schemaVersion: 1`): customer,
  tenant, product, deployment, subscription id, plan code and version, `status` (after term dates),
  `trialEndsAt`, `expiresAt`, `graceUntil`, `features` (plan plus overrides, sorted), `limits`
  (`null` = unlimited; a key not listed is 0) and `resolvedAt`. A **cancelled** tenant gets its
  `CANCELLED` snapshot, which the contract maps to export-only — never a 404, because a product
  reads a 404 as "nothing at all" and a customer keeps access to its own records.
- `404` when there is no subscription for this tenant **reachable with this credential**: a tenant
  linked to another deployment, or to another product, reads exactly like one that does not exist.
- `Cache-Control: private, max-age=ENTITLEMENT_CACHE_SECONDS` and a strong `ETag`; send
  `If-None-Match` to get `304`.

### `POST /products/{product}/usage`

```json
{
  "reports": [
    {
      "tenantId": "…",
      "metric": "users",
      "value": 42,
      "measuredAt": "2026-10-26T14:00:00.000Z",
      "installationId": "optional"
    }
  ]
}
```

1–500 points. Each is a **level** at an instant, idempotent on (tenant, metric, measuredAt).
Answers `200 { "accepted", "duplicates", "rejected" }`. A point for a tenant outside the credential's
deployment is counted as rejected and not stored, without saying whether the tenant exists. Usage
is informational: products enforce their own limits.

## Operators

Lists accept the paging parameters above. Every change is audited in the same transaction.

### Customers and tenants

| Route                                | Permission      | Body / query                                                                                                  |
| ------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------- |
| `GET /admin/customers`               | customers:read  | `search`, `status` (`ACTIVE`/`CLOSED`)                                                                        |
| `POST /admin/customers`              | customers:write | `name`, `legalName?`, `country?` (ISO alpha-2), `contactEmail?`                                               |
| `GET /admin/customers/{id}`          | customers:read  | — with its tenants, each with its deployment, subscriptions and installations                                 |
| `PATCH /admin/customers/{id}`        | customers:write | `expectedVersion`, any of the create fields, `status?`. Closing never deletes anything                        |
| `POST /admin/customers/{id}/tenants` | customers:write | `product`, `tenantRef`, `deploymentType` (`SAAS` needs `deploymentId`; `ON_PREMISES` has none), `displayName` |
| `GET /admin/tenants`                 | customers:read  | `product`, `search`                                                                                           |

### Catalogue

| Route                                       | Permission         | Body                                                                                                                                        |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/deployments`                    | catalogue:read     | `product?`                                                                                                                                  |
| `POST /admin/deployments`                   | catalogue:write    | `product`, `name` (lowercase, digits, hyphens)                                                                                              |
| `POST /admin/deployments/{id}/credentials`  | credentials:manage | `label`. Answers the credential **once**: `{ id, token }`. Only its SHA-256 is stored                                                       |
| `POST /admin/credentials/{id}/revoke`       | credentials:manage | — refused from the next request                                                                                                             |
| `GET /admin/plans`, `GET /admin/plans/{id}` | catalogue:read     | `product?`                                                                                                                                  |
| `POST /admin/plans`                         | catalogue:write    | `product`, `code` (a key), `name`, `description?`                                                                                           |
| `POST /admin/plans/{id}/versions`           | catalogue:write    | a new **draft**: `features[]`, `limits{}`, `priceMinor?`, `currency?`, `billingPeriod?` (`MONTHLY`/`YEARLY`/null), `trialDays`, `graceDays` |
| `PUT /admin/plan-versions/{id}`             | catalogue:write    | the same terms; drafts only (`PLAN_VERSION_FROZEN` otherwise)                                                                               |
| `POST /admin/plan-versions/{id}/publish`    | catalogue:write    | freezes the terms for ever (enforced by a database trigger too)                                                                             |
| `POST /admin/plan-versions/{id}/retire`     | catalogue:write    | no new sales; existing subscribers keep it                                                                                                  |

### Subscriptions

| Route                                        | Permission          | Body                                                                                                                                                                                                                          |
| -------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/subscriptions`                   | subscriptions:read  | `product`, `status`, `customerId`, `expiringBefore`                                                                                                                                                                           |
| `GET /admin/subscriptions/{id}`              | subscriptions:read  | — with terms, overrides, licences and history                                                                                                                                                                                 |
| `POST /admin/subscriptions`                  | subscriptions:write | `tenantLinkId`, `planVersionId` (published), `start` (`TRIAL`/`ACTIVE`), `startsAt?`, `expiresAt?`, `reason?`                                                                                                                 |
| `POST /admin/subscriptions/{id}/transitions` | subscriptions:write | `event` (`ACTIVATE`, `MARK_PAST_DUE`, `ENTER_GRACE`, `EXPIRE`, `RENEW`, `SUSPEND`, `REACTIVATE`, `CANCEL`), `expectedVersion`, `expiresAt?` (for `RENEW`), `reason?` (kept in the history; the portal asks for one to cancel) |
| `POST /admin/subscriptions/{id}/plan`        | subscriptions:write | `planVersionId`, `expectedVersion`, `reason?` — the term is unchanged                                                                                                                                                         |
| `PUT /admin/subscriptions/{id}/overrides`    | subscriptions:write | `expectedVersion`, `features: {add[], remove[]}`, `limits{}`, `reason`                                                                                                                                                        |

The lifecycle is the shared contract's: cancellation is terminal; suspension is reversible and
`REACTIVATE` returns to the state it interrupted; expiry is renewable. Only the events the current
status allows are accepted (`INVALID_TRANSITION` otherwise).

### Licences and installations (on premises)

| Route                                     | Permission         | Body                                                                                                                                                  |
| ----------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /admin/tenants/{id}/installations`   | subscriptions:read | —                                                                                                                                                     |
| `POST /admin/tenants/{id}/installations`  | licences:issue     | `installationRef`                                                                                                                                     |
| `POST /admin/subscriptions/{id}/licences` | licences:issue     | `installationRef` (or `null` for an unbound licence, at most 30 days), `expiresAt?` — capped at the subscription's end and at `LICENCE_MAX_TERM_DAYS` |
| `POST /admin/activations`                 | licences:issue     | `code`: an activation request an installation produced (`ACTIVATION`, `RENEWAL` or `SERVER_REPLACEMENT`). Answers the issued licence                  |
| `POST /admin/licences/{id}/revoke`        | licences:issue     | `reason`. Recorded, and refused for renewal; an offline installation keeps the licence until it ends                                                  |
| `GET /admin/licences/{id}/download`       | licences:issue     | the armoured `mxl1` licence file                                                                                                                      |

### Reports and audit

| Route                                   | Permission         | Query                                                               |
| --------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| `GET /admin/dashboard`                  | subscriptions:read | — counts by status and product, ending soon                         |
| `GET /admin/reports/expiring`           | subscriptions:read | `days` (1–365, default 30)                                          |
| `GET /admin/reports/overdue`            | subscriptions:read | — past due, in grace, expired                                       |
| `GET /admin/tenants/{id}/usage`         | usage:read         | — latest value of each metric beside the plan ceiling               |
| `GET /admin/tenants/{id}/usage/history` | usage:read         | `metric`, `limit` (≤ 500)                                           |
| `GET /admin/audit`                      | audit:read         | `customerId`, `subscriptionId`, `action`, `before`, `limit` (≤ 200) |
