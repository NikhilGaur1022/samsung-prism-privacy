-- RLS + application-role grants for the three tables created by
-- 20260731000001_dsar_item_index.
--
-- Why this is a separate, mandatory migration and not an afterthought:
-- the application connects as `prism_app`, which holds neither SUPERUSER nor
-- BYPASSRLS (scripts/sql/provision-app-role.sql asserts this). A new table with
-- RLS enabled and no policy denies everything, and a new table with no grant is
-- a 42501 on first insert. Both failure modes are invisible until runtime and
-- both present as a broken feature, not as a permissions error, in the portal.
--
-- Posture matches 20260728000001_lock_down_public_grants:
--   * RLS ENABLED with a permissive TO PUBLIC policy. Authorization for these
--     tables lives in requireRole + the service layer (invariant 10), not in
--     RLS. RLS is on so that if a `GRANT ... TO anon` ever reappears — one
--     dashboard click — the policy still stands between it and the rows.
--   * anon/authenticated are explicitly revoked. Nothing here uses PostgREST.
--   * Written TO PUBLIC and guarded by pg_roles checks so the migration is
--     runnable on a plain Postgres where `prism_app`/`anon` do not exist.
--
-- subject_data_items is NOT evidentiary — it is a rebuildable projection, so
-- prism_app keeps UPDATE/DELETE on it (the indexer upserts). dsar_item_actions
-- is a lifecycle record the worker advances, so it keeps UPDATE too; its
-- tamper-evidence comes from audit_log, which remains append-only.

-- ---------------------------------------------------------------------------
-- 1. RLS on, with a policy (RLS on + no policy = everything denied)
-- ---------------------------------------------------------------------------
ALTER TABLE "subject_data_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dsar_item_actions"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "import_batches"     ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS subject_data_items_app_all ON "subject_data_items";
CREATE POLICY subject_data_items_app_all ON "subject_data_items"
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS dsar_item_actions_app_all ON "dsar_item_actions";
CREATE POLICY dsar_item_actions_app_all ON "dsar_item_actions"
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS import_batches_app_all ON "import_batches";
CREATE POLICY import_batches_app_all ON "import_batches"
  FOR ALL USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. Explicit grants to the application role
-- ---------------------------------------------------------------------------
-- ALTER DEFAULT PRIVILEGES in provision-app-role.sql should already cover
-- tables created by the migration owner. Should is not a guarantee — default
-- privileges only apply to the exact role that declared them, and a migration
-- run by a different owner silently produces ungranted tables. Granting
-- explicitly makes this migration self-sufficient.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prism_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "subject_data_items" TO prism_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "dsar_item_actions"  TO prism_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "import_batches"     TO prism_app';
    -- Deletion is the product, but truncation never is.
    EXECUTE 'REVOKE TRUNCATE ON "subject_data_items" FROM prism_app';
    EXECUTE 'REVOKE TRUNCATE ON "dsar_item_actions"  FROM prism_app';
    EXECUTE 'REVOKE TRUNCATE ON "import_batches"     FROM prism_app';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Keep the PostgREST roles out
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON "subject_data_items" FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON "dsar_item_actions"  FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON "import_batches"     FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;
