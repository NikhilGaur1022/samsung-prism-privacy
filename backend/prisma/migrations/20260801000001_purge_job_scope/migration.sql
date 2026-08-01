-- Phase 5 — per-item and bulk DSAR actions.
--
-- A per-item DELETE reuses the erasure executor rather than adding a second
-- deletion code path (PLAN §0 decision 4). That reuse creates one hazard worth a
-- schema column: a scoped job is structurally identical to a whole-subject
-- erasure that happened to have few locations, so
-- certificate.service.issueCertificate() would happily sign it as a completed
-- DPDP erasure. It is not one — it never touches the subject key, the consent
-- rows or the PII row.
--
-- `scope` makes the difference a persisted fact rather than something inferred
-- from location counts, and it is what createPurgeJob() filters on so a scoped
-- job is never mistaken for "the open erasure for this request".
--
-- `meta` carries the provenance of a scoped job (the item action batch and the
-- item ids that raised it) so the Phase 7 timeline can attribute a purge to the
-- click that caused it.
--
-- No new table, so no RLS/grants block is needed here: purge_jobs already has
-- both from 20260725000002_rls_audit_access, and a column inherits the table's
-- policy and grants.

DO $$
BEGIN
  CREATE TYPE "PurgeJobScope" AS ENUM ('FULL', 'PARTIAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

-- DEFAULT 'FULL' is the correct backfill: every job that exists today was
-- planned from a complete discovery walk.
ALTER TABLE "purge_jobs"
  ADD COLUMN IF NOT EXISTS "scope" "PurgeJobScope" NOT NULL DEFAULT 'FULL';

ALTER TABLE "purge_jobs"
  ADD COLUMN IF NOT EXISTS "meta" JSONB;

CREATE INDEX IF NOT EXISTS "purge_jobs_dsar_request_id_scope_status_idx"
  ON "purge_jobs" ("dsar_request_id", "scope", "status");
