-- Close the PostgREST path into the data, and make the three tables that
-- already had RLS switched on actually usable by the application.
--
-- TWO SEPARATE FINDINGS, both invisible until the app stopped connecting as
-- Supabase's `postgres` (which holds BYPASSRLS and so skipped every policy):
--
-- 1. `anon` and `authenticated` held SELECT/INSERT/UPDATE/DELETE/TRUNCATE on
--    all 30 tables in `public`, and only 6 of those 30 have RLS enabled. Supabase
--    publishes every table in `public` through PostgREST, and the `anon` key is
--    public by construction — it ships inside the portal bundles. That combination
--    means photos, sessions, projects, photo_subjects and subject_keys were
--    readable and writable by anyone holding a key that is not a secret.
--
--    Nothing in this system uses PostgREST. There is no @supabase/supabase-js
--    client in either portal; all database access goes through Prisma as the
--    application role. So these grants buy nothing and are revoked outright.
--
-- 2. `data_subjects`, `session_handoffs` and `subject_face_enrollments` have RLS
--    ENABLED with ZERO policies. RLS on with no policy denies everything, so as
--    soon as the app connects as a role without BYPASSRLS every insert into
--    data_subjects fails with 42501. This was masked for the life of the project.
--
--    These are ordinary application tables. Their authorization lives in
--    requireRole and the service layer (invariant 10), not in RLS. RLS is left
--    ENABLED rather than switched off, so that if a future `GRANT ... TO anon`
--    ever reappears — a dashboard click is all it takes — the policies below
--    still stand between it and the rows. The policies are written TO PUBLIC to
--    match the existing evidentiary policies and to keep this migration runnable
--    on a plain Postgres where `prism_app` and `anon` may not exist. A policy
--    grants nothing on its own: without a table privilege it is unreachable.

-- ---------------------------------------------------------------------------
-- 1. Revoke the PostgREST roles
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', role_name);
      EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', role_name);
      -- Future tables, too. Without this the next `prisma migrate` re-grants
      -- everything this migration just took away.
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', role_name);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Give the three policy-less RLS tables a policy
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS data_subjects_app_all ON "data_subjects";
CREATE POLICY data_subjects_app_all ON "data_subjects"
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS session_handoffs_app_all ON "session_handoffs";
CREATE POLICY session_handoffs_app_all ON "session_handoffs"
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS subject_face_enrollments_app_all ON "subject_face_enrollments";
CREATE POLICY subject_face_enrollments_app_all ON "subject_face_enrollments"
  FOR ALL USING (true) WITH CHECK (true);
