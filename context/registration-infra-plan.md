# Prism Backend — Infra Scaffold + Data Subject Registration
### Planning Phase Only — No Code Written Yet — v3 (post scale/architecture review, target: 5000 photos/day)

**Scope (locked in with user):** local dev infra (Supabase-hosted Postgres via Prisma, local-Docker Qdrant, local disk for media blobs) + the Data Subject Registration feature (schema + API + frontend wiring). Excludes: consent-capture pipeline detail, PII/redaction engine, media intake, purge/DSAR, audio pipeline — separate future plans. This v3 pass evaluates whether this foundation architecturally holds up once those future phases land at a **5000 photos/day** target — it does not implement those phases.

Carries forward from `context/backend-plan.md` (v3): 3-tier consent model, hash-chained audit log, Node+Express+Prisma shape.

*(v1→v2: research + critical review of the registration feature itself — 18 findings, folded in. v2→v3: 4 parallel agents fanned out — Postgres/Supabase at scale, Qdrant at scale, media-pipeline throughput, and a cold architecture review of this plan against those futures — findings below.)*

---

## 0. Decisions locked this session

1. **Subject groups (5, WA list authoritative):** `SAMSUNG_EMPLOYEE`, `EX_SAMSUNG_EMPLOYEE`, `SEED_LAB_EMPLOYEE`, `EX_SEED_LAB_EMPLOYEE`, `VOLUNTEER`.
2. **Relational DB:** Supabase Postgres, accessed only via Prisma (no Supabase Auth/Storage/RLS).
3. **Vector DB:** Qdrant, self-hosted Docker — stood up now, unused by this phase's code.
4. **Media storage:** local disk, abstracted — unused by this phase.
5. **Sequencing:** registration exists before capture; capture tags `subject_id` at source.

## 1. Open questions — CONFIRMED (user sign-off received)

1. **Ex-employee semantics — CONFIRMED:** departure doesn't auto-void consent. Group tag changes, consent flags don't.
2. **Registration channel — CONFIRMED:** both self-service (user-portal) and agent-assisted (admin-portal) coexist, tracked via `registrationChannel`.
3. **Approval gate — CONFIRMED, revised from v3 default.** Checked `context/dataflow diagram dsar.jpg` and `context/2023 dpdp cmp and dsar portal data lineage graph.jpg` per user's instruction to verify against the diagrams before deciding. Neither shows a DPO-approval checkpoint on individual subject registration — the DSAR flowchart's step 5 is "Data Subject Portal: Authenticates, signs consent & provides data" flowing directly from step 4 ("Generates consent link & workspace"), with DPO approval only appearing at step 2 ("Approves project & provides consent template") — a one-time, per-project/per-template approval, not per-subject. **Resolution: no DPO approval gate on registration. OTP verification alone moves a subject to `ACTIVE`.** This changes §5/§9/§10 below from the v3 draft — see inline notes.
4. **Dedupe key — CONFIRMED:** `employeeRef` primary for employee groups, normalized email fallback for volunteers.
5. **Auth on this phase's endpoints — CONFIRMED:** fail-closed dev-stub middleware, boot-time refusal in production without real auth wired.

---

## 2. Scale & architecture review — verdict summary (v3, new)

Target evaluated: **5000 photos/day**, bursty (Seed Lab sessions, not evenly spread), against the infra this plan stands up.

| Layer | Verdict | Why |
|---|---|---|
| **Postgres/Supabase** | **Fine, with config discipline** | 5000 rows/day (~1.8M/yr) is small for Postgres; even a 100x burst is ~6 inserts/sec. Real limits are connection-count-based (Supavisor pooler ceiling scales with compute tier, not row volume), not throughput-based. Caveat: set an explicit low Prisma `connection_limit` (see §6), and keep any future jsonb columns (e.g. PII-detection results) small and append-mostly — repeated updates to a large jsonb column cause TOAST bloat. |
| **Qdrant** | **Fine day-1, flag a re-architecture trigger** | Insertion rate is noise. What degrades is query latency/RAM as the HNSW graph grows across *years* of accumulation. Flag now: revisit (quantization, or a bigger box) around **5–10M vectors (~2.7–5.5 years at this rate)** — not a day-1 concern, but should be a known tripwire, not a surprise. |
| **Media ingestion (future phase)** | **Cannot be "just another sync REST endpoint" — must be async** | Full per-photo CPU pipeline (face detect+embed, object/PII detect, redact) realistically runs 0.5–3+ seconds/image on CPU. A burst of hundreds of photos in a 10-minute Seed Lab session needs throughput a synchronous single chain can't absorb without HTTP timeouts and duplicate-processing-on-retry. **This isn't a concern for the current registration-only phase's code**, but the decision needs reserving now (§7) so it isn't discovered as a rearchitecture when media intake starts. |
| **This plan's own architecture (registration feature)** | **Had 6 real bugs, not just style nits** | See §3 — mostly fixed below; two left as explicit forward-looking decisions. |

