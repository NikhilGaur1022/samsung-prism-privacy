# Deliverable 5 — Prompt to paste into a fresh chat

Copy everything between the rules.

---

I am building **Samsung PRISM** — a DPDP Act 2023 compliant Consent Management + DSAR platform for supervised photo/biometric data collection. Repo: `C:\Users\gaur3\Desktop\Projects\samsung project`.

**Read these four docs first, in order. They are the complete spec. Do not re-derive them.**
- `docs/01_PRIVACY_DATAFLOW.md` — end-to-end data flow, encryption architecture, retention/deletion, failure paths, DPDP section map
- `docs/02_ROLE_PERMISSION_MATRIX.md` — 1 subject role + 5 admin tiers, endpoint-level allow/deny, break-glass protocol
- `docs/03_FILE_IMPLEMENTATION_PLAN.md` — file-by-file plan in 6 waves, with purpose / reads / writes / callers per file
- `docs/04_AGENT_EXECUTION_PLAN.md` — subagent assignment + token budgets

## Stack (already running, do not rebuild)
- `backend/` Node + Express + Prisma + Postgres, `src/modules/<n>/<n>.{routes,service}.js`, mounted in `src/app.js` under `/api/v1`
- `admin-portal/` React+Vite (5 admin roles), `user-portal/` React+Vite (data principal)
- `face-worker/` Python FastAPI :8001 — InsightFace buffalo_l detect/embed/redact
- `ai-core/image-pii-worker` Python FastAPI :8002 — OCR + Presidio Indian PII recognizers
- Redis/BullMQ for `recognition.worker.js` (**note: local Redis is 5.0.14, BullMQ needs ≥6.2 — upgrade before wave 2**)

## What already works (real, do not rewrite)
Admin auth + invite/reset, subject OTP auth, refresh-token families, session lifecycle, QR `SessionInvite`, consent capture into `project_consent_matrix`, 5-pose enrollment, AES-256-GCM encrypted embeddings, recognition queue + clustering + auto-tag, `finalizeSession` with mid-session consent re-check, bystander face blur, Presidio PII masking, `session_handoffs` emit/list/ingest, `/handoffs/lineage`, HMAC hash-chained `AuditLog`.

## What is missing (the job)
1. Project creation + DPO approval + agent assignment API — today projects exist **only** via `prisma/seed-project.js`
2. `ConsentTemplate` model, versioning, multilingual §5 notice rendering
3. Entire DSAR subsystem: request, SLA clock, discovery, evidence, purge executor, export packager, signed deletion certificate
4. `AccessEvent` read-logging + break-glass middleware
5. Media encryption at rest (embeddings are encrypted; **photo blobs are plaintext on disk**)
6. Retention sweeper
7. Multi-subject-safe erasure (today nothing stops a per-photo delete destroying a co-appearing subject's lawful data)
8. PII-worker failure is currently **non-fatal** — must fail closed
9. All `dpo`/`dataOwner`/`dataAdmin` portal screens read hardcoded arrays from `admin-portal/src/data/*.js`

## Execution instructions
Follow `docs/04_AGENT_EXECUTION_PLAN.md` exactly:
- Spawn **one subagent per wave**, batching every file of that wave into a single invocation. Never one agent per file.
- Give each agent only: the shared context block (in doc 04), its own wave table from doc 03, and its explicit read-list. Do not paste file contents into prompts — give paths.
- Each agent returns a ≤300-token summary (files touched, deviations, blockers). Not diffs.
- Track progress with the checklist in doc 04. Do not re-send specs between waves.
- Order: **A1 (schema+crypto) must finish first.** Then A2 and A3 in parallel. Then A4. Then A5. Then A6 as the release gate.

Start by spawning **A1 (schema-crypto-agent)** for WAVE 0 rows 0.1–0.8. Report back before spawning wave 1.

## Non-negotiable invariants — reject any change that breaks one
1. **No mock, seed, dummy, sample, or placeholder data at any layer.** Delete `backend/prisma/seed-project.js` and all of `admin-portal/src/data/`. Every number on every screen must trace to a real query. (`seed-admin.js` survives only as first-`super_admin` bootstrap, hardened.)
2. `project_consent_matrix` is the **sole** consent authority. Never read `Subject.generalTerms` / `piiProcessing` / `biometricMatch` in media-intake, purge, or DSAR logic — they are intake-time UX defaults.
3. Face embeddings never leave the process: no route returns them, never persisted outside the encrypted column, never logged.
4. `Photo.storagePath` (the original) is never overwritten. Redaction always writes a new object.
5. Erasure is **per `PhotoSubject` link, never per photo**. If subject A erases from a photo also containing B: drop A's link + A's face crops, re-redact so A is blurred, keep the photo for B.
6. Every media read writes an `AccessEvent` **before** decryption. If the log write fails, the read fails.
7. `AuditLog` stores hashes only, never payload plaintext — anything that must be provable later goes in `DeletionCertificate` or `DsarEvidence`.
8. Redaction/PII failure fails **closed**. The raw original is never served as a fallback.
9. All secrets from env. `scripts/preflight.js` must refuse to boot production on default `AUDIT_HMAC_SECRET` or `MEDIA_KEK`.
10. Least privilege is enforced in `requireRole` + a service-layer scope assertion. UI hiding is never the control. Specifically: DPO sees **no** subject identity or media; Data Owner sees **no** raw originals; Collection Agent loses all access the moment the session hits `ARCHIVED`; Data Team Admin reaches raw media only inside an open DSAR with written justification.

## Definition of done
`docs/03_FILE_IMPLEMENTATION_PLAN.md` WAVE 5 passes:
- `full-lifecycle.test.js` — real admin → real project create/approve/assign → real session → real QR join → real OTP → real consent → real photo files → recognition → tagging → finalize → handoff ingest, no stubs
- `dsar-erasure.test.js` — two-subject photo, A erases, B's copy survives and A is blurred, A's DEK destroyed, certificate signature verifies
- `rbac-matrix.test.js` — every mounted route × every role matches doc 02 exactly, and fails on any unclassified route
- `crypto.test.js` — blobs on disk have no JPEG magic bytes, tampering triggers GCM auth failure
- `audit-chain.test.js` — chain verifies, a manual row edit breaks it, `UPDATE`/`DELETE` blocked by RLS
- `scripts/preflight.js` green

Ask me before: dropping any existing table, changing the `photo_subjects` shape, or altering `finalizeSession`'s transaction boundary.

---
