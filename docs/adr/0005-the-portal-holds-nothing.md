# ADR-0005 — The portal holds nothing, and is English-only

**Status** Accepted · **Date** 2026-10-26 · **Approval** Pending review

## Decision

1. **A thin Next.js console.** Server components read, server actions write, each a typed call to
   the control API carrying the operator's own Identity token, read server-side from the host-only
   `__Host-mx_session` cookie. No database, no secret, no cached authority: the API authenticates,
   authorises and audits every request.
2. **Navigation is filtered by the token's permissions for display only.** Hiding a link is a
   courtesy; the API refuses what it would have hidden.
3. **One-time secrets are shown once.** A new service credential is displayed in the response to
   the action that issued it and is never retrievable again.
4. **Every form carries an `Idempotency-Key`** minted when the form is drawn (ADR-0004).
5. **English-only.** Its users are Munaxa Group operators, not customers; every customer-facing
   surface remains bilingual in its product. Dates are shown in UTC with the zone named.
6. **Security headers and `Cache-Control: private, no-store`** on every response.

## Consequences

- The portal cannot be pointed at an API it was not deployed with (`CONTROL_API_URL` is server-side).
- An Arabic interface, if ever needed, is a translation of a small surface rather than a redesign.
