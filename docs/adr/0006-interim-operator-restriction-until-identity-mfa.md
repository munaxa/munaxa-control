# ADR-0006 — An interim operator restriction until Munaxa Identity issues MFA

**Status** Accepted · **Date** 2026-10-27 · **Approval** Pending review
**Relates to** ADR-0002, Munaxa Identity ADR-0003 (MFA deferred)

## Context

Operators are the most privileged users in the group: they suspend customers, issue product
credentials and sign licences. The control plane was built to require a satisfied second factor
(`OPERATOR_REQUIRE_MFA`, the token's `mfa` claim). Munaxa Identity does not yet issue it: its
ADR-0003 defers MFA, sessions are created with `mfaSatisfied: false`, and no access token carries
`mfa: true`. Requiring it today would lock every operator out; not requiring it leaves one factor
between an Identity role grant and the control plane.

## Decision

Until Identity issues `mfa`, three restrictions apply, and the first two hold after it does too:

1. **A token must belong to an Identity session** (`sid`). A token minted without one — a machine
   token, a token from a flow that bypasses sessions — is refused. A session is what Identity can
   revoke, which a bare access token is not.
2. **A deployment-level allow-list of operator subjects**, `OPERATOR_SUBJECT_ALLOWLIST`. A person
   must be named in this deployment's configuration _and_ hold the `control:` permission in the
   Munaxa Group organisation. A role granted by mistake in Identity — or by a compromised Identity
   administrator — does not by itself open the control plane. Refusals are logged by subject.
3. **Production refuses to start** with `OPERATOR_REQUIRE_MFA=false` and an empty allow-list.

When Identity ships MFA: set `OPERATOR_REQUIRE_MFA=true` (the guard already checks the claim). The
allow-list may then be emptied, though keeping it costs nothing.

Operational controls that belong in front of the service, not in it, and are part of the deployment
runbook: the operator front door reachable only from Munaxa Group's network or VPN, and Identity's
12-hour absolute session deadline and lockout.

## Consequences

- Adding an operator is two changes, in Identity and in this deployment's configuration, and a
  restart. That friction is the point while there is one factor.
- A token-age check for sensitive actions was considered and not built: refreshed access tokens
  carry a new `iat`, so token age says nothing about when the person last authenticated.
