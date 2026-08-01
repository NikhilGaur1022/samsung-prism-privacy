-- Phase 9 — the scale pass. Two indexes, both for queries that Phases 3–7 added
-- and that no existing index covers.
--
-- No new table, so no RLS/grants block: both tables already carry their policies
-- and their `prism_app` grants, and an index inherits neither concept.

-- 1. The DSAR dashboard's keyset walk.
--
-- listQueue() pages with ORDER BY (sla_due_at ASC, id ASC) under a coarse tab
-- filter, which is `status IN ('DISCOVERY','EXECUTING','REVIEW')` and not a
-- single value. `dsar_requests_status_sla_due_at_idx` is therefore unusable for
-- the sort — the planner reads every row matching the IN and sorts it, which is
-- fine at a hundred requests and is not at a hundred thousand. This index
-- matches the ORDER BY exactly, so the walk is an index scan with a filter.
CREATE INDEX IF NOT EXISTS "dsar_requests_sla_due_at_id_idx"
  ON "dsar_requests" ("sla_due_at", "id");

-- 2. Import de-duplication.
--
-- `photos_session_id_sha256_key` stops de-duplicating the moment session_id is
-- null, because Postgres treats NULLs as distinct — which is exactly the case
-- for every imported frame. import.ingestItem() therefore probes by sha256
-- explicitly before it writes, and without this index that probe is a sequential
-- scan of the whole photo table on every single file of every batch.
CREATE INDEX IF NOT EXISTS "photos_sha256_idx"
  ON "photos" ("sha256");
