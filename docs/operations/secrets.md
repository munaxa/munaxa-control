# Secrets

Every secret is injected at runtime from the platform's secret store, read by the process that
needs it and nothing else. None is committed, baked into an image, printed, or passed on a command
line. `.gitignore` refuses `*.pem`, `deploy/secrets/*` and `.env`.

| Secret                                | Held by                 | Form                                                                   | Rotation                                             |
| ------------------------------------- | ----------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `control_app` database password       | API                     | In `DATABASE_URL`                                                      | Rotate in the database, then the store; roll the API |
| `control_owner` database password     | The migration step only | In `DATABASE_MIGRATION_URL`                                            | As above; never given to the running API             |
| Licence signing private key           | API only                | A file mounted at `LICENCE_SIGNING_PRIVATE_KEY_FILE`, mode 0400        | `licence-signing.md`                                 |
| Product service credentials (`mxc_…`) | Each product deployment | `CONTROL_PLANE_TOKEN` in the product's store; only the SHA-256 is here | Issue new → deploy → revoke old, in the portal       |

Not secrets, and safe to publish: Identity's public key (`OPERATOR_AUTH_PUBLIC_KEYS`), the licence
public keys (`/api/v1/licensing/public-keys`), `OPERATOR_ORGANISATION_ID`.

## On AWS (account 229251310592, eu-central-1)

When the deployment target is chosen and authorised:

- Store each secret in **AWS Secrets Manager**, encrypted with a customer-managed KMS key, with
  resource policies granting `GetSecretValue` to the API's task/instance role only — no IAM users,
  no access keys; the owner administers as root until the build is finished.
- Resolve secrets into the runtime with the platform's native integration (ECS task `secrets`,
  or `{{resolve:secretsmanager:…}}` in CloudFormation), so a value never passes through a person's
  terminal or a session transcript. The licence private key is written to an in-memory volume by the
  task, not to an image layer.
- Infrastructure goes in `infra/terraform/` with the rest of the account (its README), never by hand.

## If one leaks

| Secret                  | Do at once                                                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A product credential    | Revoke it in the portal (effective at the next request), issue a new one, deploy it. Review the audit trail and usage for that deployment |
| The licence private key | `licence-signing.md` → compromise. Every licence signed with it is suspect                                                                |
| A database password     | Rotate it; review `audit_event` for the window                                                                                            |
