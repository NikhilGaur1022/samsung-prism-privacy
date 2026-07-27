# Deliverable 3 — File-Wise Implementation Plan

Conventions already in the repo, keep them:
- module folder = `backend/src/modules/<name>/<name>.routes.js` + `<name>.service.js`
- routes mount in `backend/src/app.js` under `/api/v1/...`
- cross-cutting primitives in `backend/src/lib/`
- middleware in `backend/src/middleware/`
- migrations are hand-written SQL under `backend/prisma/migrations/<ts>_<name>/migration.sql`
- admin UI pages in `admin-portal/src/pages/<role>/`, subject UI in `user-portal/src/pages/`

Column `Agent` maps to Deliverable 4.

---

## WAVE 0 — Schema + crypto foundation (everything depends on it)

| # | File | Action | Purpose | Reads / Writes | Called by | Agent |
|---|---|---|---|---|---|---|
| 0.1 | `backend/prisma/schema.prisma` | edit | add `ProjectStatus` values `DRAFT SUBMITTED APPROVED REJECTED ACTIVE CLOSED` (default `DRAFT`); add `Project.submittedAt/approvedAt/approvedByAdminId/rejectionReason/consentTemplateId/dataTypes Json/riskLevel`; add models `ConsentTemplate`, `DsarRequest`, `DsarEvidence`, `PurgeJob`, `PurgeJobLocation`, `DeletionCertificate`, `AccessEvent`, `BreachRecord`, `RetentionPolicy`; add `Photo.piiStatus PiiStatus`, `Photo.encKeyId`, `SubjectFaceEnrollment.encKeyId`, `Subject.dateOfBirth/guardianContact/nomineeContact` | DB | all services | A1 |
| 0.2 | `backend/prisma/migrations/20260725000001_governance_dsar/migration.sql` | new | hand-written DDL for 0.1 + indexes: `dsar_requests(status, slaDueAt)`, `access_events(actorId, createdAt)`, `access_events(objectType, objectId)`, `purge_job_locations(purgeJobId, status)` | DB | — | A1 |
| 0.3 | `backend/prisma/migrations/20260725000002_rls_audit_access/migration.sql` | new | RLS: `audit_logs` + `access_events` → app role gets `INSERT`+`SELECT`, **no** `UPDATE/DELETE`; revoke `DELETE` on `deletion_certificates` | DB | — | A1 |
| 0.4 | `backend/src/lib/keyring.js` | new | KEK load from env, HKDF-SHA256 derive per-project / per-subject / per-export DEK, `keyId` versioning, `destroySubjectKey(subjectId)` for crypto-shredding | env, `subject_keys` table | `blobCrypto`, `embeddingCrypto`, purge | A1 |
| 0.5 | `backend/src/lib/blobCrypto.js` | new | `sealBlob(buf, dek)` / `openBlob(buf, dek)`; header `magic(4)|ver(1)|keyId(8)|nonce(12)|tag(16)|ct`; AES-256-GCM | — | `storage.js` | A1 |
| 0.6 | `backend/src/lib/storage.js` | edit | make `writeFile/readFile` encryption-aware: `writeFile(path, buf, {scope:'project'|'subject'|'export', scopeId})`; `deleteFile` → `shredFile` (overwrite header then unlink) | disk | every media caller | A1 |
| 0.7 | `backend/src/lib/embeddingCrypto.js` | edit | switch to `keyring` per-subject DEK; keep wire format; support `keyId` for rotation | — | enrollment, matcher | A1 |
| 0.8 | `backend/scripts/migrate-media-encrypt.js` | new | one-shot: walk existing plaintext blobs, seal in place, stamp `encKeyId`. Idempotent, resumable | storage + DB | ops | A1 |

**Gate:** `npx prisma migrate deploy` clean + `node scripts/migrate-media-encrypt.js` idempotent on rerun.

---

## WAVE 1 — Governance API (kills the seed script)

