# Licence signing and key rotation

Design: `docs/adr/0003-licence-signing-key-custody-and-rotation.md`.

## Generate a key

On a trusted machine, never in a shared session:

```bash
pnpm keys:generate --out /secure/licence-2026-11.pem --kid licence-2026-11
```

ECDSA P-256 (ES256). The private key is written with mode 0600 and never printed; the public key
and kid are printed. Store the private key in the secret store (`secrets.md`) and an **offline
backup** under two-person control (`recovery.md`). The script refuses to overwrite an existing file.

Configure the API:

```bash
LICENCE_SIGNING_PRIVATE_KEY_FILE=/run/secrets/licence_signing_private_key.pem
LICENCE_SIGNING_KID=licence-2026-11
LICENCE_SIGNING_ALGORITHM=ES256
LICENCE_PREVIOUS_PUBLIC_KEYS=[]
```

## What installations hold

`LICENSE_PUBLIC_KEYS` — the JSON list from `GET /api/v1/licensing/public-keys`, public keys only.
An installation verifies licences and can never sign one.

## Rotate (planned, yearly)

1. Generate the new key (`licence-2027-11`).
2. **Distribute first.** Add the new public key to every installation's `LICENSE_PUBLIC_KEYS`
   alongside the current one — with their next renewal, or by a maintenance contact. An installation
   that does not yet trust the new key refuses a licence signed with it.
3. Switch the API: the new file and `LICENCE_SIGNING_KID`; move the old public key into
   `LICENCE_PREVIOUS_PUBLIC_KEYS` so the endpoint keeps listing it. Roll the API. Every licence from
   now on is signed with the new key; existing licences stay valid under the old public key.
4. When the last licence signed with the old key has ended (at most `LICENCE_MAX_TERM_DAYS`), remove
   it from `LICENCE_PREVIOUS_PUBLIC_KEYS` and, at their next renewal, from installations.
5. Destroy the old private key's copies, recording who and when.

## Compromise

1. Generate a new key and switch the API to it **at once** (step 3 above), with
   `LICENCE_PREVIOUS_PUBLIC_KEYS=[]` — the compromised key is not "previous", it is untrusted.
2. Reissue a licence for every live on-premises subscription, from the portal, and deliver them
   with an installation `LICENSE_PUBLIC_KEYS` that **replaces** (not extends) the old list.
3. Record the incident; every licence signed with the old key is suspect until replaced, and an
   offline installation cannot be told. This is why terms are short.
