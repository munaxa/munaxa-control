# ADR-0003 — Licence signing: one private key, in this process only

**Status** Accepted · **Date** 2026-10-26 · **Approval** Pending review
**Relates to** munaxa-platform ADR-0022 (`mxl1`, ES256/RS256 only)

## Decision

1. **One active signing key**, ES256 by default, identified by `LICENCE_SIGNING_KID`. Its private
   half is a file mounted at `LICENCE_SIGNING_PRIVATE_KEY_FILE` — never an environment variable,
   never an image layer, never the database, never a response or a log, never the portal, a product
   repository or an installation. Startup refuses a missing or unreadable file, and refuses a
   private key anywhere a public key is expected.
2. **Public keys are public**: `GET /api/v1/licensing/public-keys` lists the current key and
   `LICENCE_PREVIOUS_PUBLIC_KEYS`, which installations still trust during a rotation.
3. **Licences are short and bounded**: at most the subscription's end and `LICENCE_MAX_TERM_DAYS`;
   30 days for a licence bound to no installation. Revocation is recorded and stops renewal; an
   offline installation cannot learn of it, which is why terms are short.
4. **Rotation is additive**: a new key is generated, its predecessor's public key moves to
   `LICENCE_PREVIOUS_PUBLIC_KEYS`, installations receive the new public key before they receive a
   licence signed with it, and the old public key is dropped once no licence signed with it is
   still valid. The procedure is `docs/operations/licence-signing.md`.

## Consequences

- Losing the private key without a backup means re-keying every installation at its next renewal;
  it is backed up offline under two-person control (`docs/operations/recovery.md`).
- A compromised key is rotated at once, and every installation's public-key list is replaced, not
  extended.

## Alternatives considered

- **A KMS-held key signing remotely** — the right end state, and compatible: the signer is one
  interface. Deferred until the deployment platform is chosen and the owner authorises it.
- **HMAC** — a verifier holding the key could mint licences. Refused by the contract at both ends.
