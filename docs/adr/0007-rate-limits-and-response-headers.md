# ADR-0007 — Rate limits, failed-authentication lockout and response headers

**Status** Accepted · **Date** 2026-10-28 · **Approval** Pending review
**Relates to** ADR-0002 (credentials), ADR-0006 (interim operator restriction)

## Context

The API had no abuse protection of its own. Two routes face the internet (`/api/v1/products/*`
and the licence public keys), and every route accepts a bearer credential that is checked against
Identity's keys or the database on each request. Nothing stopped a client from guessing service
credentials at line rate, or from spending the database on requests that would be refused anyway.

## Decision

1. **Requests per client per minute** (`RATE_LIMIT_PER_MINUTE`, default 600) on every route but
   `/health/*`. A client is its address, except a request presenting a well-formed service
   credential, which counts against that credential (`SERVICE_RATE_LIMIT_PER_MINUTE`, default
   6 000): one product deployment's tenants arrive from one egress address, and must neither
   starve each other nor share a budget with strangers behind the same NAT.
2. **Failed authentications per address per minute** (`AUTH_FAILURE_LIMIT_PER_MINUTE`, default
   20). Every credential the authentication guard refuses counts; past the limit, every request
   from that address is refused for the rest of the window, valid credential or not. Counting by
   address is what makes inventing a fresh credential id per guess useless.
3. **The limiter runs first**, before the authentication guard, so a refused client costs no token
   verification and no query. Refusals are `429` with `Retry-After` and a stable code
   (`RATE_LIMITED`, `TOO_MANY_FAILED_ATTEMPTS`).
4. **The client address is `req.ip` under `trust proxy = TRUST_PROXY_HOPS`** (default 0). Behind one
   load balancer it is `1`. `X-Forwarded-For` is never read directly: a client can write it.
5. **Every answer carries these headers**, in production also `Strict-Transport-Security`:
   - `Cache-Control: no-store`, unless the route sets its own (the entitlement answer is
     `private, max-age`);
   - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`;
   - `Cross-Origin-Resource-Policy: same-origin`;
   - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`.
6. **The operator portal sends its own policy**, per request around a fresh nonce
   (`apps/portal/src/lib/csp.ts`, set in `middleware.ts`): scripts run only with the nonce
   (`'strict-dynamic'`, never `'unsafe-inline'` or, outside the dev server, `'unsafe-eval'`), and
   `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `connect-src 'self'`,
   `frame-ancestors 'none'`. Every page renders per request so every response can carry its nonce.
   Checked against a production build in Chromium: an inline script, an external script and an
   inline event handler injected into the HTML were all refused, and the application still ran.

The limiter is in-process, written here rather than added as a dependency: fixed one-minute
windows on the injected clock, so tests move time instead of waiting, with at most 50 000 tracked
clients per window — past that it refuses clients it has not seen rather than grow.

## Consequences

- **Per process.** With N replicas a client gets up to N times the budget. The front door's own
  rate rule (WAF or load balancer) is the outer bound and is required in production
  (`docs/operations/deployment.md`); this is the inner one, which holds even if that rule is
  misconfigured.
- A product whose entitlement and usage traffic exceeds 6 000 requests a minute per credential
  needs the limit raised, or more credentials; at the documented one request per tenant per
  minute that is 6 000 tenants on one deployment.
- A shared office address can lock its own operators out for up to a minute by repeatedly failing
  to sign in. That is the intended trade.
- Tested in `control-plane.e2e.spec.ts` ("abuse protection"), and the tests fail if the guard is
  unregistered.
