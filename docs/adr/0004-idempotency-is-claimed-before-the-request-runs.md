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

## Consequences

- Concurrent duplicates are tested: ten simultaneous requests under one key create one subscription.
- A crash between the action and recording its answer leaves the key unusable until it expires; the
  action itself is visible in the audit trail.
