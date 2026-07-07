# Prism Backend — Implementation Plan & Schema Design
### Planning Phase Only — No Code Written Yet

**Scope:** backend for the Prism DPDP 2023 Consent Management Platform — covers the consent-capture pipeline, identity↔consent mapping, media storage, revocation/purge, and DSAR, sitting behind the existing `user-portal` and `admin-portal` frontends.

**Version:** v3 (final) — changelog at the bottom of each section shows what changed from v1 → v2 → v3.

---

## Step 0 — Context gathered

Read from `context/` (flow diagrams, DPDP CMP & DSAR data-lineage doc, worklet problem statement) and from the two built frontends (`user-portal`, `admin-portal`):

- Enrollment flow: OTP verify → consent notice (DPO-approved template) → 3-tier consent capture (`general_terms` / `pii_processing` / `biometric_matching`, each independently revocable) → digital signature + HMAC → ID generation (`master_user_id`, `project_id`, `consent_id`) → audit ledger write, status `ACTIVE`.
- Edge capture & redaction: capture (image/video/audio/text) → parallel PII detection → consent-tier gate check → redact/block or release → build consent asset metadata → AES-256 encrypt → store → audit log.
- Biometric match: on-device ArcFace embedding → Qdrant ANN search → backend revalidates consent by `consent_id` → auto-tag if active, else PII_STRICT redaction.
- Revocation & purge: Redis hotlist write first (closes race window) → Postgres `consent_status = REVOKED` → trigger inserts `consent_history` → trigger creates `purge_jobs` row (24h SLA) → orchestrator cascades delete in Qdrant then `media_assets` → certificate → audit log.
- DSAR: rate-limited request → `dsar_requests` row (30-day SLA) → assigned to DPO/admin → routed by type (ACCESS/PORTABILITY/CORRECTION/DELETION/GRIEVANCE) → response dispatched → logged.

**Assumptions made (context was silent or ambiguous on these):**
1. No real database has been provisioned by Samsung yet — building on self-hosted Postgres (Docker), designed for painless migration later (see prior conversation — no Supabase Auth/Edge Functions, no vendor lock-in).
2. Auth is custom JWT (access + rotating refresh token), not a third-party auth vendor.
3. Redis is assumed available for the hotlist/rate-limit mechanisms described in the docs — added to local Docker Compose stack.
4. Qdrant (vector DB for face embeddings) is out of scope for the *first* backend milestone — biometric matching is phase-gated later since it also carries the heaviest legal-review burden under DPDP.
5. "Project" in the schema = a data-collection initiative (e.g. "Face Recognition Training v4.2") that a Data Owner creates and subjects consent into — this matches what both frontends already display.

---

## 1. Architecture Overview

```
user-portal (React)          admin-portal (React)
        │                            │
        └──────────┬─────────────────┘
                    │  HTTPS / JSON
                    ▼
          backend API (Node.js + Express)
          ├─ /auth        (JWT issue/refresh/revoke)
          ├─ /consent     (capture, revoke, history)
          ├─ /media       (asset intake, redaction linkage)
          ├─ /purge       (job queue, worker)
          └─ /dsar        (request intake, routing, response)
                    │
       ┌────────────┼─────────────────┐
       ▼            ▼                 ▼
   Postgres      Redis              (later) Qdrant
   (Prisma ORM)  (hotlist, rate     (biometric vectors —
   source of      limits, OTP)      phase-gated, not in
   truth                            first milestone)
```

- **Backend:** Node.js + Express, Prisma ORM against Postgres. Plain REST — no framework lock-in, portable to any Node host.
- **Auth:** custom JWT — short-lived access token (15 min) + rotating refresh token (7 day, single-use, reuse-detection revokes the whole token family), refresh token stored server-side as a SHA-256 hash, delivered via `httpOnly`/`secure`/`sameSite=strict` cookie scoped to `/auth/refresh`.
- **Local dev infra:** `docker-compose.yml` running Postgres + Redis. No cloud account required. Schema lives in Prisma migration files in the repo, so any teammate gets an identical DB with one command.
- **Encryption:** application-level AES-256 per media asset (key ref stored, not the key itself, in Postgres — actual keys in a separate secrets store/KMS-equivalent later).

