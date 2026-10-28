# Integrating a product

How Munaxa School, Work and Docs take their entitlements from this service, and the contract each
one keeps. The rules every product shares are in `@munaxa/licensing` (munaxa-platform ADR-0022);
this page is how they meet this service.

## The three modes

Every product reads `LICENSING_MODE` and offers the same three, plus its own legacy default.

| Mode                | Where entitlements come from                                                 | For                                                |
| ------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `CONTROL_PLANE`     | This service, per tenant, over HTTPS                                         | Munaxa-hosted deployments                          |
| `LICENSE_FILE`      | A signed licence file this service issued, verified offline with public keys | A customer's own server, possibly without internet |
| `NONE` / `DATABASE` | Nothing is licensed (Docs, Work) / School's own subscription tables          | Development, and deployments as they ran before    |

No failure in a licensing mode falls back to the default: a missing licence or a tenant with no
subscription grants nothing beyond what each product keeps ungated (its core modules).

## Hosted: `CONTROL_PLANE`

### Set up, once per deployment

1. **Portal → Deployments:** create the deployment (`docs-eu-prod`, say).
2. **Issue a credential** for it. The token (`mxc_…`) is shown once and never again; put it straight
   into the product's secret store. Only its SHA-256 is kept here.
3. **Configure the product:**

   ```bash
   LICENSING_MODE=CONTROL_PLANE
   CONTROL_PLANE_URL=https://control.munaxa.com     # https is required in production
   CONTROL_PLANE_TOKEN=mxc_…                        # from the secret store, never committed
   ```

   Docs also needs the host on `OUTBOUND_HTTP_ALLOWLIST`: its outbound port refuses anything else.

4. **Per tenant:** Portal → Customers → link the product's tenant identifier to the customer as a
   `SaaS` tenant on that deployment, then start a subscription on a published plan version.

A credential is bound to one deployment of one product. It can read only tenants linked to that
deployment and report usage only for them; asking about any other tenant answers `404`, exactly as
for a tenant that does not exist. A product cannot name its way into another product's or another
deployment's customers.

### The calls

