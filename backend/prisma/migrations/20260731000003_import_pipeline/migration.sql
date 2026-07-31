-- Phase 3 — import pipeline.
--
-- Two NOT NULL constraints stand between the schema and an admin-initiated
-- import, and both are relaxed here deliberately rather than worked around.
--
-- 1. photos.session_id
--    An import has no capture event: no session, no agent, no project. The
--    alternatives were worse. Manufacturing a synthetic Session would have put a
--    fake collection event in the ledger AND still required a project and an
--    agent id, so it launders provenance to satisfy a constraint. Consumers that
--    read photo.session now treat it as optional; the ones that render a session
--    label show "imported" instead of throwing, and the ones that matter for
--    erasure (discovery, itemIndex, export) never depended on it.
--
-- 2. photo_subjects.consent_id
--    Imported data has no capture-time consent. The rule (PLAN.md Phase 3,
--    "Consent decision to state explicitly in the code") is that import links a
--    live ProjectConsent when a projectId is supplied and an ACTIVE consent
--    exists, and otherwise records lawful basis as IMPORT_UNVERIFIED on the
--    SubjectDataItem — visibly, in discovery and lineage. It must NOT silently
--    manufacture a ProjectConsent row, which is exactly what a NOT NULL here
--    would have forced.
--
-- Nothing on the collection path can reach either null: session.service writes
-- every Photo with a sessionId and every PhotoSubject with a consentId, and
-- those call sites are unchanged.
--
-- No new table, so no RLS/grant work — import_batches was created, RLS-enabled
-- and granted by 20260731000001/20260731000002.

-- Column names are camelCase here, not snake_case: neither field carries an
-- @map in schema.prisma, so Prisma created them verbatim (see
-- 20260713120000_collection_sessions_face_tagging).
ALTER TABLE "photos" ALTER COLUMN "sessionId" DROP NOT NULL;

ALTER TABLE "photo_subjects" ALTER COLUMN "consentId" DROP NOT NULL;
