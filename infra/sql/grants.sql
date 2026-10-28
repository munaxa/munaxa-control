-- Runtime privileges for `control_app`. Applied after every migration (scripts/apply-grants.mjs),
-- as the schema owner, and safe to re-run.
--
-- The runtime role reads and writes the commercial record, and no more:
--   * the audit trail, subscription history and usage reports are append-only — INSERT and SELECT,
--     never UPDATE or DELETE — so the application cannot rewrite what happened;
--   * nothing is ever deleted: no table grants DELETE except the idempotency record, which is a
--     cache of responses with a retention window rather than a business record.

GRANT USAGE ON SCHEMA public TO control_app;

GRANT SELECT, INSERT, UPDATE ON
  customer, product_deployment, service_credential, tenant_link, plan, plan_version,
  subscription, installation, licence
TO control_app;

GRANT SELECT, INSERT ON subscription_event, usage_report, audit_event TO control_app;
-- UPDATE: a key is claimed before the request runs and completed with its answer after.
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_record TO control_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO control_app;

-- Belt and braces: nothing granted above includes these, and they are revoked in case a broader
-- default privilege was ever configured on the database.
REVOKE UPDATE, DELETE, TRUNCATE ON subscription_event, usage_report, audit_event FROM control_app;
REVOKE DELETE, TRUNCATE ON
  customer, product_deployment, service_credential, tenant_link, plan, plan_version,
  subscription, installation, licence
FROM control_app;
