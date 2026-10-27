# ADR-0001 — A peer service, authoritative for subscriptions, enforcing nothing

**Status** Accepted · **Date** 2026-10-26 · **Approval** Pending review
**Relates to** munaxa-platform ADR-0022 (`@munaxa/licensing`), Docs ADR-0026, Work ADR-0078/0079

## Context

Munaxa Group sells School, Work and Docs. Each had its own idea of a subscription (School a table
of plans, Docs a policy port nothing bound, Work nothing), and none could be suspended, limited or
licensed from one place. Some customers run a product on their own servers, offline.

## Decision

1. **A separate service and repository**, a peer of the products. It imports none of them and none
   imports it; what crosses is HTTP, a signed token, a public key and the shared contract.
2. **Authoritative for records, never for enforcement.** It owns customers, tenant links, plans and
   their immutable versions, subscriptions and their history, licence issuance, installations,
   reported usage and its own audit trail. Each product enforces, through `@munaxa/licensing`, what
   this service answers — always beneath its own permissions and tenant isolation.
3. **One answer per tenant per product**, the `EntitlementSnapshot`. Plans are data whose keys this
   service never interprets; each product's catalogue says what its keys mean.
4. **Never deletes.** The runtime role has no `DELETE` on any business table; history, usage and
   audit are append-only by grant; published plan versions are immutable by trigger. Closing a
   customer or cancelling a subscription is a state, and a cancelled tenant still receives its
   (export-only) snapshot rather than a 404.
5. **No payment.** Prices are recorded, in integer minor units, and charge nothing.

## Consequences

- A product keeps working through this service's outages, degraded by the shared policy rather than
  stopped; and keeps its legacy default (`NONE`/`DATABASE`) until a deployment opts in.
- Two sources of truth would exist for School while `DATABASE` mode remains in use; moving a School
  deployment to `CONTROL_PLANE` is the migration.
- Billing, invoicing and payment collection are out of scope until separately authorised.

## Alternatives considered

- **Inside one of the products** (Docs has the most licensing code) — every other product would
  depend on Docs' release cycle, and Docs' database would hold other products' customers.
- **Enforcement here, as a gateway** — every request of every product through one service, its
  latency on every request and its outage everybody's.
