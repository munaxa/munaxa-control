# ADR-0002 — Operators through Munaxa Identity; products through deployment-bound credentials

**Status** Accepted · **Date** 2026-10-26 · **Approval** Pending review

## Context

Two kinds of caller, with nothing in common: Munaxa Group staff in a browser, and product
deployments calling server to server. The brief forbids storing passwords here, and requires that a
client can never choose an arbitrary tenant or product.

## Decision

1. **Every controller declares one audience**, `@ForOperators()` or `@ForServices()`; a global guard
   refuses a route that declares neither. A token for one audience is never read on the other's
   routes.
2. **Operators sign in to Munaxa Identity.** This service holds Identity's **public** key and
   verifies its ES256 access tokens (`iss`, `aud = munaxa-control`, expiry, signature). The token's
   organisation must be `OPERATOR_ORGANISATION_ID` (Munaxa Group), and each route names one
   `control:` permission the token's `perms` must hold. No password, session or account exists
   here. MFA is required by `OPERATOR_REQUIRE_MFA`, off until Identity ships MFA.
3. **The permission catalogue is published** as `artifacts/control-permissions.json`, which
   Identity seeds roles from — the same arrangement as Work's catalogue.
4. **Products present `mxc_<credentialId>_<secret>`**, issued per **deployment** in the portal and
   shown once. Only its SHA-256 is stored, compared in constant time. The credential's deployment
   fixes the product and the set of tenants: the path's `{product}`, the tenant's product and the
   credential's deployment must agree, or the answer is the same `404` as a tenant that does not
   exist. Revocation takes effect at the next request.

## Consequences

- The portal must sit behind the same front door as Identity, so Identity's host-only session
  cookie reaches it (Identity ADR-0004); see `docs/operations/deployment.md`.
- Rotating a product credential is: issue a new one, deploy it, revoke the old.
- An operator's permissions change in Identity, not here.

## Alternatives considered

- **Local operator accounts** — a second password store for the most privileged users in the group.
- **One credential per product** — a leaked credential for one region would read every customer of
  that product.