| # | File | Action | Purpose | Reads / Writes | Called by | Agent |
|---|---|---|---|---|---|---|
| 1.1 | `backend/src/modules/projects/project.service.js` | edit | add `createProject`, `updateDraft`, `submitForApproval`, `approveProject`, `rejectProject`, `listForRole`, `assignAgent`, `unassignAgent`. Enforce: submit requires purpose+retention+dataTypes+templateId; approve is `dpo` only and freezes `policyVersion` | `projects`, `project_assignments`, `audit_logs` | routes | A2 |
| 1.2 | `backend/src/modules/projects/project.routes.js` | edit | add `POST /`, `PATCH /:id`, `POST /:id/submit`, `POST /:id/approve`, `POST /:id/reject`, `POST /:id/assignments`, `DELETE /:id/assignments/:adminId`. Per-route `requireRole` exactly per matrix §B | — | `app.js` | A2 |
| 1.3 | `backend/src/modules/consentTemplates/consentTemplate.service.js` | new | CRUD + immutable versioning (published template never edits, only supersedes), multilingual `bodyByLocale Json`, `renderNotice(templateId, locale, projectMeta)` | `consent_templates` | routes, join flow | A2 |
| 1.4 | `backend/src/modules/consentTemplates/consentTemplate.routes.js` | new | `GET /`, `POST /`, `POST /:id/publish`, `GET /:id/render` | — | `app.js` | A2 |
| 1.5 | `backend/src/modules/sessions/session.service.js` | edit | `createSession` must reject `project.status != APPROVED` (403 `PROJECT_NOT_APPROVED`) | — | — | A2 |
| 1.6 | `backend/src/app.js` | edit | mount `/api/v1/consent-templates` | — | — | A2 |
| 1.7 | `backend/prisma/seed-project.js` | **delete** | replaced by real API; leaving it is a mock-data vector | — | — | A2 |
| 1.8 | `backend/prisma/seed-admin.js` | edit | keep — bootstrapping the first `super_admin` is real ops, not mock data. Force interactive password, refuse to run if any admin exists | `admin_users` | ops | A2 |

---

## WAVE 2 — Access logging + fail-closed redaction

| # | File | Action | Purpose | Reads / Writes | Called by | Agent |
|---|---|---|---|---|---|---|
| 2.1 | `backend/src/lib/accessLog.js` | new | `recordAccess({actorType, actorId, objectType, objectId, action, purpose, dsarRequestId, breakGlass, justification, req})`. Throws on failure — callers must not swallow | `access_events` | media routes, DSAR | A3 |
| 2.2 | `backend/src/middleware/logAccess.js` | new | wrapper `logAccess(objectType, resolveId)` applied to every media-serving + PII-returning route | — | routes | A3 |
| 2.3 | `backend/src/middleware/requireBreakGlass.js` | new | validates open `DsarRequest` binding + justification, writes `breakGlass` event, notifies DPO, mints 5-min single-use signed URL | `dsar_requests` | raw-media routes | A3 |
| 2.4 | `backend/src/modules/sessions/session.routes.js` | edit | attach `logAccess` to photo/face serving; raw-original route gated by `requireBreakGlass` for non-agent roles; agent route rejects once `session.status = ARCHIVED` | — | — | A3 |
| 2.5 | `backend/src/modules/sessions/session.service.js` | edit | **PII worker failure becomes fatal**: on `image-pii-worker` error set `Photo.piiStatus = DEFERRED`, do not write `redactedPath`, enqueue retry; ingest blocks while any `DEFERRED` exists in the batch | `photos` | finalize | A3 |
| 2.6 | `backend/src/workers/redaction.worker.js` | new | BullMQ retry queue for deferred PII/redaction, exponential backoff, dead-letter after 5 | `photos` | — | A3 |
| 2.7 | `backend/src/modules/audit/audit.service.js` | new | `listAudit(scope)` + `verifyChain(entityType, entityId)` recomputing HMAC chain | `audit_logs` | routes | A3 |
| 2.8 | `backend/src/modules/audit/audit.routes.js` | new | `GET /audit`, `GET /audit/verify`, `GET /access-events` — scoped per matrix | — | `app.js` | A3 |

---

## WAVE 3 — DSAR subsystem