| Call                                                             | When                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/products/{product}/tenants/{tenantId}/entitlements` | On demand, reused for up to a minute per tenant (`Cache-Control: private, max-age=30` from here; each product caches 60 s) |
| `POST /api/v1/products/{product}/usage`                          | Levels, best effort (School on change, Docs hourly)                                                                        |

Every product sends with a 3-second timeout and **follows no redirects** (a redirect would carry
the credential somewhere the deployment was not told about).

### Reading the answer — the same in every product

The products do not each interpret the response: they call `readEntitlementResponse` from
`@munaxa/licensing`.

| Answer                                                                    | Read as         | Effect                                                                                                                          |
| ------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `200` + a snapshot for exactly this tenant and product                    | The truth       | Decided by the snapshot's status and terms; remembered as the last good answer                                                  |
| `404`                                                                     | No subscription | Nothing beyond the core; **the remembered answer is dropped**, so it cannot bridge a later outage into access already withdrawn |
| `401`, `403`, any `5xx`, a timeout, a refused connection                  | Outage          | The last good answer, degraded by age (below)                                                                                   |
| A body that does not parse, or a snapshot about another tenant or product | Outage          | As above. An answer nobody can trust teaches nothing; it neither grants nor withdraws                                           |

`401`/`403` are an outage on purpose: a revoked or mistyped credential is an operator's mistake, and
reading it as "every customer cancelled" would lock every tenant out at once.

### When this service is unreachable

`resolveSnapshot` with `SAAS_AVAILABILITY_POLICY`, measured from when the last good answer was
received:

| Age                                                       | Ceiling                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ≤ 1 hour                                                  | Full: as the answer said                                                                                                             |
| ≤ 1 day                                                   | No growth: no new users, students, employees, uploads                                                                                |
| ≤ 7 days                                                  | Read-only                                                                                                                            |
| Longer                                                    | Nothing                                                                                                                              |
| Never received (a process that started during the outage) | Nothing — School and Work keep the core modules readable; Docs persists its last answer in `entitlement_state` and survives restarts |

### Lifecycle, as each product applies it

Through `DEFAULT_ACCESS_POLICY`, identical everywhere:

| Status                        | Access                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `TRIAL`, `ACTIVE`, `PAST_DUE` | Full                                                                         |
| `GRACE_PERIOD`                | No growth                                                                    |
| `SUSPENDED`, `EXPIRED`        | Read-only                                                                    |
| `CANCELLED`                   | Export only — never deleted; a cancelled tenant gets its snapshot, not a 404 |

Sign-in: Docs and Work sign every tenant in and then apply the ceiling per request; School signs
every school in except an `ARCHIVED` one (its own terminal state), and its read-only guard applies
the ceiling. No product deletes anything because of a status.

## On premises: `LICENSE_FILE`

1. **Portal → Customers:** link the tenant as `On premises`, start the subscription, and register
   the installation (`installationRef`, the identifier the server is configured with).
2. **Issue a licence** on the subscription page for that installation. It ends at the subscription's
   end, never later than `LICENCE_MAX_TERM_DAYS`, and is signed here with the private key that never
   leaves this service.
3. **Download** the `.license` file and deliver it. On the server:

   ```bash
   LICENSING_MODE=LICENSE_FILE
   LICENSE_FILE_PATH=/etc/munaxa/<product>.license
   LICENSE_PUBLIC_KEYS='<from GET /api/v1/licensing/public-keys>'
   LICENSE_INSTALLATION_ID=<the installationRef>
   ```

   A private key in `LICENSE_PUBLIC_KEYS` refuses startup.

4. **Renewal:** issue a new licence and copy it over the old one; it is re-read within a minute.
5. **Activation codes:** an installation can produce an activation request (`ACTIVATION`, `RENEWAL`,
   `SERVER_REPLACEMENT`); paste it into **Portal → Activations** and the licence is issued against
   the right subscription and installation. A server replacement marks the old installation
   `REPLACED`, so its licence cannot be renewed.

Revocation is recorded and stops renewal, but an offline installation cannot be told: a licence is
valid until it ends. Keep terms short for customers where that matters.

## Each product's catalogue

The keys are the product's, documented where the product enforces them. The portal stores plans
whose keys it never interprets.

| Product | Features                                                                                                     | Limits                                        | Defined in                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ----------------------------------------------------------- |
| Docs    | `api.access`, `integration.webhooks`, `sso.federation`, `audit.stream`, `esignature`                         | `users`, `storage.bytes`                      | munaxa-docs `packages/domain/src/licensing.ts`, ADR-0026    |
| School  | `api`, `ai_assistant`, `sso`, `jofotara`, `advanced_reports`, `automation`, `white_label`, … (`PlanFeature`) | `students`, `campuses`, `staff`, `storage_gb` | munaxa-school `packages/domain/src/subscription.ts`         |
| Work    | `payroll`, `compensation`, `recruitment`, `performance`, `learning`, `career`, `relations`, `assets`         | `employees` (open employments)                | munaxa-work `apps/api/src/licensing/catalogue.ts`, ADR-0079 |

A limit a plan does not list is **zero** under the shared contract — list every limit a product
reads, with `null` for unlimited.

## Usage reported

| Product | Metrics                              | How                                                                     |
| ------- | ------------------------------------ | ----------------------------------------------------------------------- |
| Docs    | `users`, `storage.bytes`             | Hourly on the `licensing.usage` lane, at the hour the firing belongs to |
| School  | `students`, `campuses`, `storage_gb` | When the level changes, best effort                                     |
| Work    | —                                    | Not yet; Work enforces headcount locally                                |

Usage is informational here: shown beside the plan's ceiling in the portal. Products enforce their
own limits against their own rows, atomically.

## Clock rollback, per product

| Product | What is remembered                                             | Survives a restart                                              |
| ------- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| Docs    | `entitlement_state.last_observed_at`, per tenant, forward-only | Yes                                                             |
| School  | The latest instant observed, per process                       | No — only a licence's own issue time is a floor across restarts |
| Work    | The latest instant observed, per process                       | No — as School                                                  |

Decisions are made at the later of the clock and the remembered instant, so a clock wound back while
the process runs cannot un-expire a term.
