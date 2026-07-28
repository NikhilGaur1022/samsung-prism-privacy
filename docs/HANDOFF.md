# PRISM — handoff

**As of 2026-07-28.** Waves 0–6 shipped. `main` is at `7ee4f36` and pushed. The
gate is green (53/53), media is encrypted at rest, and the database has been
cleaned of test residue.

**One thing remains** — §2.3, blocked on this machine only: Docker Desktop is
installed but its engine cannot start until WSL2 is enabled, which needs an
elevated shell and a reboot. §2.1 and §2.2 are done.
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
| Preflight (dev) | 17 checks — 17 pass, 0 fail. GREEN |
| Database | 3 subjects (the owner's own `niga` accounts) + their 20 enrollments, 1 admin. Zero projects, sessions, photos, links |
| Media | `MEDIA_KEK` set, 356 blobs swept and sealed, `MEDIA_REQUIRE_SEALED=on` |

### Ports

| Service | Port | Start |
|---|---|---|
| Backend API | **4000** | `cd backend && npm start` |
| admin-portal | 5180 | `cd admin-portal && npm run dev` |
| user-portal | 5173 | `cd user-portal && npm run dev` |
| Postgres | — | Supabase `wblmtdrcohhjfyqvvobl`, remote |
| Redis | 6379 | Memurai `Memurai` Windows service, auto-start |
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

### The role switch exposed the whole database to the anon key

The finding §2.1 was written about was real but not the worst one. Taking away
`BYPASSRLS` made two things visible that had been masked for the life of the
project.

**`anon` and `authenticated` held full DML on all 30 tables in `public`, and
only 6 of the 30 have RLS enabled at all.** Supabase publishes everything in
`public` through PostgREST, and the `anon` key that reaches it is public by
construction — it ships inside the portal bundles. Photos, sessions, projects,
`photo_subjects` and `subject_keys` were readable *and writable* with a key that
is not a secret, entirely around the API, its RBAC and its access logging.

Nothing in this system uses PostgREST — there is no `@supabase/supabase-js`
client in either portal, every read goes through Prisma — so the grants were
revoked outright, along with the default privileges that would otherwise
re-grant them on every table a future migration adds. `preflight` now fails on
`postgrest-exposure` if either role regains a single table privilege.
`service_role` is left alone: that key is secret, unlike `anon`.

**`data_subjects`, `session_handoffs` and `subject_face_enrollments` had RLS
enabled with zero policies.** RLS on with no policy denies everything, so every
insert into `data_subjects` failed with `42501` the moment the app stopped
bypassing RLS — 37 of 53 tests. They are ordinary application tables whose
authorization lives in `requireRole` and the service layer, so they were given a
permissive policy rather than having RLS switched off. If a `GRANT ... TO anon`
ever reappears — one dashboard click — the policy still stands between it and
the rows.

Both are `20260728000001_lock_down_public_grants`.

### `provision-app-role.sql` could not have run as written

It set `NOSUPERUSER NOBYPASSRLS` explicitly. Postgres requires SUPERUSER to set
either attribute *in either direction*, and Supabase's `postgres` is not a
superuser — it holds `BYPASSRLS` and `CREATEROLE` but not `rolsuper`. The
statement failed with `42501` even though it was a no-op. Both attributes
default to off on a new role, so the file now asserts them and raises if they
are ever on, which is the stronger form anyway: it also catches a `prism_app`
that already exists and was granted something it should not have.

### The handoff batch over-reported its own link count

`finalizeSession` built its link list per cluster and deduplicated only within
one. Clustering routinely splits one person across several clusters and tagging
can point all of them at the same subject, so the same `(photo, subject)` pair
was pushed more than once. `createMany(skipDuplicates)` collapsed them to one
row while `SessionHandoff.linkCount` recorded `links.length` — the *candidate*
count. The emitted batch claimed 6 links where the table held 3, and `linkCount`
is what the downstream consumer reconciles against.

This is why the assertion failed intermittently rather than always: it depended
on whether clustering happened to split someone on that run. Worth knowing when
reading a flaky failure in this suite — the flakiness was in the data, not the
test.

## 2. What is left — do these in order

### 2.1 The least-privilege database role — **done**

Run and verified this session. The application now connects as `prism_app`:
`rolsuper` and `rolbypassrls` both false, no `UPDATE/DELETE/TRUNCATE` on
`audit_log`, `access_events` or `deletion_certificates`. `npm run preflight`
reports `db-role: ok`; `node backend/scripts/verify-app-role.js` attempts each
forbidden write and requires `42501` specifically. Gate is **53/53** on the new
role.

Two things had to change in the remedy itself, and doing it uncovered a larger
hole than the one it was written for. Both are described in §1.

If you have to provision another environment:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
cd backend && node scripts/run-sql.js scripts/sql/provision-app-role.sql -v "password='<generated>'"
```

`run-sql.js` exists because `psql` is not installed on these machines and the
Supabase MCP server needs an access token that was not present. Point
`DATABASE_URL` **and** `DIRECT_URL` at `prism_app`, keep `ADMIN_DATABASE_URL`
pointing at the owner — `prisma migrate deploy` and `scripts/sql/*` need it and
`prism_app` is deliberately not allowed to run them.

### 2.2 Redis ≥ 6.2 for the team — **done on this machine**

Was 5.0.14.1, below BullMQ's 6.2 floor. Now **7.2.5** via Memurai Developer
Edition, running as the `Memurai` Windows service on 6379 with `StartType
Automatic`. Preflight's `redis` check passes, taking the suite to 17/17 GREEN.

The old `C:\Users\gaur3\redis\redis-server.exe` (5.0.14.1) is still on disk and is
what has to stay stopped — it binds the same port, and whichever process wins 6379
is the one BullMQ gets. Memurai's installer refuses to complete while it holds the
port, which is what produced exit code 1603 on the first attempt.

For the rest of the team, either route reaches the same floor:

```bash
winget install Memurai.MemuraiDeveloper           # native Windows service
cd backend && docker compose up -d redis qdrant   # redis:7.4-alpine, already pinned
```

Run the winget install from a real elevated terminal, not through a sandboxed
shell — the MSI custom action needs to create a temp directory and fails with
`SFXCA: Failed to create temp directory. Error code 5` if it cannot.

Do **not** put the team on one shared cloud Redis. BullMQ queue state is global,
so two developers on one instance steal each other's jobs.

### 2.3 Build and verify the image-pii-worker container

The Dockerfile is written but **unbuilt and unverified**. Docker Desktop 4.84.0 is
now installed (`%LOCALAPPDATA%\Programs\DockerDesktop`, a per-user install — it is
not under `C:\Program Files`, and its `docker.exe` lives in
`resources\bin`), but the engine will not start: this is Windows 11 **Home**, which
has no Hyper-V backend, and WSL is not installed, so `docker info` reports
`Docker Desktop is unable to start`. CPU virtualization is already on
(`HypervisorPresent: True`), so WSL2 is the only missing piece. From an elevated
terminal, then reboot:

```powershell
wsl --install --no-distribution
```

After the reboot, launch Docker Desktop once and the build below should run:

```bash
cd backend && docker compose build image-pii-worker && docker compose up -d image-pii-worker
curl -s -m 5 localhost:8002/health          # {"status":"ok"}
```

Then put a real photo through `/detect-pii` — a healthy `/health` only proves the
process booted, not that OCR and Presidio initialised.

**The application half of this is already verified**, natively rather than in the
container. Running the worker from its venv on 8002, a generated Indian-ID card
(all identifiers fabricated) through `/detect-pii` returned 6 regions and 6
entities, one per planted identifier:

| Planted | Detected as |
|---|---|
| `4321 8765 2109` | `IN_AADHAAR` |
| `ABCDE1234F` | `IN_PAN` |
| `+91 98765 43210` | `PHONE_NUMBER` |
| `MH12AB1234` | `IN_VEHICLE_REGISTRATION` |
| `HDFC0001234` | `IFSC_CODE` |
| `ravi.sharma@okhdfcbank` | `UPI_ID` |

So RapidOCR loads its bundled weights, Presidio's `AnalyzerEngine` initialises,
and every custom Indian recognizer fires. What the container build still has to
prove is the *packaging*: that `libgl1`/`libglib2.0-0` satisfy opencv inside
`python:3.11-slim`, and that the baked `en_core_web_sm` is found at run time.
Those are the only two things the native run cannot tell you.

**Gap found while verifying.** `ravi.sharma@example.com` on the same card was
**not** detected. `PII_ENTITIES` in `pii_recognizers.py` is an allow-list, and
`EMAIL_ADDRESS` is not on it, so Presidio's built-in email recognizer never runs
even though it is loaded. An email address printed on a photographed document is
personal data, and it currently survives redaction unblurred. One line fixes it;
it was left alone because widening what gets blurred is a behaviour change, not
part of §2.3. Decide and then either add it or write down why not.

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
| `preflight.js` | the 17 checks; fatal only under `NODE_ENV=production` |
| `sql/provision-app-role.sql` | §2.1 — run; re-runnable per environment |
| `run-sql.js` | applies a `.sql` file without `psql`; understands `-v name=value` and `:'name'` |
| `verify-app-role.js` | proves the connected role cannot edit the evidentiary tables |
| `migrate-media-encrypt.js` | the sealing sweep; idempotent, resumable |
| `make-e2e-fixtures.js` | rebuilds the gitignored `*.jpg` fixtures; unseals as it reads |

### Migrations

```
20260725000001_governance_dsar        20260725000003_audit_payload_digest
20260725000002_rls_audit_access       20260725000004_subject_erased_status
```

`…_rls_audit_access` enables and forces RLS on the three evidentiary tables — the
guarantee §2.1 is about. `20260728000001_lock_down_public_grants` revokes
PostgREST access and gives the three policy-less RLS tables a policy.

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
[x] 2.1  provision-app-role.sql run; DATABASE_URL + DIRECT_URL → prism_app
[x]      SELECT rolsuper, rolbypassrls → (f, f)
[x]      preflight db-role → ok
[x]      world.js teardown narrowed, no longer deletes deletion_certificates
[x]      npm test → 53/53 after the role switch
[x]      anon/authenticated revoked; preflight postgrest-exposure → ok
[x] 2.2  Redis 7.2.5 via Memurai service on 6379; old redis 5 stopped
[x]      preflight redis → ok; 17/17 GREEN
[ ] 2.3  image-pii-worker image built; /health ok; a real photo through /detect-pii
[ ]      ← blocked: needs `wsl --install` + reboot before the engine starts
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