| # | File | Action | Purpose | Reads / Writes | Called by | Agent |
|---|---|---|---|---|---|---|
| 3.1 | `backend/src/modules/dsar/dsar.service.js` | new | `createRequest` (subject), `listQueue(role, adminId)`, `assign`, `runDiscovery`, `attachEvidence`, `approveResolution`, `getRequest`. SLA: `slaDueAt = createdAt + 30d`, internal target 7d, status machine `RECEIVED → TRIAGE → DISCOVERY → EXECUTING → REVIEW → CLOSED / REJECTED` | `dsar_requests`, `dsar_evidence`, `audit_logs` | routes | A4 |
| 3.2 | `backend/src/modules/dsar/discovery.service.js` | new | lineage walk producing the location list: consents, photo links, originals, redacted, per-person cache, face crops, enrollments, vault objects, exports, index entries, backups(tombstone). Reuses `handoff.service.getLineage` | read-only across all | `dsar.service` | A4 |
| 3.3 | `backend/src/modules/dsar/purge.service.js` | new | **the erasure executor.** Per-location `PurgeJobLocation` rows; per-link deletion (never per-photo); triggers re-redaction when other subjects remain; destroys per-subject DEK last; resumable | everything | routes, worker | A4 |
| 3.4 | `backend/src/modules/dsar/export.service.js` | new | `ACCESS` fulfilment: builds package (profile, consents + timestamps, photo list w/ redacted derivatives, processing summary §11), per-export DEK, 30d TTL, single-use link | storage, DB | routes | A4 |
| 3.5 | `backend/src/modules/dsar/certificate.service.js` | new | issues `DeletionCertificate`: request id, subject pseudonym, locations count, per-location hashes-before, completedAt, Ed25519 detached signature over canonical JSON. **Stores its own record — audit chain is hash-only and cannot substitute** | `deletion_certificates` | purge | A4 |
| 3.6 | `backend/src/modules/dsar/dsar.routes.js` | new | all DSAR endpoints from matrix §B, per-route `requireRole` | — | `app.js` | A4 |
| 3.7 | `backend/src/modules/me/me.routes.js` | edit | `POST /me/dsar`, `GET /me/dsar`, `GET /me/dsar/:id`, `GET /me/dsar/:id/package` | — | — | A4 |
| 3.8 | `backend/src/workers/purge.worker.js` | new | executes `PurgeJob` async, idempotent per location, emits progress | — | — | A4 |
| 3.9 | `backend/src/workers/retention.worker.js` | new | cron: originals >7d post-archive, expired exports, expired project retention, expired access events | storage + DB | — | A4 |
| 3.10 | `backend/src/lib/revocation.js` | edit | on revoke, open an internal `DsarRequest{type: WITHDRAWAL_ERASURE, autoRaised:true}` so §6(4) withdrawal walks the same audited executor | — | — | A4 |
| 3.11 | `backend/src/app.js` | edit | mount `/api/v1/dsar`, `/api/v1/audit` | — | — | A4 |

---

## WAVE 4 — Portals (delete all mock data)

| # | File | Action | Purpose | Agent |
|---|---|---|---|---|
| 4.1 | `admin-portal/src/data/dpo.js`, `dataOwner.js`, `dataAdmin.js`, `collectionAgent.js` | **delete** | these are the mock-data source | A5 |
| 4.2 | `admin-portal/src/roles.js` | edit | strip hardcoded `stats`/`queue` arrays; keep nav config only; stats come from `GET /dashboard/summary` | A5 |
| 4.3 | `backend/src/modules/dashboard/dashboard.service.js` + `.routes.js` | new | one role-aware summary endpoint feeding every portal's stat tiles and queue — real counts, scoped per matrix | A5 |
| 4.4 | `admin-portal/src/lib/api.js` | edit | add typed clients for projects, templates, dsar, audit, handoffs, dashboard | A5 |
| 4.5 | `admin-portal/src/App.jsx` | edit | register real routes for all dpo/dataOwner/dataAdmin pages (currently only agent session routes are real) | A5 |
| 4.6 | `admin-portal/src/pages/dpo/{ProjectApprovals,ConsentTemplates,RequestOversight,SlaMonitoring,ComplianceReports}.jsx` | rewrite | API-backed; **pseudonymised subject refs only** | A5 |
| 4.7 | `admin-portal/src/pages/dataOwner/{CreateProject,MyProjects,DataRequirements,CollectionProgress,ProcessedData,ProjectReports}.jsx` | rewrite | CreateProject → real `POST /projects` + submit; ProcessedData shows redacted derivatives only | A5 |
| 4.8 | `admin-portal/src/pages/dataAdmin/{DsarQueue,DiscoveryWorkspace,EvidenceVault,DataLineage,PurgeExport,AuditLogs}.jsx` | rewrite | wired to `/dsar`, `/handoffs/lineage`, `/audit`; break-glass modal forces justification text | A5 |
| 4.9 | `user-portal/src/pages/` | add | `MyData.jsx` (§11 summary), `MyConsents.jsx` (grant/withdraw), `RaiseRequest.jsx` (§12/§13), `RequestStatus.jsx` w/ SLA countdown, `SecureInbox.jsx`, `Certificate.jsx` | A5 |
| 4.10 | `user-portal/src/pages/Join.jsx` (or join flow) | edit | render the notice from `GET /consent-templates/:id/render` in chosen locale before the signature control; disable signature until scrolled | A5 |