*(v1 note: originally proposed Supabase-hosted Postgres for "convenience". Self-review in Step 2 flagged this as contradicting the no-lock-in decision already made earlier in this project's conversation — corrected in v2 to Docker Compose.)*

---

## 2. Data / Schema Design

| Table | Key fields | Notes |
|---|---|---|
| `users` | `id`, `email`, `password_hash`, `role` (`dpo`, `data_owner`, `collection_agent`, `data_admin`), `created_at` | Admin-portal principals only |
| `data_subjects` | `master_user_id` (UUID, PK), `name`, `email`, `phone`, `otp_verified_at` | The consenting individual (user-portal) |
| `projects` | `project_id` (UUID, PK), `name`, `owner_user_id` FK→users, `purpose`, `policy_version`, `created_at` | e.g. "Face Recognition Training v4.2" |
| `consent_notice_templates` | `id`, `project_id` FK, `version`, `content`, `approved_by` FK→users, `approved_at` | DPO-approved copy shown at consent time |
| `project_consent_matrix` | `consent_id` (UUID, PK), `master_user_id` FK, `project_id` FK, `general_terms` bool, `pii_processing` bool, `biometric_matching` bool, `status` (`ACTIVE`/`REVOKED`/`PURGED`), `signature_hash`, `created_at`, `revoked_at` | One row per subject × project |
| `consent_history` | `id`, `consent_id` FK, `event_type` (`GRANTED`/`REVOKED`/`PURGED`), `payload_hash`, `prev_hash`, `created_at` | Hash-chained, INSERT-only |
| `media_assets` | `id`, `consent_id` FK, `modality` (`image`/`video`/`audio`/`text`), `storage_path`, `redaction_status`, `pii_detected` (jsonb), `encryption_key_ref`, `retention_until`, `created_at` | Linked to identity via `consent_id`, never directly to `master_user_id` |
| `purge_jobs` | `id`, `consent_id` FK, `trigger_type` (`REVOKE`/`DSAR`), `status` (`PENDING`/`SOFT_DELETED`/`COMPLETED`), `assets_targeted`, `assets_purged`, `sla_deadline`, `created_at`, `completed_at` | Queue table, drained by a worker |
| `dsar_requests` | `id`, `master_user_id` FK, `type` (`ACCESS`/`CORRECTION`/`PORTABILITY`/`DELETION`/`GRIEVANCE`), `status`, `assigned_to` FK→users, `sla_deadline`, `response_sent_at`, `created_at` | |
| `audit_log` | `id`, `actor_id`, `action`, `entity_type`, `entity_id`, `prev_hash`, `hash`, `created_at` | Global tamper-evident ledger — see below |

**Relationships:** `data_subjects (1) → (N) project_consent_matrix (N) → (1) projects`; `project_consent_matrix (1) → (N) media_assets`; `project_consent_matrix (1) → (N) consent_history`; `project_consent_matrix (1) → (0..N) purge_jobs`; `data_subjects (1) → (N) dsar_requests`.

**Indexes:** `project_consent_matrix(master_user_id, project_id)` unique; `media_assets(consent_id)`; `purge_jobs(status, sla_deadline)`; `dsar_requests(status, sla_deadline)`; `audit_log(entity_type, entity_id, created_at)`.

**Deletion strategy** (research-informed, see Step 3): two-phase — `purge_jobs` moves a consent's assets to `SOFT_DELETED` (hidden, not queryable, but recoverable) immediately, then a scheduled sweep performs the irreversible hard delete after the grace period, writing row counts to `audit_log` at both phases. This matches the current architecture's 24h SLA better than an immediate hard delete, and gives a recovery window if a revoke was accidental.

**Audit log integrity** (research-informed): `audit_log` is INSERT-only — the app's DB role has no `UPDATE`/`DELETE` grant on it, enforced by a Postgres `REVOKE` plus a blocking trigger as a second layer. Each row's `hash` = `HMAC-SHA256(prev_hash + canonical(row))`, so any historical edit breaks the chain from that point forward — this is what "hash-chained, immutable" in the original architecture doc concretely means in Postgres terms.

*(v2 note: v1 had `audit_log` as a soft convention — "app always inserts, never updates." Self-review flagged that this is not actually enforced anywhere. v3 adds the `REVOKE`+trigger+HMAC chain from the research pass.)*

---

## 3. Phase-wise Breakdown

### Phase 0 — Local dev infrastructure
- **Tasks:** `docker-compose.yml` (Postgres + Redis), Prisma init, repo scaffold (`backend/`), `.env.example`, seed script skeleton.
- **Dependencies:** none.
- **Effort:** small (half a day).
- **Definition of done:** `docker compose up && npx prisma migrate dev` gives any teammate an identical empty schema.

### Phase 1 — Auth
- **Tasks:** `users` table + migration, signup/login endpoints, bcrypt hashing, JWT access token, rotating refresh token with reuse detection (per research above), role-based middleware for the 4 admin-portal roles.
- **Dependencies:** Phase 0.
- **Effort:** medium (1–2 days).
- **Definition of done:** admin-portal's role-picker login exchanges credentials for a real session; `RequireRole` guard checks a real JWT claim instead of `localStorage`.

### Phase 2 — Consent capture pipeline
- **Tasks:** `data_subjects`, `projects`, `consent_notice_templates`, `project_consent_matrix`, `consent_history` (with hash chain) tables + migrations; OTP verify endpoint (stubbed OTP provider for now); consent-capture endpoint (3-tier, signature hash, ID generation); revoke endpoint.
- **Dependencies:** Phase 1 (need an authenticated Data Owner to create a `project`; need `data_subjects` to exist for user-portal's Verify flow to write to).
- **Effort:** large (3–4 days) — this is the core of the system.
- **Definition of done:** user-portal's Verify → Dashboard flow creates a real `project_consent_matrix` row; Consent Hub's revoke toggle flips real `status`; a row appears in `consent_history`.

### Phase 3 — Media intake & redaction linkage
- **Tasks:** `media_assets` table; upload endpoint that checks consent tier is `ACTIVE` before accepting; PII-detection integration point (stub returning "no PII found" until a real Presidio/YOLO service is wired in — flagged as an open question below); encryption-key-ref generation.
- **Dependencies:** Phase 2 (needs a `consent_id` to attach assets to).
- **Effort:** medium (2 days), larger once real PII detection is wired in.
- **Definition of done:** admin-portal's Collection Agent dashboard "Capture & Upload" can create a real `media_assets` row gated on live consent status.

### Phase 4 — Revocation & purge orchestration
- **Tasks:** Redis hotlist write on revoke; Postgres trigger → `purge_jobs` row creation; worker process draining `purge_jobs` (soft-delete now, hard-delete after grace period); purge certificate generation; audit log entries at each phase.
- **Dependencies:** Phase 2 & 3 (needs real consent + assets to purge).
- **Effort:** medium (2 days).
- **Definition of done:** revoking a consent in Consent Hub actually results in that identity's `media_assets` being soft-deleted within the SLA, then hard-deleted after the grace window, with an audit trail.

### Phase 5 — DSAR
- **Tasks:** `dsar_requests` table; rate limiting via Redis; intake endpoint; routing logic per type (`ACCESS`/`PORTABILITY` → export query; `CORRECTION` → update; `DELETION` → creates a `purge_jobs` row, reusing Phase 4's worker); response dispatch stub (email/notification later).
- **Dependencies:** Phase 2, 3, 4 (a DSAR acts on data those phases produce).
- **Effort:** medium (2–3 days).
- **Definition of done:** admin-portal's DSAR Queue / Data Rights screens show real requests; a `DELETION` request actually drives Phase 4's purge worker end-to-end.

### Phase 6 — Frontend integration
- **Tasks:** replace every hardcoded array (`PROJECTS`, `REQUESTS`, `ROLES` stats/queue) in both frontends with real API calls; add loading/error states.
- **Dependencies:** all prior phases.
- **Effort:** medium (2–3 days), can start incrementally per-phase rather than all at the end.

*(v2 note: v1 had Phase 3 and Phase 4 combined into one phase. Self-review flagged that media intake and purge orchestration have almost no shared code and different owners in the frontend (Collection Agent vs Data Admin) — split into two phases in v2/v3 so they can be built and reviewed independently.)*

---

## 4. Risks & Open Questions

1. **PII/biometric detection is stubbed, not real, in Phase 3.** Wiring in an actual model (Microsoft Presidio for text, a YOLO/face-detection model for images) is a separate, non-trivial integration — needs its own scoping pass once Phase 3's plumbing exists.
2. **Biometric consent (`biometric_matching` tier) carries extra legal weight under DPDP** — recommend a legal/DPO review checkpoint before Qdrant/face-embedding storage is built, independent of the engineering timeline.
3. **Encryption key management** — Phase 3 stores a `encryption_key_ref`, not the key. Where the actual keys live (env-based KMS stand-in for now vs. a real KMS later) needs a decision before Phase 3 starts, not during it.
4. **Row-level access control for admin roles** — do DPO/Data Owner/Collection Agent/Data Admin need to be scoped to specific `projects` (multi-tenant-style), or do all admin roles see all projects? Current admin-portal UI implies "role-scoped," not "project-scoped" — confirm before Phase 1's role middleware is finalized.
5. **OTP delivery provider** is unspecified — Phase 2 stubs it; needs a real SMS/email provider decision before user-portal's Verify screen is real.
6. **Redis is newly introduced in this plan** (hotlist + rate limiting) — confirm this is an acceptable addition to the local dev stack, or whether Postgres-only alternatives (advisory locks, a rate-limit table) are preferred to keep the stack smaller.

---

## Summary — what needs your input before implementation starts

- Confirm the **phase order** above (Auth → Consent Capture → Media → Purge → DSAR → Frontend wiring) is right, or reorder if a different priority matters more.
- Decide on **open questions 3–6** above — especially whether admin roles should be project-scoped (#4), since that changes Phase 1's design.
- Say the word and Phase 0 (Docker Compose + Prisma scaffold) can start — it has no open questions blocking it.

### Sources
- [Database Design and the GDPR](https://dev.to/cerchie/database-design-and-the-gdpr-463p)
- [GDPR-Compliant User Service: Node.js + PostgreSQL](https://www.wellally.tech/blog/gdpr-user-data-nodejs-postgres-guide)
- [Tamper-evident audit trails in PostgreSQL with hash chaining](https://appmaster.io/blog/tamper-evident-audit-trails-postgresql)
- [How to build an immutable audit log with HMAC hash chaining](https://tracehold.ai/blog/immutable-audit-log-hmac-hash-chain/)
- [Auth.js — Refresh Token Rotation](https://authjs.dev/guides/refresh-token-rotation)
- [How to Build Token Rotation Strategies](https://oneuptime.com/blog/post/2026-01-30-token-rotation-strategies/view)
- [Best Practices for Implementing Automated, Scalable, and Auditable Purge Mechanism](https://community.databricks.com/t5/data-engineering/best-practices-for-implementing-automated-scalable-and-auditable/td-p/152943)
- [Soft Deletes vs Hard Deletes in Data Architecture](https://www.nilus.be/blog/soft_deletes_vs_hard_deletes_in_data_architecture/)
