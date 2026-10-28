# ADR-0004 — Idempotency is claimed before the request runs

**Status** Accepted · **Date** 2026-10-26 · **Approval** Pending review

## Context

A licence issued twice, or a subscription created twice, is a real mistake. Browsers double-submit,
networks retry, operators click again.

## Decision

1. Any mutating request may carry `Idempotency-Key`, scoped to the caller.
2. The key is **claimed before the handler runs**, by inserting its row; the primary key decides the
   race atomically across processes. A duplicate meanwhile gets `409 REQUEST_IN_PROGRESS`; after the
   first answers, the same key and body replays the stored answer (`Idempotent-Replay: true`); the
   same key with another body is `409 IDEMPOTENCY_KEY_REUSED`.
3. **A failed action releases the key**, so it can be retried and succeed. **A successful action
   never does**: if recording its answer fails, the key stays in progress until it expires rather
   than let a retry run the action again. (A browser smoke run found the opposite ordering; it is
   fixed and tested.)
4. Records expire after `IDEMPOTENCY_RETENTION_HOURS`, judged by the application clock that stamped
   them.
5. Separately, changes to customers and subscriptions carry `expectedVersion`.
6. **A secret is never stored for replay.** A handler marked `@WithholdsSecret()` (credential
   issuance) records `{ secretWithheld: true, id }` in place of its answer, and a retry under its key
   is `409 SECRET_NOT_REPLAYED` naming that `id`. A pre-release review found the earlier behaviour
   kept every issued credential's token in plaintext in `idempotency_record`; the
   `20261027100000_withhold_secrets` migration rewrites any such record to the withheld shape.
7. Expired records are deleted by the sweep, not only when their key is next used, so nothing an
   answer held outlives retention.

## Consequences

- Concurrent duplicates are tested: ten simultaneous requests under one key create one subscription.
- A crash between the action and recording its answer leaves the key unusable until it expires; the
  action itself is visible in the audit trail.
- A credential whose first answer was lost in transit cannot be recovered by retrying; it is revoked
  and replaced. That is the price of the token existing only in the caller's hands.
