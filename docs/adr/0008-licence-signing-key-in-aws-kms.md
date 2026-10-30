# ADR-0008 — Licence signing on AWS: the key stays in KMS

**Status** Proposed · **Date** 2026-10-29 · **Approval** Pending the owner's decision
**Amends** ADR-0003 §1 (where the private half lives), only when `LICENCE_SIGNING_BACKEND=KMS`
**Relates to** the shared AWS hosting ADR (draft), munaxa-platform ADR-0022 (`mxl1`, ES256/RS256 only)

## Context

ADR-0003 keeps the licence signing key in a file mounted into the API, never in an environment
variable. On ECS Fargate that is awkward: ECS injects Secrets Manager values only as environment
variables, and Fargate has no in-memory (`tmpfs`) volume. The only way to produce the file is an
init container that receives the PEM as a `secrets` entry and writes it to a task-scoped volume
on the task's encrypted ephemeral disk. The key then passes through an environment variable (the
thing ADR-0003 forbids) and rests on disk for the life of the task.

ADR-0003 already names a KMS-held key as "the right end state, and compatible: the signer is one
interface".

## Decision (proposed)

1. On AWS, the signing key is an **AWS KMS asymmetric key**, `ECC_NIST_P256`, usage
   `SIGN_VERIFY`, in the Control workload account and region. Its private half never leaves KMS.
2. The API selects it with `LICENCE_SIGNING_BACKEND=KMS`, `LICENCE_SIGNING_KMS_KEY_ID` (the key
   ARN) and `LICENCE_SIGNING_PUBLIC_KEY` (its SPKI PEM, which is public). `FILE` is unchanged for
   on-premises or non-AWS hosting and stays the default outside production; production refuses to
   start unless `LICENCE_SIGNING_BACKEND` is set, so a deployment meant for KMS never falls back
   to a file. With `KMS`, a key file is refused, ES256 is the only algorithm, and the public key
   must be P-256.
3. Signing goes through the shared `@munaxa/licensing` contract, unmodified. Its signer interface
   is synchronous, so `KmsLicenceSigner` runs each build twice: the first pass captures the exact
   bytes the contract asks to sign; KMS signs their SHA-256 (`MessageType=DIGEST`,
   `ECDSA_SHA_256`); the second pass places the signature. A build that asks to sign different
   bytes the second time is refused. Every KMS signature is converted from DER to JWS `r‖s` and
   verified against the configured public key before it is returned.
4. **Startup proves the key.** The API signs a probe through KMS and verifies it with
   `LICENCE_SIGNING_PUBLIC_KEY` before it serves; a missing permission, a wrong key or a mismatched
   public key stops the process (fail closed).
5. The key policy is the account default: it names only the account, so IAM policies in the
   account decide who may use the key. The API task role's own policy grants `kms:Sign` on this key
   and nothing else. Principals with broad IAM permissions in the account (root, the Terraform
   deployer role) can also use or administer it; a key policy naming the task role and denying
   `kms:Sign` to everyone else is a follow-up once that role exists. Every signature is a
   CloudTrail `Sign` event.

## Consequences

- **No private key in Control's process, image, environment, disk or backups.** A compromised task
  can sign while it runs, but cannot take the key away. Revoking the task role's permission stops
  signing at once.
- **No offline backup is possible.** KMS keys cannot be exported, so the recovery path for a lost
  or disabled key is rotation (ADR-0003 §4): a new key, its public half shipped to installations
  first. Deletion requires a 7–30 day waiting period, which is set to 30 days. This replaces the
  two-person offline backup of `recovery.md` for the KMS backend.
- **Cost:** one customer managed key (about US$1 a month) plus asymmetric request charges, which
  at licence-issuing volumes (tens to hundreds a month, one startup probe per task start) round to
  zero. Check the live price list before approving.
- **Latency:** one KMS round trip (tens of milliseconds) per licence or revocation list, inside
  the issuing transaction. Issuance is an operator action, not a hot path.
- **Availability:** issuance depends on KMS in eu-central-1. Products are unaffected: they verify
  offline with the public key, and entitlement snapshots are not signed.
- The sweep task boots the same module and so needs the same `kms:Sign` permission for its probe,
  or a separate role; the Terraform gives the sweep the API's task role.

## Alternatives considered

- **Init container and a task-scoped volume (ADR-0003 as written).** No code change. The key is
  still in an environment variable of the init container, on encrypted ephemeral disk rather than in
  memory, and in Secrets Manager. Kept as the fallback if this ADR is declined.
- **A non-AWS host with a platform secret file** (e.g. Render Secret Files). Takes Control off the
  approved eu-central-1 hosting. Rejected.
- **CloudHSM.** Same custody properties at well over US$1,000 a month. Rejected on cost.
