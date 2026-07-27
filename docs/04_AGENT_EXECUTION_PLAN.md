# Deliverable 4 — Multi-Agent Execution Plan (token-budgeted)

Principle: **one agent per wave, one invocation per agent, all files for that wave batched into it.** Never one agent per file. Never re-send the full spec — each agent gets a pointer to the doc section it owns plus the shared invariants block.

---

## Agent roster

| ID | Name | Owns | Wave | Files | Model | Ctx budget (in) | Out budget |
|---|---|---|---|---|---|---|---|
| A1 | schema-crypto-agent | schema, migrations, keyring, blob crypto, storage, backfill | 0 | 8 | opus | ~25k | ~12k |
| A2 | governance-api-agent | project CRUD + approval + assignment, consent templates | 1 | 8 | sonnet | ~20k | ~10k |
| A3 | access-guard-agent | access logging, break-glass mw, fail-closed redaction, audit API | 2 | 8 | sonnet | ~20k | ~10k |
| A4 | dsar-agent | DSAR service, discovery, purge, export, certificate, workers | 3 | 11 | opus | ~30k | ~18k |
| A5 | portal-agent | admin-portal + user-portal rewrites, mock deletion, dashboard API | 4 | 10+ | sonnet | ~25k | ~20k |
| A6 | security-review-agent | e2e + RBAC matrix + crypto tests, DPIA, runbook, preflight | 5 | 8 | opus | ~30k | ~15k |

Total planned ≈ **150k in / 85k out**, versus roughly 600k+ if every file were its own agent call with the full spec re-sent.

---

## Shared context block (≤1.2k tokens, prepended to every agent prompt)

```
REPO: C:\Users\gaur3\Desktop\Projects\samsung project
Stack: Node/Express + Prisma/Postgres, React(Vite) admin-portal + user-portal,
       Python face-worker :8001 (InsightFace buffalo_l), image-pii-worker :8002 (Presidio), Redis/BullMQ.
Conventions: backend/src/modules/<n>/<n>.routes.js + <n>.service.js ; mount in src/app.js under /api/v1 ;
       shared primitives in src/lib ; middleware in src/middleware ; hand-written SQL migrations.
INVARIANTS (violating any = reject):
 1 no mock/seed/placeholder data anywhere; no admin-portal/src/data/*
 2 project_consent_matrix is the only consent authority; never read Subject.generalTerms/piiProcessing/biometricMatch
 3 face embeddings never leave the process; no route returns them; never logged
 4 Photo.storagePath original never overwritten
 5 erasure is per PhotoSubject link, never per photo — other subjects' data survives
 6 every media read writes an AccessEvent before decrypt
 7 audit log stores hashes only; provable content goes in DeletionCertificate/DsarEvidence
 8 redaction failure fails closed; never serve the original as fallback
 9 all secrets from env
Read docs/03_FILE_IMPLEMENTATION_PLAN.md section "<YOUR WAVE>" and docs/02_ROLE_PERMISSION_MATRIX.md.
Do not read other waves' sections.
```

---

## Per-agent brief

### A1 — schema-crypto-agent (must complete first, blocks all)
Read: `backend/prisma/schema.prisma`, `src/lib/storage.js`, `src/lib/embeddingCrypto.js`, one existing migration for SQL style.
Deliver: WAVE 0 rows 0.1–0.8.
Done when: `prisma migrate deploy` clean on a fresh DB; `blobCrypto` round-trips; tampered byte → GCM failure; backfill script idempotent.
Do not: touch any route, service, or UI file.

### A2 — governance-api-agent
Read: `modules/projects/*`, `middleware/requireRole.js`, `lib/auditLog.js`, `app.js`, matrix §B Governance.
Deliver: WAVE 1 rows 1.1–1.8 including **deleting `prisma/seed-project.js`**.
Done when: a project can be created → submitted → approved → assigned entirely over HTTP; session creation 403s on a non-APPROVED project.
Do not: touch DSAR, crypto, or UI.

### A3 — access-guard-agent
Read: `modules/sessions/session.service.js` (`finalizeSession`, `redactImage`, serving routes), `lib/auditLog.js`, `workers/recognition.worker.js` for BullMQ style.
Deliver: WAVE 2 rows 2.1–2.8.
Done when: every media route emits an `AccessEvent`; killing image-pii-worker leaves photos `DEFERRED` and blocks ingest instead of shipping unmasked PII; chain verify endpoint detects a tampered row.
Do not: implement DSAR endpoints — only the break-glass middleware's *interface* against `DsarRequest`, which A1's schema provides.

### A4 — dsar-agent (largest, run after A1; A3's `requireBreakGlass` is a dependency — coordinate or stub the import)
Read: `modules/handoff/handoff.service.js` (`getLineage` is the discovery seed), `lib/revocation.js`, `lib/consent.js`, `lib/storage.js`, `lib/keyring.js`, matrix §B DSAR.
Deliver: WAVE 3 rows 3.1–3.11.
Done when: subject raises erasure → DPO assigns → owner attaches evidence → admin executes → every location reports done → signed certificate verifies → a co-appearing subject's photo survives and is re-redacted.
Do not: write UI.

### A5 — portal-agent
Read: `admin-portal/src/{App.jsx,roles.js,lib/api.js}`, one working agent page (`pages/collectionAgent/Tagging.jsx`) as the style reference, matrix §D.
Deliver: WAVE 4 rows 4.1–4.10.
Done when: `grep -r "MY_PROJECTS\|DATA_REQUIREMENTS\|PROJECT_APPROVALS\|COLLECTION_PROGRESS"` returns nothing; every stat tile traces to a real query; DPO screens render no subject names.
Do not: change backend business logic — report contract mismatches back instead.

### A6 — security-review-agent (gate)
Read: this doc + 01 + 02, plus final source.
Deliver: WAVE 5 rows 5.1–5.8, and a written pass/fail against all 9 invariants.
Done when: RBAC table test enumerates every mounted route with no unclassified route; e2e passes against live workers with real fixture images.
Do not: relax a test to make it pass — report the defect.

---

## Orchestration checklist (the orchestrator holds only this, not the specs)

```
[ ] A1 schema+crypto        blocks: all          status: ____  notes: ____
[ ] A2 governance API       blocks: A5           status: ____  notes: ____
[ ] A3 access guard         blocks: A4(soft),A5  status: ____  notes: ____
[ ] A4 DSAR                 blocks: A5           status: ____  notes: ____
[ ] A5 portals              blocks: A6           status: ____  notes: ____
[ ] A6 security review      gate                 status: ____  notes: ____
```
Between waves the orchestrator re-reads only this checklist plus the returning agent's summary (≤300 tokens each). It never re-reads the wave specs.

Wave 1/2 run in parallel after wave 0. Wave 3 starts once wave 0 lands and `requireBreakGlass` exists as a signature. Wave 4 starts on real endpoints only. Wave 5 last.

## Token discipline rules
1. Agent prompt = shared block + its own wave table + explicit read-list. Nothing else.
2. Agent returns ≤300-token summary: files touched, deviations, blockers. Not diffs.
3. Never paste file contents into a prompt — give paths; the agent reads what it needs.
4. Batch fixes: one follow-up invocation per agent carrying all review findings, not one per finding.
5. If an agent needs another wave's file, it reports the dependency; the orchestrator sequences it. It does not read that wave's spec.