Sources for the above (full detail in prior research turn): Supabase Supavisor/connection-management docs, Qdrant memory-consumption & capacity-planning docs, CPU inference benchmarks for ArcFace/YOLO-family models, BullMQ vs RabbitMQ/Kafka comparison at this volume.

---

## 3. Architecture bugs found in the registration feature itself, ranked by cost-of-delay — fixes applied in this v3

1. **Duplicate, ambiguous consent representation (highest cost — fixed below).** `Subject` carried `generalTerms/piiProcessing/biometricMatch` with no stated relationship to `backend-plan.md`'s `project_consent_matrix`, which carries the *same three flags* as the real per-project source of truth. Left ambiguous, this becomes a live data-integrity bug once media-intake/purge phases start gating on "is consent active." **Fixed:** schema comment now states explicitly these are intake-time UX defaults only, never read by gating logic — `project_consent_matrix` is the only authority once it exists (§4).
2. **Audit-hash logic not centralized (fixed below).** No stated owner for `prevHash` computation/chaining rule — if `subjects` hand-rolls it and `media`/`consent`/`purge` each hand-roll their own later, the chain doesn't actually unify. **Fixed:** extracted `lib/auditLog.js` as the one place hash computation + the immutability guard live, used from day one even though only `subjects` needs it now (§5).
3. **PK naming mismatch with `backend-plan.md` (fixed below).** This plan's `Subject.id` was meant to become `backend-plan.md`'s `data_subjects` table, whose PK is `master_user_id` (every other table FKs to that name, not `id`). **Fixed:** renamed to `masterUserId` (mapped to `master_user_id`) now, while zero real rows exist — free today, a breaking migration later.
4. **Observability deferred too far (fixed below).** No structured logging, and "health-check 200" was a bare liveness check, not proof Postgres/Qdrant are actually reachable. At this scale, with 24h/30d SLAs already baked into the wider architecture, correlation IDs and a real dependency health-check are cheap now, expensive to retrofit across 5 modules + a worker later. **Fixed:** `pino` structured logger + `/health/deep` added to Phase A (§7).
5. **Missing pagination + API versioning (fixed below).** `GET /api/subjects` had no pagination, no `/v1` prefix. Cheap now, a breaking-client-coordination problem once both frontends are wired to it. **Fixed:** `limit`/`cursor` params + `/api/v1` prefix added (§6).
6. **Worker/process separation left implicit (documented, not built).** `backend-plan.md` anticipates a purge worker; media intake will need job workers too (§2 row 3). Not urgent at 5000/day since ML work is already isolated in separate Docker containers per the client's own requirement — but the decision (in-process poller for now, explicitly revisit as a separate deployable when media/purge phases land) is now stated rather than silently assumed (§7).

**Confirmed NOT concerning** (reviewed, deliberately left as-is): single-`subjects`-module shape, no DI/base-service abstraction yet, dev-stub auth with boot-time prod guard, Supabase pooled/direct URL split — all correctly sized for this phase; adding more structure now would be premature abstraction.

---

## 4. Directory / file layout (v3: added `lib/auditLog.js`, `lib/logger.js`)

```
backend/
├── package.json
├── .env.example
├── docker-compose.yml            # Qdrant only, named volume, pinned version
├── prisma/
│   ├── schema.prisma
│   └── migrations/
├── storage/
│   └── media/
└── src/
    ├── server.js                  # Express entry, health checks, CORS, requireAuth boot guard
    ├── config/
    │   ├── prisma.js               # v3: explicit connection_limit, see §6
    │   └── qdrant.js
    ├── lib/
    │   ├── storage.js
    │   ├── auditLog.js             # v3: new — centralized hash-chain + immutability guard
    │   └── logger.js               # v3: new — pino structured logger
    ├── middleware/
    │   ├── errorHandler.js
    │   ├── requestLogger.js         # v3: now logs correlation IDs via logger.js
    │   └── requireAuth.js
    └── modules/
        └── subjects/
            ├── subject.routes.js
            ├── subject.controller.js
            ├── subject.service.js    # calls lib/auditLog.js, not its own hashing
            └── subject.validation.js
```

---

## 5. Schema (Prisma) — v3 changes: `id`→`masterUserId`, consent-authority comment, centralized audit lib referenced

