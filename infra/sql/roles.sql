-- Cluster roles, created once per database cluster by an administrator (not by the application).
--   control_owner — owns the schema; runs migrations. Never used by the running service.
--   control_app   — the runtime role. Not a superuser, cannot create roles or databases.
-- Passwords are set out of band (see docs/operations/secrets.md); none is written here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_owner') THEN
    CREATE ROLE control_owner LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_app') THEN
    CREATE ROLE control_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
