# Auth, RBAC & OTP (Resend) — Implementation Plan
### Planning Phase Only — No Code Written Yet — v2 (post user review — 7 gaps addressed)

**Decisions locked in before drafting v1:**
1. Data subjects stay **fully passwordless** — register → email OTP → verify → session. No password field for subjects, ever.
2. **Email becomes mandatory** for all subjects (was optional) — required since OTP delivery is Resend-only (email, no SMS). Volunteers without email must go through agent-assisted registration instead.
3. **Subjects and admins are two entirely separate auth systems** — separate tables, separate JWTs, separate login endpoints, separate middleware. A subject token must never satisfy an admin route and vice versa.
4. Admin roles get a 5th tier, **`super_admin`**, which invites/assigns the other 4 roles. First super-admin is created via a seed script (bootstrap), not through the invite flow.
5. **(v2)** Deployment topology confirmed: all pieces (user-portal, admin-portal, backend) will live on subdomains of one domain — `sameSite=strict` cookies work as designed, no loosening needed.

*(v1→v2 changelog: user review surfaced 7 gaps — each addressed below, inline, tagged `(v2)`.)*

---

## 1. Scope & flows

### 1a. Data subject registration & login (passwordless)
- **Registration** (already built, needs upgrading): `POST /api/v1/subjects` — now requires `email`. On success, immediately triggers OTP send.
- **Login (returning subject)** — net-new: `POST /auth/subject/login { email }` → looks up subject by email → generates OTP → sends via Resend → `POST /auth/subject/verify { email, otp }` → issues subject session (JWT access + rotating refresh, httpOnly cookies).
- **Registration verify** reuses the same OTP verify mechanism as login, replacing today's stub that accepts any code.
- **`GET /auth/subject/me`** *(v2, new — was missing)* — returns `{ masterUserId, email, group, status }` for the currently-authenticated subject. Required because `httpOnly` cookies mean the frontend can never read the JWT itself; this is how `user-portal` hydrates "who is logged in" on page load.

### 1b. Admin registration/invitation & login (password-based)
- **Invite**: `POST /auth/admin/invite { email, role }` (super_admin only) → creates `AdminUser` row (`status: INVITED`) → generates a single-use opaque invite token → Resend sends an email with an accept-invite link.
- **Accept invite**: `POST /auth/admin/accept-invite { token, password }` → validates token → sets password hash, `status: ACTIVE`, consumes token.
- **Login**: `POST /auth/admin/login { email, password }` → bcrypt compare → issues admin session (JWT access + rotating refresh, httpOnly cookies, separate signing/audience from subject tokens).
- **`GET /auth/admin/me`** *(v2, new — was missing)* — returns `{ id, email, role }` for the currently-authenticated admin. Same reasoning as 1a: `admin-portal`'s `RequireRole` needs a real source for "the verified role from the session," and can't get it by reading an `httpOnly` cookie directly.
- **Bootstrap**: `prisma/seed-admin.js` creates the first `super_admin` directly, printing a one-time accept-invite-style link to console rather than hardcoding a password.