```prisma
enum SubjectGroup {
  SAMSUNG_EMPLOYEE
  EX_SAMSUNG_EMPLOYEE
  SEED_LAB_EMPLOYEE
  EX_SEED_LAB_EMPLOYEE
  VOLUNTEER
}

enum SubjectStatus {
  PENDING
  ACTIVE
  INACTIVE
  REJECTED
}

enum RegistrationChannel {
  SELF
  AGENT
}

model Subject {
  masterUserId          String               @id @default(uuid()) @db.Uuid @map("master_user_id")
  // v3: renamed from `id` — matches backend-plan.md's data_subjects.master_user_id,
  // which every future table (project_consent_matrix, dsar_requests, etc.) FKs to by that name.

  group                 SubjectGroup
  status                SubjectStatus        @default(PENDING)

  fullName              String
  email                 String?              @unique @db.Citext
  phone                 String?
  employeeRef           String?              @unique

  registrationChannel   RegistrationChannel
  registeredByUserId    String?              @db.Uuid

  otpVerifiedAt         DateTime?

  // Intake-time UX defaults ONLY — v3: explicit, since research flagged this as an
  // ambiguous dual-source-of-truth risk. Once project_consent_matrix exists (backend-plan.md
  // Phase 2), THAT table is the sole authority for any gating/consent-check logic.
  // These three fields must never be read by media-intake, purge, or DSAR logic.
  generalTerms          Boolean              @default(false)
  piiProcessing         Boolean              @default(false)
  biometricMatch        Boolean              @default(false)

  createdAt             DateTime             @default(now())
  updatedAt             DateTime             @updatedAt

  @@index([group, status])
  @@index([employeeRef])
  @@map("data_subjects")
}

model AuditLog {
  id          String   @id @default(uuid()) @db.Uuid
  entityType  String
  entityId    String   @db.Uuid
  action      String
  actorId     String?  @db.Uuid
  payloadHash String
  prevHash    String?
  createdAt   DateTime @default(now())

  @@index([entityType, entityId, createdAt])
  @@map("audit_log")
}
```

`lib/auditLog.js` contract (v3, new): `writeAuditLog({ entityType, entityId, action, actorId, payload })` — looks up the last row for `entityId` to get `prevHash`, computes `HMAC-SHA256(prevHash + canonical(payload))`, inserts the row. Every module (subjects today, media/consent/purge/dsar later) calls this one function — never hand-rolls hashing.

---

## 6. `.env` / Prisma connection config (v3: added explicit connection_limit)

```
DATABASE_URL="postgresql://...:6543/postgres?pgbouncer=true&connection_limit=5"
DIRECT_URL="postgresql://...:5432/postgres"
QDRANT_URL="http://localhost:6333"
STORAGE_ROOT="./storage/media"
NODE_ENV="development"
```

`connection_limit=5` (v3, new): Prisma's default pool size is `(CPU cores × 2) + 1` per client instance — fine for one process, but multiplies fast if this ever runs as multiple instances/replicas and can exhaust Supavisor's pooler ceiling even though absolute query volume stays low. Setting it explicitly low now costs nothing at this scale and avoids a real failure mode later.

---

## 7. Auth stance, health checks, job-runner stance (v3: expanded)

