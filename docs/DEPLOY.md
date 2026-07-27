# PRISM — Production Deploy Checklist

This is the go-live runbook: what to set, in what order, and how to prove it
worked. It assumes the state described in `docs/HANDOFF.md` — read that first
if you haven't. Every command below was checked against the actual source
(`backend/.env.example`, `backend/scripts/preflight.js`,
`backend/scripts/sql/provision-app-role.sql`, `backend/src/lib/storage.js`,
`backend/package.json`, `backend/docker-compose.yml`) as of this session, not
copied from memory.

> A hook truncates the Read tool to line 1 on `docs/*.md`. Read this file with
> `cat` via Bash, same as the other docs.

---

## 1. Required environment variables

Full list in `backend/.env.example`. The ones below are load-bearing — the
process either refuses to boot, boots into a silently unsafe state, or a
specific compliance guarantee goes inert without them.

### Security-critical (generate fresh secrets — never reuse dev values)

| Variable | What breaks without it | Generate |
|---|---|---|
| `AUDIT_HMAC_SECRET` | The audit hash-chain (`backend/src/lib/auditLog.js`) signs every mutation with this key. Unset, it falls back to `DEFAULT_AUDIT_SECRET` (`'dev-only-secret-change-in-prod'`) — a published, guessable value, so the chain is forgeable and tamper-evidence is theater. `preflight` FAILs if unset, default, or under 32 chars. | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `MEDIA_KEK` | The master key-encryption key for photo/enrollment blobs (L2/L4/L6/L7/L8). Unset: `backend/src/lib/storage.js` computes `ENCRYPTION_ENABLED = false` at import time and **refuses to boot at all when `NODE_ENV=production`** (`storage.js:29-33` throws). In any other `NODE_ENV`, it boots and writes plaintext. Must decode to exactly 32 bytes (hex or base64) — `preflight` checks this. | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `DSAR_SIGNING_SEED` | Ed25519 seed for deletion certificates (`backend/src/modules/dsar/certificate.service.js`). Without it, and without `MEDIA_KEK` to derive a fallback from, `getSigningKey()` has no key material — no erasure can ever be certified, which is the one document DPDP §11–13 puts in front of a principal or the DPB. `preflight` FAILs if both are absent, WARNs if only `MEDIA_KEK` is present (rotating the KEK would then invalidate old certificate verification). | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `JWT_ADMIN_SECRET` | Signs admin-portal session tokens. Unset or a default value: `preflight` FAILs; in practice a weak/default value makes every admin token forgeable. | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `JWT_SUBJECT_SECRET` | Same, for the subject/user-portal tokens (OTP login, `/me/*`, the principal's own DSAR and photo views). | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `FACE_EMBEDDING_KEY` | AES-256-GCM key for enrollment embeddings at rest (`backend/src/lib/embeddingCrypto.js`). The server "refuses to boot without this rather than silently persisting plaintext vectors" per the inline comment in `.env.example` — biometric vectors are the most sensitive artifact in the schema. | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `DATABASE_URL` / `DIRECT_URL` | No database connection at all. In production, `DATABASE_URL` must also carry `sslmode=require` (or `verify-full`/`verify-ca`) — `preflight` FAILs on a production URL without it ("the Postgres connection would be in the clear"). See §3 below: this must point at `prism_app`, **not** the Supabase `postgres` owner role. |  |
| `AUTH_PROVIDER=real` | `preflight` FAILs in production if this isn't exactly `"real"` — its absence means the dev auth stub could still be live, which authenticates any caller as a fake user. |  |

### Operational (needed, but not secrets)

| Variable | What breaks without it |
|---|---|
| `REDIS_URL` | BullMQ (face/redaction/purge queues) can't connect; enqueue calls throw or the process can't reach a broker. See §5. In production this should be `rediss://` (TLS) — `preflight` WARNs otherwise, because job payloads carry photo and subject ids. |
| `QDRANT_URL` | Face matching galleries (`createGallery`/`addEnrollmentPoint`) can't be built — `endSession` throws 503 ("Face gallery unavailable — is Qdrant running?") for every session. |
| `FACE_SERVICE_URL`, `PII_SERVICE_URL` | Recognition/redaction (`session.service.js`) and bystander/PII masking can't reach the face-worker or image-pii-worker. Per invariant 8, a PII-worker outage now fails the photo closed (`piiStatus=DEFERRED`) rather than shipping it unmasked — see `docs/DPIA.md` R1 — but that means an outage silently piles up deferred photos instead of erroring loudly, so these URLs must be correct and the services must be up. |
| `STORAGE_ROOT` | Where sealed media blobs live on disk. Wrong path in production either writes into an ephemeral container filesystem (data loss on redeploy) or into a path without room/permissions. |
| `CORS_ORIGINS`, `APP_BASE_URL`, `ADMIN_APP_BASE_URL`, `USER_PORTAL_URL` | Portal logins fail CORS, or the QR/email links embedded in consent notices and DSAR emails point at `localhost`. `USER_PORTAL_URL` specifically is encoded into the session-join QR — it must be an address a volunteer's phone can actually reach (LAN IP or a tunnel), and on-device selfie capture additionally requires HTTPS. |
| `SMTP_*` / `RESEND_API_KEY` | OTP and DSAR notification email delivery. Per the team's memory note, Mailjet has silently dropped mail before (SMTP 250 OK, nothing delivered) — verify actual delivery post-deploy, not just that credentials are set. |
| `DSAR_SLA_DAYS`, `DSAR_INTERNAL_SLA_DAYS`, `DSAR_PACKAGE_TTL_DAYS`, `DSAR_PACKAGE_REISSUE_TTL_MINUTES` | Statutory/internal SLA tracking and access-package token lifetimes. Defaults in `.env.example` (30/7/30/15) are reasonable production values; only override deliberately. |

---

## 2. `npm run preflight` — the gate

`backend/scripts/preflight.js` is the single script that turns every one of
the above into a checkable claim instead of an assumption. Run it before every
production deploy:

```
cd backend && npm run preflight
```

**Severity model, read directly from the script:**
- `FAIL` — non-zero exit **only when `NODE_ENV=production`**. Outside
  production it still prints RED and lists every failure, but exits 0 — "a
  laptop is allowed to run on defaults so long as nobody is pretending
  otherwise."
- `WARN` — never blocks, in any environment.

**A green preflight is a precondition for go-live.** Do not deploy on a RED
preflight and reason about it after the fact — that is exactly the failure
mode the script exists to prevent (a missing KEK "still writes files," a
BYPASSRLS role "still accepts the RLS migration").

### The checks (15, in a non-production run with secrets configured — matches the count in `docs/HANDOFF.md` §6.4)

| # | Check | What it verifies |
|---|---|---|
| 1 | `AUDIT_HMAC_SECRET` | set, not a known-weak/default value, ≥32 chars |
| 2 | `MEDIA_KEK` | set, decodes to exactly 32 bytes |
| 3 | `DSAR_SIGNING_SEED` | set explicitly, or at least derivable from `MEDIA_KEK` |
| 4 | `JWT_ADMIN_SECRET` | set, not a default |
| 5 | `JWT_SUBJECT_SECRET` | set, not a default |
| 6 | `AUTH_PROVIDER` | `"real"` in production (dev stub not live) |
| 7 | `DATABASE_URL` | present; `sslmode=require` in production |
| 8 | `no-mock-data` | seed scripts (`seed.js`, `seed-project.js`, `seed-subjects.js`) and `admin-portal/src/data/` are absent from the repo |
| 9 | `bootstrap-guard` | `prisma/seed-admin.js` still refuses to run when an admin already exists (checks the source still contains the `adminUser.count()` guard) |
| 10 | `rls:audit_log` | RLS enabled **and forced** on `audit_log` |
| 11 | `rls:access_events` | same, on `access_events` |
| 12 | `rls:deletion_certificates` | same, on `deletion_certificates` |
| 13 | `db-role` | the connected Postgres role is not `SUPERUSER`/`BYPASSRLS` — see §3 |
| 14 | `migrations` | no `_prisma_migrations` row with `finished_at IS NULL` |
| 15 | `redis` | reachable, and `redis_version` ≥ 6.2.0 (BullMQ's floor) |

Two more checks only fire in a production run (`NODE_ENV=production`) and are
not part of the 15 above: `REDIS_URL` must be `rediss://` (WARN only), and
`MEDIA_REQUIRE_SEALED` should be `"on"` once the media-encryption backlog has
been swept (WARN if not — see §4).

---

## 3. Database role — do not connect as the Supabase owner

Supabase's `postgres` role holds `BYPASSRLS`. RLS is enabled **and forced**
(`FORCE ROW LEVEL SECURITY`) on `audit_log`, `access_events` and
`deletion_certificates` — that's what makes them append-only — but `FORCE`
does nothing against a role that bypasses RLS unconditionally. Connecting the
application as `postgres` makes every one of those append-only guarantees
inert while looking, from the schema, completely correct. `preflight` check
#13 (`db-role`) exists specifically to catch this and will FAIL in production
if the connected role has `rolsuper` or `rolbypassrls`.

The fix is `backend/scripts/sql/provision-app-role.sql`, already in the repo.
It creates (or updates) a `prism_app` login role with `NOSUPERUSER
NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`, grants ordinary DML on all
tables, then explicitly **revokes** `UPDATE, DELETE, TRUNCATE` on the three
evidentiary tables from that role — belt-and-braces on top of RLS, so a future
migration that carelessly adds an UPDATE policy still hits a missing
privilege, not just a policy.

Run once per environment, as the platform owner (Supabase's connection
string, not `prism_app`):

```
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
# → use this as the password

psql "$ADMIN_DATABASE_URL" -v password="'<generated-password>'" \
  -f backend/scripts/sql/provision-app-role.sql
```

Then point production's `DATABASE_URL`/`DIRECT_URL` at `prism_app` with that
password, not at `postgres`.

**Verification** (the exact queries at the bottom of the SQL file — run all of
them post-provisioning, as `prism_app`):

```sql
-- all three of these must FAIL:
UPDATE audit_log SET action = 'x' WHERE id = (SELECT id FROM audit_log LIMIT 1);
DELETE FROM access_events WHERE true;
DELETE FROM deletion_certificates WHERE true;

-- and this must return (f, f):
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
```

Re-run `npm run preflight` afterward and confirm check #13 (`db-role`) now
`PASS`es as "connected as least-privilege role \"prism_app\"".

---

## 4. Media encryption at rest — ordering matters

`backend/src/lib/storage.js` is the single choke point every media read/write
goes through (L2/L4/L6/L7 of `docs/01_PRIVACY_DATAFLOW.md` §2). Encryption is
keyed entirely off `MEDIA_KEK` being present:

- **`MEDIA_KEK` unset**: `ENCRYPTION_ENABLED` is computed `false` at import.
  `storage.js` **throws at boot** if `NODE_ENV=production` in that state — it
  will not silently write plaintext faces to disk in prod. Outside
  production, it boots and writes plaintext (this is the current state of the
  dev machine per `docs/HANDOFF.md` §6.3).
- **`MEDIA_KEK` set**: new writes are sealed immediately (envelope encryption:
  per-project/per-subject/per-path DEKs derived from the KEK; the blob header
  carries a `keyId` so KEK rotation is lazy, not a flag day). Reads tolerate
  legacy unsealed blobs transparently until you turn on the next flag.

**The required order for go-live:**

1. **Set `MEDIA_KEK`** (and `MEDIA_KEK_VERSION="1"`) in the production
   environment.
2. **Deploy.** From this point every new write is sealed. Existing objects on
   disk are still plaintext and still readable (the store tolerates mixed
   sealed/unsealed content).
3. **Run the backfill** against the deployed store:
   ```
   node backend/scripts/migrate-media-encrypt.js
   ```
   It's idempotent and resumable by construction — "already sealed" is read
   from the file's own header (the `PRSM` magic bytes), not a checkpoint file,
   so a crash mid-run leaves either the intact original or the finished
   ciphertext, never a half-written blob. Supports `--dry-run`, `--verbose`,
   `--limit=N`, `--only=<comma-list>` for a staged sweep of a large corpus.
4. **Set `MEDIA_REQUIRE_SEALED="on"`.** From this point, `readFile` throws
   hard on any object that still isn't sealed instead of quietly passing
   plaintext through — this is what turns "everything is encrypted" from a
   hope into a checkable invariant. Only flip this after step 3 has actually
   completed (check the migration script's summary counts — `missing`/`failed`
   should be zero, or explicitly accounted for).
5. **Redeploy** so the running process picks up `MEDIA_REQUIRE_SEALED=on`.

Re-run `npm run preflight` after step 5 — the `MEDIA_REQUIRE_SEALED` check
should now `PASS` instead of WARN.

---

## 5. Redis — must be ≥ 6.2 in production

BullMQ (the face/redaction/purge queues — `backend/src/lib/faceQueue.js`,
`redactionQueue.js`, `purgeQueue.js`) requires Redis ≥ 6.2 for the commands it
relies on. Below that floor, workers start, accept jobs, and fail in ways
that look like application bugs rather than an infra mismatch — `preflight`
check #15 exists to catch this before it does.

`backend/docker-compose.yml` already pins `redis:7.4-alpine` — **this is the
supported production path**, deploy that image (or any managed Redis ≥ 6.2,
ideally reachable over `rediss://` per §1).

**This machine's dev environment is explicitly below the floor and is a
DEV-ONLY limitation, not a production plan**: the local Windows Redis
binaries here are `5.0.14.1` (both `~/redis` and
`~/Desktop/redis-portable`), no Docker is installed, and `preflight` reports
this as a hard FAIL (non-fatal outside `NODE_ENV=production` only). On Redis
5.0 the redaction, purge, and recognition-retry workers will not correctly
retry deferred work — a `piiStatus=DEFERRED` photo or a failed purge attempt
can sit unprocessed indefinitely. Do not deploy production against anything
below 6.2; `docker-compose.yml`'s `redis:7.4-alpine` is the tested path.

---

## 6. Workers — long-lived processes, not one-off scripts

From `backend/package.json`:

| Script | Binds to | Must run long-lived in production because... | Silently stops working if absent |
|---|---|---|---|
| `worker:start` (`node src/workers/recognition.worker.js`) | recognition queue (`faceQueue.js`) | `endSession` enqueues a `RecognitionJob` and returns immediately; the worker is what actually runs face matching against the session gallery. (`npm run worker` is the same file under `--watch`, for dev only.) | Sessions stay `PROCESSING` forever — nothing ever reaches `TAGGING`. |
| `worker:redaction` (`redaction.worker.js`) | `REDACTION_QUEUE_NAME` | Drains photos `finalizeSession` couldn't mask, per invariant 8 (fail-closed PII detection) — typically because the image-pii-worker was briefly down. | Deferred photos (`piiStatus=DEFERRED`) never clear. They stay unserveable (every read route 409s per `docs/DPIA.md` R1) and the session handoff refuses to ingest the batch — permanently, not just until the next attempt, since nothing re-attempts them. |
| `worker:purge` (`purge.worker.js`) | `PURGE_QUEUE_NAME` | Runs DSAR erasures out-of-band for purges too large to hold an HTTP request open, then calls `issueCertificate` and flips the `DsarRequest` to `REVIEW`. Concurrency is pinned to 1 deliberately — two purges touching the same multi-subject photo must not interleave. | Queued erasures never execute; no deletion certificate is ever issued for them, so the fiduciary cannot prove a DSAR erasure completed. Failed attempts dead-letter into an `PURGE_EXHAUSTED_RETRIES` audit entry, so an absent worker means that alarm never fires either. |
| `worker:retention` (`retention.worker.js`) | nothing — runs its own `setInterval` loop, **not** BullMQ, so it does not depend on Redis at all | Sweeps L2 originals past their 7-day post-archive TTL (`RETENTION_ORIGINAL_DAYS`) and expires DSAR access packages (`expirePackages`). This is the *only* code path in the system that deletes a raw original on a timer — nothing in the request path does it. | Raw originals are retained past their lawful purpose indefinitely; expired DSAR download tokens never get swept. |

All four (`worker:start`, `worker:redaction`, `worker:purge`,
`worker:retention`) must be running as supervised, restart-on-crash processes
in production — not started ad hoc, and not assumed to be covered by the API
server process, which does not run any of them.

---

## 7. Migrations

```
cd backend && npx prisma migrate deploy
```

Confirms against `_prisma_migrations` — this is also `preflight` check #14.
As of this session there are 11 migrations under `backend/prisma/migrations/`,
the four most recent being the governance/DSAR/audit work:

```
20260725000001_governance_dsar
20260725000002_rls_audit_access
20260725000003_audit_payload_digest
20260725000004_subject_erased_status
```

`migrate deploy` is non-interactive and safe for CI/CD — it does not attempt
to generate new migrations or prompt, unlike `prisma migrate dev` (which is
the `prisma:migrate` script and is dev-only).

---

## 8. Post-deploy verification

1. **Liveness**: `curl https://<host>/health` → `{"status":"ok"}`.
2. **Dependency health**: `curl https://<host>/health/deep` → `200` with
   `{"postgres":true,"qdrant":true}`. A `503` means one of those two is
   unreachable from the deployed process — note that this endpoint does
   **not** check Redis, the face-worker, or the image-pii-worker, so a green
   `/health/deep` is not a full readiness proof; check the four workers'
   process status and the two Python services' own health routes separately.
3. **Security suite against the deployed database**:
   ```
   cd backend && npm run test:security
   ```
   Point the environment this runs in at the production `DATABASE_URL`
   (`prism_app`, not the owner role) so the RLS/role assertions
   (`tests/security/audit-chain.test.js`, `crypto.test.js`) are checked
   against what's actually deployed, not a local Supabase branch. This suite
   is read/write against real tables — run it in a maintenance window or
   against a just-provisioned environment before real traffic lands, not
   against a live database mid-traffic.
4. Re-run `npm run preflight` one final time post-deploy with the production
   environment variables loaded, and confirm 0 failures.

---

## Known gaps this checklist does not close

- `image-pii-worker` and Postgres are **not** in `backend/docker-compose.yml`
  (only `qdrant`, `redis`, `face-worker` are) — provision and deploy the
  image-pii-worker (`ai-core/image-pii-worker`) separately, and confirm
  `PII_SERVICE_URL` in production points at it. Postgres here is Supabase,
  managed outside this compose file entirely.
- This checklist does not cover DPB breach-notification tooling
  (`docs/RUNBOOK_BREACH.md` §2 — `BreachRecord` and the notification job are
  still not built) or the minor/guardian-consent gate (`docs/DPIA.md` R8) —
  neither blocks a technical go-live, both are open compliance gaps tracked
  elsewhere.