---

## WAVE 5 — Verification (real pipeline, no stubs)

| # | File | Action | Purpose | Agent |
|---|---|---|---|---|
| 5.1 | `backend/tests/e2e/full-lifecycle.test.js` | new | live Postgres + face-worker + pii-worker. Real admin invite → real project create/approve/assign → real session → real QR join → real OTP → real consent → **real photo files from `tests/fixtures/real-captures/`** → real recognition → tag → finalize → verify handoff + `photo_subjects` + `redactedPath` exists and original is unreadable via API | A6 |
| 5.2 | `backend/tests/e2e/dsar-erasure.test.js` | new | 2-subject photo; subject A erases; assert A's link+crops gone, **photo still exists for B**, A blurred in re-redacted derivative, A's DEK destroyed, certificate signature verifies | A6 |
| 5.3 | `backend/tests/security/rbac-matrix.test.js` | new | table-driven: iterate every route × every role, assert exactly the matrix in `02_ROLE_PERMISSION_MATRIX.md`. Fails on any new unlisted route | A6 |
| 5.4 | `backend/tests/security/crypto.test.js` | new | blob on disk has no JPEG magic; tamper a byte → GCM auth failure; embedding round-trip; DEK destruction makes decrypt impossible | A6 |
| 5.5 | `backend/tests/security/audit-chain.test.js` | new | chain verify passes; a manual row edit makes it fail; `UPDATE`/`DELETE` on `audit_logs` rejected by RLS | A6 |
| 5.6 | `docs/DPIA.md` | new | §10 DPIA: risks, mitigations, residual risk (backups), sign-off block | A6 |
| 5.7 | `docs/RUNBOOK_BREACH.md` | new | 72h DPB notification, principal notification template, key-rotation drill | A6 |
| 5.8 | `ops/preflight.md` + `scripts/preflight.js` | new | asserts prod-readiness: `AUDIT_HMAC_SECRET`/`MEDIA_KEK` not defaults, TLS on, Redis ≥6.2, RLS active, no `seed-project.js` present | A6 |

---

## Dependency graph

```
WAVE0 ─┬─> WAVE1 ─┬─> WAVE4
       ├─> WAVE2 ─┤
       └─────────> WAVE3 ─┘
                          └─> WAVE5 (gates release)
```
WAVE1, WAVE2, WAVE3 can run in parallel once WAVE0's migration lands. WAVE4 needs 1+2+3 endpoints to exist (contract can be stubbed from this doc so UI work starts early — but UI must be re-verified against live endpoints before sign-off).

---

## Hard invariants — any PR violating one is rejected

1. No file under `admin-portal/src/data/` may exist.
2. No service may read `Subject.generalTerms/piiProcessing/biometricMatch` — `project_consent_matrix` is the sole authority.
3. Face embeddings are never returned by any route, never written to Qdrant persistently, never logged.
4. `Photo.storagePath` original is never overwritten; redaction always writes a new object.
5. Erasure never deletes a photo that another subject still lawfully appears in.
6. Every media read writes an `AccessEvent` before decryption.
7. `writeAuditLog` payload plaintext is never persisted — use `DeletionCertificate` / `DsarEvidence` when content must be provable.
8. Redaction failure fails closed; the original is never served as a fallback.
9. All secrets from env; `preflight.js` refuses to boot prod on defaults.