- **Auth:** unchanged from v2 — fail-closed dev-stub middleware, boot-time assertion refuses to start in `production` without real auth wired.
- **Health checks (v3, new):** `/health` (liveness — process is up) stays, plus `/health/deep` (readiness — actually pings Postgres via Prisma and Qdrant via its `/collections` endpoint, returns 503 if either is unreachable). Cheap now, was flagged as a real operability gap for a system with 24h/30d SLA commitments already designed elsewhere.
- **Structured logging (v3, new):** `pino`, with a correlation ID (per-request UUID) attached in `requestLogger.js` — sets up the trace-ability future phases will need when a request crosses API → ML-container → Qdrant.
- **Job-runner stance (v3, new, decision only — not built):** in-process for this phase (there's no job to run yet). Explicitly revisit as a separate deployable process when the media-intake phase lands, which per the fan-out research will need an async queue (BullMQ, reusing the Redis instance `backend-plan.md` already commits to for the revocation hotlist) — not a synchronous REST endpoint, since CPU-bound per-photo inference (0.5–3s/image) can't absorb burst load synchronously. Node↔Python ML-container calls in that future phase should prefer gRPC over REST (binary payload for image bytes, typed contract) per the client's own stated container-exposure requirement. **None of this is implemented now** — stated here so it's a planned decision, not a rearchitecture surprise.

---

## 8. Dedupe strategy (unchanged from v2)

`employeeRef` primary for employee groups; normalized `Citext` email fallback for volunteers; `subject.service.js` checks before insert and returns `409` with existing id rather than relying solely on the DB constraint.

---

## 9. API — v3: added `/api/v1` prefix + pagination

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/subjects` | dev-stub | Register. Dedupe-checks first. Writes `AuditLog` via `lib/auditLog.js`. |
| `GET` | `/api/v1/subjects/:id` | dev-stub | Fetch one. |
| `GET` | `/api/v1/subjects?group=&status=&limit=&cursor=` | dev-stub | List/filter, paginated (v3: added `limit`/`cursor` — was unbounded in v2). |
| `PATCH` | `/api/v1/subjects/:id/consent` | dev-stub | Update 3 intake-default consent booleans (§5 comment applies). |
| `PATCH` | `/api/v1/subjects/:id/status` | dev-stub | Manual override only (e.g. flagging fraud/dedupe issues → `INACTIVE`/`REJECTED`) — **not** the primary activation path, since `verify-otp` now handles `PENDING→ACTIVE` directly. |
| `PATCH` | `/api/v1/subjects/:id/group` | dev-stub | Edit group (e.g. active→ex-employee transition). |
| `POST` | `/api/v1/subjects/:id/verify-otp` | dev-stub | Stubbed OTP accept, sets `otpVerifiedAt` **and transitions `status: PENDING → ACTIVE` directly** (confirmed §1.3 — no separate DPO-approval step). Writes `AuditLog` (`STATUS_CHANGE`). |

CORS configured in `server.js`, Phase A.

---

## 10. Phase breakdown (v3: Phase A absorbs logging/health/connection-limit; effort re-sized)

### Phase A — Infra scaffold
- Express skeleton + CORS + `requireAuth` stub + boot-time prod-safety assertion + **pino logger + `/health/deep`** (v3).
- Supabase project → pooled + direct connection strings, **`connection_limit=5`** on pooled URL (v3).
- `prisma init`, datasource with `url`+`directUrl`, first migration.
- `docker-compose.yml`: Qdrant, named volume, pinned version tag.
- `storage/media/` + `lib/storage.js` stub.
- **DoD:** `docker compose up`, `npx prisma migrate dev` succeeds, `/health` returns 200, `/health/deep` correctly reports Postgres+Qdrant reachable (and correctly returns 503 if one is stopped — test this negative case).
- **Effort:** medium.

### Phase B — Subject + AuditLog schema
- `Subject` (with `masterUserId` PK, v3), `AuditLog` models, `citext` extension, `lib/auditLog.js` (v3).
- Seed script across all 5 groups + audit rows.
- **DoD:** tables visible with correct constraints/indexes; seed populates both; a manual duplicate-`employeeRef` insert attempt is rejected with `409`, not a raw DB error.
- **Effort:** small.

### Phase C — Registration API
- All 7 `/api/v1/...` endpoints, validation, dedupe-check + `lib/auditLog.js` write wired into the service layer.
- **DoD:** full CRUD works against Supabase via curl/Postman; pagination works past the first page; correlation IDs appear in logs end-to-end for one request.
- **Effort:** medium.

### Phase D — Frontend wiring (D1 user-portal / D2 admin-portal, unchanged split from v2)
- **DoD (each independently):** real form submission creates a real `Subject` row.
- **Effort:** medium each.

---

## 11. Risks (v3: updated with scale-review findings)

1. Auth is dev-stub only — fail-closed boot check mitigates prod exposure; real auth is a separate future phase.
2. Volunteer dedupe relies on manual DPO review when no `employeeRef`/email exists — acceptable now, revisit if volume grows.
3. `registeredByUserId` has no real FK yet — becomes enforced once the auth/users phase exists.
4. OTP is stubbed — matches `backend-plan.md`'s own already-flagged open question.
5. **(v3, new)** Qdrant single-node has no replication/backup automation — fine at day-1 scale, but the future media phase must establish a snapshot schedule before real subject data accumulates in it, and use `wait=true` on purge-triggered deletes (Qdrant's default is eventually-consistent, which is unacceptable for a compliance-triggered deletion).
6. **(v3, new)** Qdrant re-architecture tripwire: revisit sizing/quantization at ~5–10M vectors (~2.7–5.5 years at current rate) — not urgent, but should be a tracked date/threshold, not a surprise.
7. **(v3, new)** Media-intake phase (not yet designed) must be async (BullMQ + gRPC-to-ML-containers) from its first draft — the current plan's synchronous-REST pattern, correct for lightweight registration CRUD, would not survive bursty CPU-bound photo processing at this volume.

---

*(All §1 open questions confirmed. Plan is ready for implementation — Phase A can start.)*