### 1c. OTP generation, delivery, verification, expiry, resend/rate-limits
- 6-digit numeric code, `crypto.randomInt`, hashed (SHA-256) at rest.
- Expiry: 10 minutes. Max 5 wrong attempts, then the code is dead and a new one must be requested.
- Resend cooldown: 60 seconds, enforced server-side.
- Rate limit on `/auth/subject/login` and `/auth/subject/verify`: per-IP and per-email via `express-rate-limit`.
- **Account lockout, independent of rate limiting** *(v2, new — gap #3)*: `/auth/admin/login` tracks `failedLoginAttempts` per admin account. After 10 consecutive failures, the account locks for 30 minutes (`lockedUntil` timestamp) **regardless of source IP** — closes the gap where a slow, distributed attack against one admin email would otherwise sail under IP-based rate limits untouched.
- **Resend delivery failure handling** *(v2, new — gap #5)*: attempt the send exactly once, no automatic server-side retry (avoids duplicate-send races if Resend's response is slow/ambiguous). On failure: the OTP row is still created and counts toward cooldown/rate-limit (prevents an attacker from using induced failures to bypass throttling), the endpoint returns `502` with a clear error, and the failure is logged at `error` level via `pino` with the request's correlation ID. Retrying is the existing "Resend Code" UI action — no new server-side retry logic.

### 1d. Password reset / account recovery (admins only)
- `POST /auth/admin/request-reset { email }` → generates single-use opaque token → Resend sends reset link → `POST /auth/admin/reset-password { token, newPassword }` → validates + updates hash → invalidates every existing refresh token for that admin.

### 1e. Session/token strategy: JWT, short-lived access + rotating refresh
- **Access token**: JWT, 15 min expiry, verified statelessly.
- **Refresh token**: 7-day, single-use, rotated on every use; reuse of an already-rotated token revokes the entire token family. Stored server-side only as a SHA-256 hash.
- `httpOnly`, `secure`, `sameSite=strict` cookies — confirmed safe given the single-domain deployment topology (decision #5 above).
- Subject and admin tokens use separate secrets and carry a `principalType` claim (`SUBJECT` / `ADMIN`) checked explicitly by every middleware.
- **Closing the stale-claim/revocation window** *(v2, new — gap #2)*: a 15-minute stateless access token means a role change or admin disablement wouldn't take effect for up to 15 minutes under the v1 design. Fixed by extending the **same Redis hotlist pattern `backend-plan.md` already uses for consent revocation** ("write to Redis before DB commit, closes the race window") to admin sessions: on role change or disable, write `tokenValidAfter = now()` for that admin to Redis; `requireAdminAuth` checks the JWT's `iat` claim against it on every request, rejecting stale tokens immediately. This reuses an existing, already-reasoned-through pattern rather than inventing a new one — access token TTL stays at 15 minutes since the actual gap is now closed at the revocation-check level, not the TTL level.

---

## 2. RBAC design

- **Roles** (5 total): `super_admin`, `dpo`, `dataOwner`, `collectionAgent`, `dataAdmin`.
- **Assignment**: set at invite time by the inviting super-admin; changeable later only by a super-admin.
- **Enforcement**:
  - `requireAdminAuth` — verifies the admin JWT, checks the Redis `tokenValidAfter` revocation timestamp *(v2)*, attaches `req.admin = { id, role }`. Replaces today's dev-stub `requireAuth` for all admin routes.
  - `requireRole(...allowed)` — composes after `requireAdminAuth`, gates a route/route-group to specific roles. Mirrors the frontend's existing `RequireRole({ allow })` pattern in `admin-portal/src/auth.jsx`.
  - `requireSubjectAuth` — entirely separate middleware, verifies the subject JWT, attaches `req.subject = { masterUserId }`.
- **Scope of this phase**: role-based only, not resource/project-scoped — carrying `backend-plan.md`'s open question #4 forward unresolved, not silently expanding into it.

---

## 3. Data model

```prisma
model AdminUser {
  id                 String        @id @default(uuid()) @db.Uuid
  email              String        @unique @db.Citext
  passwordHash       String?
  role               AdminRole
  status             AdminStatus   @default(INVITED)
  invitedByAdminId   String?       @db.Uuid
  failedLoginAttempts Int          @default(0)   // (v2, new — gap #3)
  lockedUntil        DateTime?                    // (v2, new — gap #3)
  lastLoginAt        DateTime?
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt

  @@index([role, status])
  @@map("admin_users")
}

enum AdminRole {
  super_admin
  dpo
  dataOwner
  collectionAgent
  dataAdmin
}

enum AdminStatus {
  INVITED
  ACTIVE
  DISABLED
}

model OtpCode {
  id          String     @id @default(uuid()) @db.Uuid
  email       String     @db.Citext
  purpose     OtpPurpose
  codeHash    String
  attempts    Int        @default(0)
  maxAttempts Int        @default(5)
  expiresAt   DateTime
  consumedAt  DateTime?
  createdAt   DateTime   @default(now())

  @@index([email, purpose, consumedAt])
  @@map("otp_codes")
}

enum OtpPurpose {
  SUBJECT_LOGIN
}

model AuthToken {
  id          String           @id @default(uuid()) @db.Uuid
  adminUserId String           @db.Uuid
  purpose     AuthTokenPurpose
  tokenHash   String           @unique
  expiresAt   DateTime
  consumedAt  DateTime?
  createdAt   DateTime         @default(now())

  admin AdminUser @relation(fields: [adminUserId], references: [id], onDelete: Cascade)

  @@map("auth_tokens")
}

enum AuthTokenPurpose {
  ADMIN_INVITE
  ADMIN_PASSWORD_RESET
}

// (v2, changed — gap #4): two nullable FK columns + CHECK constraint, replacing the
// no-FK principalType/principalId design from v1. Chosen specifically because this
// platform's core purpose is rigorous data lifecycle management (purge/DSAR) — cascade
// delete on refresh tokens when a subject or admin is deleted actually matters here,
// not just referential-integrity hygiene for its own sake.
model RefreshToken {
  id          String    @id @default(uuid()) @db.Uuid
  subjectId   String?   @db.Uuid
  adminUserId String?   @db.Uuid
  familyId    String    @db.Uuid   // shared across a token's rotation lineage, for reuse-detection revocation
  tokenHash   String    @unique
  expiresAt   DateTime
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())

  subject   Subject?   @relation(fields: [subjectId], references: [masterUserId], onDelete: Cascade)
  adminUser AdminUser? @relation(fields: [adminUserId], references: [id], onDelete: Cascade)

  @@index([subjectId])
  @@index([adminUserId])
  @@map("refresh_tokens")
}
```

A DB-level `CHECK` constraint (`(subject_id IS NOT NULL) != (admin_user_id IS NOT NULL)`) enforces exactly one is set — added via raw SQL in the migration since Prisma's schema language doesn't express multi-column CHECK constraints directly.

**Change to existing `Subject` model**: `email` goes from `String?` to `String` (required). **Pre-migration check needed**: confirm no existing subject rows have a null email before this migration runs.

---

## 4. File/folder structure

| File | Purpose |
|---|---|
| `backend/prisma/schema.prisma` | Add `AdminUser`, `OtpCode`, `AuthToken`, `RefreshToken` models + enums; make `Subject.email` required |
| `backend/prisma/seed-admin.js` | Bootstrap the first `super_admin`; prints a one-time accept-invite link to console |
| `backend/src/lib/otp.js` | Generate/hash/verify 6-digit codes, expiry + attempt-count logic |
| `backend/src/lib/tokens.js` | JWT sign/verify (separate config per `principalType`), refresh-token issue/rotate/reuse-detection |
| `backend/src/lib/revocation.js` | *(v2, new)* Redis `tokenValidAfter` read/write — checked by `requireAdminAuth` on every request |
| `backend/src/lib/resend.js` | Resend client wrapper: `sendOtpEmail()`, `sendAdminInviteEmail()`, `sendPasswordResetEmail()` |
| `backend/src/lib/cleanup.js` | *(v2, new — gap #7)* `cleanupExpiredAuthRecords()` — deletes expired/consumed `OtpCode`/`AuthToken`/`RefreshToken` rows. Scheduling deferred (run manually or via this environment's `CronCreate` tool if wanted now — not built into the app itself yet, matching the project's general "don't build scheduling infra before it's needed" pattern) |
| `backend/src/middleware/requireSubjectAuth.js` | Verifies subject JWT, attaches `req.subject` |
| `backend/src/middleware/requireAdminAuth.js` | Verifies admin JWT + Redis revocation check *(v2)*, attaches `req.admin` |
| `backend/src/middleware/requireRole.js` | Role-gate composed after `requireAdminAuth` |
| `backend/src/middleware/rateLimiter.js` | `express-rate-limit` instances for OTP-request/verify and admin login |
| `backend/src/modules/auth-subject/{routes,controller,service,validation}.js` | `login`, `verify`, `me` *(v2)*, `refresh`, `logout` |
| `backend/src/modules/auth-admin/{routes,controller,service,validation}.js` | `login`, `invite`, `accept-invite`, `request-reset`, `reset-password`, `me` *(v2)*, `refresh`, `logout` |
| `backend/docker-compose.yml` | Add Redis service — now serves rate-limiting **and** the session-revocation hotlist *(v2)* |
| `backend/.env.example` | Add `RESEND_API_KEY`, `JWT_SUBJECT_SECRET`, `JWT_ADMIN_SECRET`, `REDIS_URL`, `APP_BASE_URL` |
| `user-portal/src/pages/Login.jsx` | Rewrite: email-only OTP request, remove decorative password fields |
| `user-portal/src/lib/api.js` | Add `requestLoginOtp()`, `getMe()` *(v2)*, `refreshSession()`, `logout()` |
| `admin-portal/src/pages/Login.jsx` | Rewrite: real email+password form, remove role-picker mock |
| `admin-portal/src/pages/AcceptInvite.jsx` | New — set password from an invite link |
| `admin-portal/src/pages/ForgotPassword.jsx`, `ResetPassword.jsx` | New — password recovery flow |
| `admin-portal/src/auth.jsx` | Rewrite: real JWT-backed `AuthProvider` that calls `GET /auth/admin/me` on load to hydrate identity/role *(v2)*; `RequireRole` checks that real role instead of a `localStorage` string |
| `admin-portal/src/lib/api.js` | New — `login()`, `getMe()` *(v2)*, `refresh()`, `logout()`, invite-related calls |

---

## 5. Security considerations

- **Passwords**: bcrypt, cost factor 12.
- **OTP/tokens**: hashed (SHA-256) at rest; never logged or returned in responses; pino redaction paths for `otp`, `password`, `token` fields.
- **Rate limiting**: per-IP and per-email on OTP/login endpoints, Redis-backed for correctness across multiple instances.
- **Account lockout** *(v2)*: per-account failure counter independent of IP, closes the distributed-slow-attack gap rate limiting alone doesn't cover.
- **Refresh token rotation + reuse-detection**, stored hashed, with FK-based cascade delete tied to the owning subject/admin *(v2)*.
- **Session revocation** *(v2)*: Redis `tokenValidAfter` check closes the stale-access-token window on role change/disablement, reusing the platform's existing consent-revocation-hotlist pattern.
- **Cookies**: `httpOnly` + `secure` + `sameSite=strict`, distinct names/paths for subject vs. admin — confirmed compatible with the single-domain deployment topology.
- **`principalType` claim** checked explicitly in every middleware, on top of separate signing secrets.
- **Invite/reset tokens**: single-use, opaque, hashed at rest identically to OTPs.
- **Resend failure handling** *(v2)*: single attempt, clear `502` to client, no silent success, no duplicate-send retry logic.
- **Password reset invalidates all refresh tokens** for that admin.
- **Audit trail**: every auth event writes through the existing `lib/auditLog.js` hash chain.
- **Validation**: zod on every new endpoint.
- **Cleanup** *(v2)*: expired/consumed auth records get a dedicated cleanup function; scheduling is a deferred TODO, not built now.

---

## 6. Dependencies (new packages)

| Package | Why |
|---|---|
| `bcrypt` | Admin password hashing |
| `jsonwebtoken` | JWT sign/verify |
| `resend` | Official Resend SDK — OTP, invite, and reset emails |
| `express-rate-limit` | Rate limiting on auth endpoints |
| `rate-limit-redis` + `ioredis` | Redis-backed rate-limit store — **the same Redis instance also now backs session revocation (v2)**, not a second service for a second purpose |
| *(none — built-in `crypto`)* | OTP/token generation and hashing needs no new dependency |

---

## Resolved from v1's open items
- ~~Cookie/CORS topology~~ — **resolved**: single-domain deployment confirmed, `sameSite=strict` stands as designed.
- ~~Redis vs. Postgres for rate limiting~~ — **resolved, more strongly than before**: Redis is now load-bearing for two features (rate limiting *and* session revocation), not just one — clearly worth the added infra piece.

## Still open, not resolved here
- Project-scoped (not just role-scoped) admin permissions remain an explicit non-goal of this phase, per `backend-plan.md`'s own unresolved open question #4.
