-- Provisioning the least-privilege application login role.
--
-- WHY THIS FILE EXISTS
--
-- RLS is enabled AND forced on audit_log, access_events and deletion_certificates,
-- so those tables are append-only — but only against roles that RLS applies to.
-- A SUPERUSER or any role holding BYPASSRLS ignores RLS unconditionally, FORCE
-- included. Supabase's `postgres` role is exactly such a role. Connecting the
-- application as it makes the append-only guarantee inert: the policies are all
-- present, all correct, and all skipped.
--
-- Run this ONCE per environment, as the platform owner, then point the
-- application's DATABASE_URL at prism_app. `scripts/preflight.js` checks the
-- connected role for SUPERUSER/BYPASSRLS and reports it, so this is verifiable
-- rather than assumed.
--
--   psql "$ADMIN_DATABASE_URL" -v password="'<generated>'" -f scripts/sql/provision-app-role.sql
--
-- The password is passed in rather than written here so this file stays
-- committable. Generate one with:
--   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The role
-- ---------------------------------------------------------------------------
-- NOSUPERUSER and NOBYPASSRLS are the whole point of the exercise and are stated
-- explicitly rather than left to the defaults, so that reading this file tells
-- you what is guaranteed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prism_app') THEN
    EXECUTE format('CREATE ROLE prism_app LOGIN PASSWORD %L', :'password');
  ELSE
    EXECUTE format('ALTER ROLE prism_app LOGIN PASSWORD %L', :'password');
  END IF;
END
$$;

ALTER ROLE prism_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;

-- ---------------------------------------------------------------------------
-- 2. Schema and sequence access
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO prism_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prism_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO prism_app;

-- ---------------------------------------------------------------------------
-- 3. Ordinary tables: full DML, no DDL
-- ---------------------------------------------------------------------------
-- The application legitimately deletes from these — erasure is the product.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prism_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prism_app;

-- ---------------------------------------------------------------------------
-- 4. Evidentiary tables: append-only, belt and braces
-- ---------------------------------------------------------------------------
-- RLS already denies UPDATE/DELETE here (no policy exists for either, and with
-- FORCE on, no policy means denied). Revoking the privilege as well means the
-- guarantee does not rest on a single mechanism: a future migration that
-- carelessly adds an UPDATE policy still hits a missing privilege.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log"              FROM prism_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "access_events"          FROM prism_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "deletion_certificates"  FROM prism_app;

-- Migrations run as the owner, not as this role. Denying DDL here is what stops
-- an application-level SQL injection from dropping the chain it is recorded in.
REVOKE CREATE ON SCHEMA public FROM prism_app;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify (run as prism_app; all three must fail)
-- ---------------------------------------------------------------------------
--   UPDATE audit_log SET action = 'x' WHERE id = (SELECT id FROM audit_log LIMIT 1);
--   DELETE FROM access_events WHERE true;
--   DELETE FROM deletion_certificates WHERE true;
--
-- And confirm the attributes:
--   SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
--   -- must be (f, f)
