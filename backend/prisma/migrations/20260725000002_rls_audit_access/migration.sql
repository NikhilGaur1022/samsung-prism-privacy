-- WAVE 0.3 — make the two evidentiary tables append-only, and the deletion
-- certificate undeletable.
--
-- Why RLS and not just REVOKE: the application connects as the table owner in
-- every environment we ship (Supabase's `postgres`, local dev's `postgres`), and
-- an owner can re-GRANT itself anything a REVOKE took away. `FORCE ROW LEVEL
-- SECURITY` is the one mechanism that binds the owner too. Tables get an INSERT
-- policy and a SELECT policy and deliberately no UPDATE or DELETE policy — with
-- RLS forced, a command with no matching policy is denied outright, so
-- "append-only" is enforced by the database rather than by everyone remembering.
--
-- Residual risk, documented rather than hidden: a SUPERUSER, or any role carrying
-- the BYPASSRLS attribute, ignores RLS unconditionally — FORCE included. Managed
-- Postgres (Supabase's `postgres`) is exactly such a role. Production must
-- therefore hand the application a plain login role, not the platform owner, and
-- `ops/preflight.md` asserts that the connected role has neither attribute.

-- ---------------------------------------------------------------------------
-- audit_log — mutation chain, 7y retention, append-only
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_log_insert" ON "audit_log";
CREATE POLICY "audit_log_insert" ON "audit_log" FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "audit_log_select" ON "audit_log";
CREATE POLICY "audit_log_select" ON "audit_log" FOR SELECT USING (true);

-- No UPDATE/DELETE policy exists, and none may be added: rewriting a hash-chained
-- row is precisely the attack the chain is meant to expose.
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- access_events — read log, 3y retention, append-only
-- ---------------------------------------------------------------------------
ALTER TABLE "access_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "access_events" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "access_events_insert" ON "access_events";
CREATE POLICY "access_events_insert" ON "access_events" FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "access_events_select" ON "access_events";
CREATE POLICY "access_events_select" ON "access_events" FOR SELECT USING (true);

REVOKE UPDATE, DELETE, TRUNCATE ON "access_events" FROM PUBLIC;

-- The 3-year retention sweep is the ONE legitimate deleter. It must run as a
-- separate role that owns this exemption explicitly rather than as the app, so
-- that "the app can delete access events" is never quietly true.
-- Create the role out-of-band, then:
--   ALTER TABLE "access_events" ... (a DELETE policy scoped to that role)
-- is added by the retention migration in a later wave, not granted here.

-- ---------------------------------------------------------------------------
-- deletion_certificates — the principal's proof of erasure
-- ---------------------------------------------------------------------------
-- A certificate that can be deleted proves nothing. Issue and read only; even
-- correcting one means issuing a superseding certificate, never editing this row.
ALTER TABLE "deletion_certificates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "deletion_certificates" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "deletion_certificates_insert" ON "deletion_certificates";
CREATE POLICY "deletion_certificates_insert" ON "deletion_certificates" FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "deletion_certificates_select" ON "deletion_certificates";
CREATE POLICY "deletion_certificates_select" ON "deletion_certificates" FOR SELECT USING (true);

REVOKE UPDATE, DELETE, TRUNCATE ON "deletion_certificates" FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Least-privilege application role, when ops has provisioned one
-- ---------------------------------------------------------------------------
-- Optional and idempotent: if a dedicated `prism_app` login role exists, give it
-- exactly INSERT + SELECT on the three tables above and nothing else. If it does
-- not exist this block is a no-op, so the migration is safe on a laptop.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prism_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON "audit_log" TO prism_app';
    EXECUTE 'GRANT SELECT, INSERT ON "access_events" TO prism_app';
    EXECUTE 'GRANT SELECT, INSERT ON "deletion_certificates" TO prism_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM prism_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON "access_events" FROM prism_app';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON "deletion_certificates" FROM prism_app';
  END IF;
END
$$;
