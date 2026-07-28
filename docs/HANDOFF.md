# PRISM — handoff

**As of 2026-07-28.** Waves 0–6 shipped. `main` is at `7ee4f36` and pushed. The
gate is green (53/53), media is encrypted at rest, and the database has been
cleaned of test residue.

**Three things remain.** They are listed in §2 in the order they should be done.
None of them is a feature. Do them, verify, stop.

> The previous handoff said the API listens on **3000**. It does not — `.env` sets
> `PORT=4000`. Anything in older notes citing 3000 is wrong.

> A hook truncates the Read tool on `docs/*.md` intermittently. If a doc reads as
> one line, `cat` it via Bash instead.

---

## 0. Current state — what is already true

Do not re-verify these. They were run and observed this session.

| | |
|---|---|
| `main` | `7ee4f36`, pushed to `origin` |
| Gate | `53/53`, exit 0, under sealed media |
| Portals | both build clean |
| `/health/deep` | `{"postgres":true,"qdrant":true,"redis":true}` on **:4000** |
| Preflight (dev) | 16 checks — 14 pass, 1 warn (`db-role`), 1 fail (Redis version) |
| Database | 3 subjects (the owner's own `niga` accounts) + their 20 enrollments, 1 admin. Zero projects, sessions, photos, links |
| Media | `MEDIA_KEK` set, 356 blobs swept and sealed, `MEDIA_REQUIRE_SEALED=on` |

### Ports

| Service | Port | Start |
|---|---|---|
| Backend API | **4000** | `cd backend && npm start` |
| admin-portal | 5180 | `cd admin-portal && npm run dev` |
| user-portal | 5173 | `cd user-portal && npm run dev` |
| Postgres | — | Supabase `wblmtdrcohhjfyqvvobl`, remote |
| Redis | 6379 | see §2.2 |
| Qdrant | 6333 | `C:\Users\gaur3\Desktop\qdrant-portable\qdrant.exe` |
| face-worker | 8001 | `face-worker/.venv/Scripts/python.exe -m uvicorn main:app --port 8001` |
| image-pii-worker | 8002 | `ai-core/image-pii-worker/.venv/Scripts/python.exe -m uvicorn main:app --port 8002` |

Workers: `worker:start` (recognition), `worker:redaction`, `worker:purge`,
`worker:retention`. There is no `worker:recognition` script.

### Admin access

All admin accounts were deleted and rebuilt this session, because
`/auth/admin/invite` is `super_admin`-only and no `super_admin` existed. There is
now exactly one admin — `chaitanyakhanna14@gmail.com`, `super_admin`, status
`INVITED` until the single-use accept link is used. **Every other role has to be
invited from the portal by that account.** If the link was lost, delete the admin
row and re-run `npm run bootstrap-admin -- <email>`.

---

## 1. What changed since the last handoff

### The database was cleaned (§7.1 of the old handoff — done)

Deleted: 8 projects and all their sessions/photos/links/consents, 22 subjects
(12 `@test.invalid` fixtures, 3 `ERASED`, 9 seed-derived demo people), 41
`@test.invalid` admins, 1 `probe-` admin, 7 `E2E Notice *` consent templates, all
OTP/auth/refresh tokens. Kept the owner's 3 `niga` subjects and their 20
enrollments. Two orphaned Qdrant collections dropped.

`audit_log` (731) and `access_events` (142) were **not** touched — they are
append-only. Backup of every table before the delete:
`scratchpad/backup-pre-cleanup.json`.

### Media encryption was turned on (§7.3 of the old handoff — done)

`AUDIT_HMAC_SECRET`, `DSAR_SIGNING_SEED` and `MEDIA_KEK` are set in
`backend/.env`; `migrate-media-encrypt.js` swept 356 blobs;
`MEDIA_REQUIRE_SEALED=on`.

**Never discard that KEK.** The corpus is unreadable without it.

Rotating `AUDIT_HMAC_SECRET` made the 731 pre-existing audit rows unverifiable.
They were chained under the development default — forgeable by definition — and
describe objects that have since been deleted. This was accepted, not overlooked.
Do not try to "repair" the old chain; the table is append-only and the rows are
correct as history.

### Turning the KEK on exposed two bugs no test could reach

Both fixed and committed separately.

1. **`buildAccessPackage` could not write a sealed DSAR package.** It called
   `writeFile` with `{scope:'export'}` and no wrapped key, so `keyFor` reached
   `openExportKey(undefined)` and threw. With encryption off the branch was dead
   code, which is why the suite was green without it. An export key is *minted*
   per job rather than derived, so there is nothing to open on a write: `keyFor`
   now mints when no wrapped key is supplied, `storage.writeFile` returns the
   wrapped DEK, `buildAccessPackage` persists it on the evidence row, and the
   download path hands it back. `expirePackages` drops the wrapped key alongside
   the shredded bytes — shredding alone leaves a key for an object, and dropping
   the key alone leaves an object for a key. The evidence `payload` is already
   never returned by the DSAR endpoints, so the wrapped key inherits that.

2. **The retention worker died on its first sweep.** `sweepOriginals` and its
   blocked-count companion filtered the session relation with a bare object
   (Prisma wants `is:` for a to-one) and then on `updatedAt`, which `Session` does
   not have — its clock fields are `createdAt`, `endedAt`, `archivedAt`. Both
   queries threw `PrismaClientValidationError`, so originals past their TTL were
   never shredded and nothing reported that they weren't. Now `archivedAt`, which
   is the correct clock: retention on an original starts at archival.

   **No test covers this.** The suite drives purge inline and never boots the
   retention worker, which is why a query that broken stayed green. It was
   verified by running the worker and watching a sweep complete.

### `make-e2e-fixtures.js` learned to unseal

It reads `storage/media` with a bare `fs` read rather than through `storage.js`,
so once the corpus was sealed it fed the face service ciphertext and found no
faces at all. It now unseals with the same path-scoped key `storage.js` would
have used. Relevant on every clean checkout, since the fixtures are gitignored.

### image-pii-worker is now containerised

`ai-core/image-pii-worker/Dockerfile` added and wired into
`backend/docker-compose.yml`. **It has not been built** — Docker is not installed
on this machine. See §2.3.

---

## 2. What is left — do these in order

### 2.1 Provision the least-privilege database role — **the real remaining gap**

RLS is enabled *and forced* on `audit_log`, `access_events` and
`deletion_certificates`, so those tables are append-only — but only against roles
RLS applies to. Supabase's `postgres` role holds `BYPASSRLS`, which ignores RLS
unconditionally, `FORCE` included. Connecting the application as `postgres` means
the policies are all present, all correct, and all skipped.

This is not theoretical. `tests/e2e/world.js:286` calls
`prisma.deletionCertificate.deleteMany(...)` against a forced append-only table
**and it succeeds**. Until this is fixed, "the compliance ledger cannot be edited"
is not a true statement about this system.

The remedy is written and committed but has never been run:
`backend/scripts/sql/provision-app-role.sql`. It creates `prism_app` with
`NOSUPERUSER NOBYPASSRLS`, grants ordinary DML, and revokes
`UPDATE/DELETE/TRUNCATE` on the three evidentiary tables so the guarantee does not
rest on RLS alone.

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
psql "$ADMIN_DATABASE_URL" -v password="'<generated>'" -f backend/scripts/sql/provision-app-role.sql
```

Then repoint **both** `DATABASE_URL` and `DIRECT_URL` at `prism_app` and confirm:

```sql
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;  -- (f, f)
```

`npm run preflight` must then report `db-role: PASS`.

**Three things to expect, none of which is a regression:**

- `world.js` teardown will start failing on `deletionCertificate.deleteMany`.
  **That is the control working.** Fix it by narrowing the teardown so it stops
  deleting evidence — *never* by re-granting the privilege.
- `prisma migrate deploy` may need the admin role, not `prism_app`. Keep the
  admin URL available for migrations.
- If `psql` is not installed, `mcp__supabase__execute_sql` can run the file's
  statements, but it does not support `psql`'s `\set` / `:'password'`
  interpolation — substitute the password literal by hand and do not commit it.

Re-run the full gate afterwards. This is the one change here that can plausibly
break a passing suite.

### 2.2 Redis ≥ 6.2 for the team

The local binary is 5.0.14.1, below BullMQ's 6.2 floor. It is a warning, not a
crash — all four workers do run — but deferred retries are not trustworthy on it.

`backend/docker-compose.yml` already pins `redis:7.4-alpine`, and `.env` already
points at `redis://localhost:6379`, so for anyone with Docker this is a drop-in:

```bash
cd backend && docker compose up -d redis qdrant
```

For Windows machines without Docker: Memurai Developer Edition — free, native
Windows service, Redis 7.x wire-compatible, listens on 6379
(`winget install Memurai.MemuraiDeveloper`).

Do **not** put the team on one shared cloud Redis. BullMQ queue state is global,
so two developers on one instance steal each other's jobs.

### 2.3 Build and verify the image-pii-worker container

The Dockerfile is written but **unbuilt and unverified** — Docker was not
available. It needs one run to confirm:

```bash
cd backend && docker compose build image-pii-worker && docker compose up -d image-pii-worker
curl -s -m 5 localhost:8002/health          # {"status":"ok"}
```

Then put a real photo through `/detect-pii` — a healthy `/health` only proves the
process booted, not that OCR and Presidio initialised.

Two judgement calls in that Dockerfile worth knowing:

- `python -m spacy download en_core_web_sm` is baked at **build** time. Presidio's
  `AnalyzerEngine` needs an NLP engine for tokenization even though none of the
  Indian recognizers are NER-based, so a missing model is a hard failure on the
  first request rather than at boot.
- There is deliberately **no** model volume, unlike face-worker.
  `rapidocr-onnxruntime` ships its detection/recognition/classification ONNX
  weights inside the wheel — verified by inspecting the installed package. The
  worker's own README claims they download on first use; that is out of date, and
  worth correcting there while you are in the file.

This worker is not optional. Redaction fails closed without it
(`PiiUnavailableError` → `piiStatus=DEFERRED`), so a stack missing it silently
stops publishing redacted frames rather than publishing unmasked ones.

---

## 3. The manual pass — not yet run

The automated gate cannot cover these, because they are about what a person
actually sees. Requires inviting `dpo`, `dataOwner` and `dataAdmin` from the
`super_admin` account first, and running one capture session so there is data.

- A principal logs into user-portal, opens **My Data**, sees a photo count and
  thumbnails — and **no other person's face unblurred**.
- Raise a DSAR from the portal and download the package **once**; the second
  attempt returns 410; re-issue mints a *different* token. **Exercise this
  deliberately** — the export path was rewritten this session and has only
  automated coverage behind it.
- A `dataOwner` opens a project they do not own → 403 on all three oversight
  reads.
- A DPO opens Compliance Reports and sees both the report **and** the raw audit
  entry list. (`/audit-logs` is dataAdmin-only in `admin-portal/src/roles.js`, so
  that list is the DPO's only view of individual ledger rows — do not "simplify"
  it away.)
- A `dataAdmin` break-glass read writes an `AccessEvent` **before** the bytes are
  returned — verify the row exists.

---

## 4. How to work — token discipline

The user has asked explicitly for token-efficient execution.

**Search order, cheapest first:** claude-mem (`mem-search`) → GitNexus MCP
(`gitnexus_query`, `gitnexus_context`, always with `repo: "samsung project"`) →
Grep with `files_with_matches` or a tight `head_limit` → Read a line range →
full-file read as a last resort.

**The techniques that saved the most:**

- **Never re-read a file you just edited.** Edit fails loudly if the match missed.
- **Batch independent tool calls into one message.**
- **Pipe long output through `tail`/`head`** — and beware: a Prisma validation
  error dumps the entire minified client bundle before the useful message.
  `2>&1 | tail -20` on anything touching Prisma.
- For long test runs, **write TAP to a file and grep the file**; a buffering pipe
  can hide a hang.
- **Query the DB with one `node -e` printing a single JSON line.** Ask for
  `count()`, not `findMany()`.
- `git diff --stat` before `git diff`.

**Subagents:** never hand over anything touching consent, erasure, access
logging, RBAC or crypto, nor the test gate, the merge, or §2.1. Use them only for
bounded mechanical work verifiable by a build or a test. Verify their output — a
previous agent deleted a DPO-only audit list on a wrong theory, and two of its
doc claims were false.

---

## 5. Ask before doing

Standing instruction from the user:

- dropping any existing table
- changing the `photo_subjects` shape
- altering `finalizeSession`'s transaction boundary
- deleting database rows — confirm the exact `WHERE` clauses first

---

## 6. Architecture notes worth not re-deriving

- **`listRoutes(app)`** walks the live Express router stack, so a newly mounted
  route appears in the RBAC test immediately — forgetting to classify an endpoint
  is a *test failure*, not a silent hole. Keep it that way. 114 routes at present.
- **`tests/e2e/world.js`** builds everything through the real services. A fixture
  that inserts straight into a table also skips the rule that table's service
  enforces.
- **The rate limiter answers before the guard** on `/auth/subject/login|verify`.
  The RBAC harness records those as *inconclusive* rather than scoring them —
  scoring a 429 as "denied" lets a genuinely open route hide behind the limiter.
- **`PHASE_ORDER` in `purge.service.js` is load-bearing.** `LINK` → `L6` → `L2`,
  `SUBJECT_KEY` last. Reversing `L6`/`L2` yields a photo that can never be
  re-redacted; destroying the key first makes everything after it unhashable.
- **`phaseOf()` derives from persisted columns only.** Discovery's
  rebuild-vs-delete hint is deliberately not trusted at execution time.
- **`Subject`'s primary key is `masterUserId`, not `id`.** `select: {id:true}` on
  `Subject` throws.
- **Mount order in `app.js` is deliberate** and commented. `agentEnrollmentRoutes`,
  `meRoutes`, `joinRoutes`, `sessionInviteRoutes` and `sessionBreakGlassRoutes`
  sit *before* the routers whose broad guards or bare `/:id` params would
  otherwise swallow them.
- **`readPersonRedactedPhotoForSubject`** takes no `admin` and performs no
  session-ownership check — the authorization *is* the `PhotoSubject` link,
  re-proved inside the function rather than trusted from the caller.
- **`getComplianceReport` returns `onTimeRate: null` on an empty set**, never 0%
  or 100%. A report claiming "100% on time" because nothing closed is worse than
  one that says nothing.
- **`backend/prisma/seed-admin.js` is not a seeder.** It is the bootstrap escape
  hatch: refuses to run once any admin row exists, only ever creates
  `super_admin`, sets no password. Do not delete it as "mock data".

---

## 7. The ten invariants

| # | Invariant | Proven by |
|---|---|---|
| 1 | No mock/seed/dummy data anywhere | `preflight` `no-mock-data` — **scans code only**; the DB was cleaned by hand this session |
| 2 | `project_consent_matrix` is the sole consent authority | lifecycle test 3 |
| 3 | Embeddings never leave the process | lifecycle test 7; rbac test 3 |
| 4 | `Photo.storagePath` never overwritten | lifecycle test 5 |
| 5 | Erasure is per `PhotoSubject` link, never per photo | erasure tests 6, 7 |
| 6 | AccessEvent written *before* decryption; log failure fails the read | lifecycle test 8 |
| 7 | AuditLog stores hashes only | lifecycle test 10; erasure test 10 |
| 8 | Redaction/PII failure fails closed | lifecycle test 6 |
| 9 | Secrets from env; preflight refuses prod defaults | run it |
| 10 | Least privilege in `requireRole` + service-layer scope | rbac test 4 |

---

## 8. Where things live

Prefer `gitnexus_context({name, repo:"samsung project"})` over opening these.
Index is fresh (1,844 nodes / 5,352 edges / 145 flows, re-run at `7ee4f36`).

### `backend/src/`

```
app.js       createApp() + listRoutes()   ← mount order is load-bearing (§6)
server.js    listen only; the split exists so the RBAC test mounts the real app
config/      prisma.js · qdrant.js · redis.js
modules/     audit auth-admin auth-subject consent consentTemplates dashboard
             dsar enrollment handoff join me projects sessions subjects
workers/     recognition · redaction · purge · retention
```

`src/lib/` — the pieces most work touches:

| File | Holds |
|---|---|
| `storage.js` | envelope encryption for L2/L4/L6/L7/L8; mints export DEKs; throws at boot if encryption is off under `NODE_ENV=production` |
| `blobCrypto.js` · `embeddingCrypto.js` · `keyring.js` | DEK/KEK, embedding column crypto, crypto-shredding |
| `auditLog.js` · `accessLog.js` | HMAC chain (hashes only); `recordAccess` **throws** so a failed log fails the read |
| `signingKey.js` | Ed25519 for deletion certificates, seeded by `DSAR_SIGNING_SEED` |
| `consent.js` · `revocation.js` | consent matrix reads; withdrawal |
| `faceGallery.js` | Qdrant, one collection per session, destroyed at finalize |
| `faceQueue.js` · `redactionQueue.js` · `purgeQueue.js` | **lazy** — must not open Redis at import |
| `zip.js` · `tokens.js` · `otp.js` · `cookies.js` · `resend.js` · `cleanup.js` · `logger.js` | packaging, opaque tokens, OTP, auth cookies, mail, retention sweep, pino |

`src/middleware/` — `requireAdminAuth` · `requireSubjectAuth` ·
`requireAnyPrincipal` · `requireRole` · `requireBreakGlass` · `logAccess` ·
`rateLimiter` · `requestLogger` · `errorHandler`.

### `backend/scripts/`

| Script | Purpose |
|---|---|
| `preflight.js` | the 16 checks; fatal only under `NODE_ENV=production` |
| `sql/provision-app-role.sql` | §2.1 — **not yet run** |
| `migrate-media-encrypt.js` | the sealing sweep; idempotent, resumable |
| `make-e2e-fixtures.js` | rebuilds the gitignored `*.jpg` fixtures; unseals as it reads |

### Migrations

```
20260725000001_governance_dsar        20260725000003_audit_payload_digest
20260725000002_rls_audit_access       20260725000004_subject_erased_status
```

`…_rls_audit_access` enables and forces RLS on the three evidentiary tables — the
guarantee §2.1 is about.

### Portals

`admin-portal/src/` — `roles.js` (nav authority), `lib/api.js`,
`pages/{dpo,dataOwner,dataAdmin,collectionAgent}/`.
`user-portal/src/` — `lib/api.js`, `pages/{MyData,SecureInbox,Join}.jsx`.

### Docs

`DEPLOY.md` go-live · `DPIA.md` risk register · `RUNBOOK_BREACH.md` ·
`01_PRIVACY_DATAFLOW.md` · `02_ROLE_PERMISSION_MATRIX.md` (executable — the RBAC
test *is* this table) · `03_FILE_IMPLEMENTATION_PLAN.md` ·
`04_AGENT_EXECUTION_PLAN.md`.

---

## 9. If something breaks

1. `mem-search` first — the answer is probably already recorded.
2. Suite hangs or mass-fails → **check the ports before reading any code.** That
   was the cause of every stall in the previous two sessions.
   ```bash
   ~/redis/redis-cli.exe ping                  # PONG (local redis-cli has no -t flag)
   curl -s -m 2 localhost:6333/healthz localhost:8001/health localhost:8002/health
   curl -s -m 5 localhost:4000/health/deep
   ```
3. A worker that exits at startup is usually a stale BullMQ job pointing at a row
   the DB no longer has. `redis-cli flushall` on the dev instance clears queue
   state only and is safe.
4. `gitnexus_query({query:"<symptom>", repo:"samsung project"})` →
   `gitnexus_context({name:"<suspect fn>", repo:"samsung project"})`.
5. Run `gitnexus_impact({target:"X", direction:"upstream", repo:"samsung project"})`
   **before** editing any symbol; warn on HIGH/CRITICAL. Re-run
   `npx gitnexus analyze` after committing — **without** `--embeddings`
   (`.gitnexus/meta.json` shows `embeddings: 0`; omitting the flag when embeddings
   *do* exist deletes them).

---

## 10. Sign-off

```
[ ] 2.1  provision-app-role.sql run; DATABASE_URL + DIRECT_URL → prism_app
[ ]      SELECT rolsuper, rolbypassrls → (f, f)
[ ]      preflight db-role → PASS
[ ]      world.js teardown narrowed, no longer deletes deletion_certificates
[ ]      npm test → 53/53 after the role switch
[ ] 2.2  Redis ≥6.2 on every developer machine
[ ] 2.3  image-pii-worker image built; /health ok; a real photo through /detect-pii
[ ] 3    manual pass, all five checks
```

**Rollback.** The delivery is four commits on `main`: `165f9d1` (waves 0–6),
`927677f` (export DEK), `04f56b6` (retention sweep), plus index-header chores.
`git revert` undoes the code cleanly. Two things do **not** revert with it and must
be planned separately: the `MEDIA_KEK` sweep (re-encrypted objects need the KEK —
never discard a KEK that has encrypted anything) and the row deletions (backup at
`scratchpad/backup-pre-cleanup.json`).

### Definition of done

§10 ticked, §3 green, and §2.1 either resolved or explicitly signed off by the
user as accepted risk. `NODE_ENV=production npm run preflight` exiting 0 is the
single best proxy — it is the only check that fails the build rather than warning.
