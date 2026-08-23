# PRISM Production Audit — Authentication / Authorization / Session / RBAC

Auditor domain: authn, authz, session management, RBAC.
All tests run against the LIVE stack (backend :4000, Postgres :5433) on 2026-08-20/21.
Every claim is tagged OBSERVED (backed by a command transcript) or INFERRED (from code).

Principals used (seed data, password `Prism@2026!`):
- dpo@prism.local (dpo, id 168ba10c)
- dataowner@prism.local (dataOwner, id 59f94c2a) — owns projects 397c07b9, 65e5053a
- agent@prism.local (collectionAgent, id 42a7429f)
- dataadmin@prism.local (dataAdmin, id 82baaaf8)
IDOR targets (other owners): project a9d42ab7 (owner 4210eada), 02ea001c (owner 54bf5cd5).

================================================================================
## P1-1  Horizontal privilege escalation / IDOR — a dataOwner reads any other owner's project detail and its assignment roster
================================================================================
OBSERVED.

`projectRoutes` mounts `GET /:projectId` -> `assertAssigned()` and
`GET /:projectId/assignments` -> `listAssignments()` which also calls `assertAssigned()`.

backend/src/modules/projects/project.service.js:34-46

    export async function assertAssigned(projectId, admin) {
      const project = await prisma.project.findUnique({ where: { id: projectId } })
      if (!project) throw new ApiError(404, 'Project not found')
      if (admin.role === 'collectionAgent') {          // ONLY collectionAgent is scoped
        const assignment = await prisma.projectAssignment.findUnique({...})
        if (!assignment) throw new ApiError(403, 'You are not assigned to this project')
      }
      return project                                    // dataOwner/dpo/dataAdmin: no owner check
    }

For a dataOwner the function returns ANY project. Every OTHER project route enforces
ownership: mutations via `assertOwned()` (project.service.js:22-28) and oversight reads
(`/sessions`,`/handoffs`,`/report`) via `assertOversight()` (project.service.js:404-410,
`if (admin.role==='dataOwner' && project.ownerAdminId!==admin.id) 403`). The base detail
read and the assignments read are the two that skip it.

Live proof (fresh dataOwner cookie):

    GET /api/v1/projects/397c07b9 (OWN)                       -> 200
    GET /api/v1/projects/a9d42ab7 (OTHER owner 4210eada)      -> 200   <-- IDOR
       body: {"id":"a9d42ab7...","name":"E2E Project 469df85f",
              "purpose":"Supervised collection of facial imagery...",
              "policyVersion":"E2E Notice 469df85f v1","ownerAdminId":"4210eada...",
              "retention":"90 days after project close",...}
    GET /api/v1/projects/02ea001c (OTHER owner 54bf5cd5)      -> 200   <-- IDOR
    GET /api/v1/projects/a9d42ab7/assignments (OTHER owner)   -> 200   <-- IDOR
       body: {"items":[{"admin":{"email":"e2e-469df85f-collectionAgent@test.invalid",
              "role":"collectionAgent","status":"ACTIVE"}}]}
    GET /api/v1/projects/a9d42ab7/report   (assertOversight)  -> 403   (correctly blocked)
    GET /api/v1/projects/a9d42ab7/sessions (assertOversight)  -> 403   (correctly blocked)

Leaks any-owner-to-any-owner: project name, purpose, policyVersion, retention, riskLevel,
dataTypes, ownerAdminId, AND the email/role/status of every assigned collection agent.
Documented intent is per-owner scope: docs/02_ROLE_PERMISSION_MATRIX.md:13 ("Data Owner ...
per-project scope"), `GET /projects` row = "✓ own", every oversight row = "✓ own". This
contradicts the module's own design.

Why the test misses it: backend/tests/security/rbac-matrix.test.js checks only the ROLE floor
("rejected for WHO you are") using synthetic random UUIDs (`fillParams` -> randomUUID), and the
matrix explicitly admits dataOwner to `GET /projects/:projectId`. There is NO test anywhere for
horizontal/tenant scoping.

Fix: add an owner check to `assertAssigned` for dataOwner (mirror `assertOversight`), or route
`GET /:projectId` and `/:projectId/assignments` through `assertOversight`.

================================================================================
## P1-2  Preflight go-live gate does NOT enforce JWT secret strength; the dev and .env.example defaults pass it, and a super_admin JWT is forgeable
================================================================================
OBSERVED (forgery live) + OBSERVED (preflight logic simulated).

tokens.js signs/verifies with HS256 + a plain string secret and NO options (no `algorithms`,
no `audience`, no `issuer`):
backend/src/lib/tokens.js:28-38

    export function signAdminAccessToken({id,role}) {
      return jwt.sign({principalType:'ADMIN',sub:id,role}, process.env.JWT_ADMIN_SECRET, {expiresIn:'15m'})
    }
    export function verifyAdminAccessToken(token) {
      const payload = jwt.verify(token, process.env.JWT_ADMIN_SECRET)   // no algorithms/aud/iss
      if (payload.principalType!=='ADMIN') throw new ApiError(401,'Invalid token')
      return payload
    }

The running secret is the shipped dev default `JWT_ADMIN_SECRET="dev-admin-secret-change-in-prod"`
(backend/.env:28). I minted a super_admin token with it and the live server accepted it:

    JWT_ADMIN_SECRET = "dev-admin-secret-change-in-prod"
    forged super_admin token -> GET  /auth/admin/me      -> 200  {"role":"super_admin",...}
    forged super_admin token -> POST /auth/admin/invite  -> 201  (super-only route; created an admin)
    alg:none forged token    -> GET  /auth/admin/me      -> 401  (correctly rejected)

(The probe admin created by the 201 was deleted afterward — deleteMany count:1.) alg:none is
rejected and RS256->HS256 confusion is not exploitable because the secret is a string
(jsonwebtoken 9.0.3 restricts to HMAC for a string key) — so the ONLY forgery vector is SECRET
STRENGTH, which is exactly what the go-live gate fails to check.

scripts/preflight.js is documented as THE gate (docs/DEPLOY.md:49-67, "A green preflight is a
precondition for go-live"). Its JWT check (preflight.js:78-81) is only `if (isWeak(value)) fail`.
`isWeak` (preflight.js:33-38) matches a tiny fixed set {'', changeme, change-me, secret, dev,
development, test, DEFAULT_AUDIT_SECRET, 'dev-only-secret-change-in-prod'} and does NO
length/entropy check (contrast AUDIT_HMAC_SECRET which requires >=32 chars, MEDIA_KEK 32 bytes).
Simulated against real values:

    isWeak('dev-admin-secret-change-in-prod') -> strong? true (len 31)  <-- current dev .env
    isWeak('change-me-admin-secret')          -> strong? true (len 22)  <-- .env.example:33
    isWeak('change-me-subject-secret')        -> strong? true (len 24)  <-- .env.example:32
    isWeak('hunter2')                         -> strong? true (len 7)
    isWeak('a')                               -> strong? true (len 1)

A production deploy that reuses the current dev `.env`, or copies `.env.example` and edits other
fields, or sets a short human secret, passes the gate GREEN while every admin AND subject token
is forgeable. Only the empty-string in deploy/prod.env.example is caught, and only because '' is
in the weak set. gen-secrets.sh emits strong values but nothing forces its output to be used.

Fix: require JWT_ADMIN_SECRET / JWT_SUBJECT_SECRET >= 32 chars, reject values containing
"change"/"dev-"/"secret", and pin `jwt.verify(token, secret, {algorithms:['HS256']})`.

================================================================================
## P2-3  Admin token revocation is inert; password reset does not invalidate live access tokens; no way to force-logout / deprovision an admin
================================================================================
OBSERVED (zero callers) + INFERRED (impact).

requireAdminAuth reads a Redis "tokenValidAfter" hotlist on EVERY admin request:
backend/src/middleware/requireAdminAuth.js:21-24

    const validAfter = await getAdminTokenValidAfter(payload.sub)
    if (validAfter && payload.iat*1000 < validAfter) return next(new ApiError(401,'Session invalidated'))

The WRITE side `markAdminTokensInvalidBefore` (revocation.js:16) — whose purpose per its own
comment is "Call this on role change, disable, or password reset so already-issued 15-minute
access tokens stop working immediately" — has ZERO callers:

    grep -rn markAdminTokensInvalidBefore src tests scripts
      -> only the definition in src/lib/revocation.js:16

Consequences:
1. No admin-management surface exists to change a role or disable an account (the only
   adminUser.update calls are login bookkeeping, invite-activate, password-reset:
   auth-admin.service.js:47,66,120,170). "Role change/disable takes effect immediately"
   describes a path that can never run.
2. resetPassword revokes refresh tokens (auth-admin.service.js:172) but never calls
   markAdminTokensInvalidBefore. After a compromised admin's password is reset, any access
   token the attacker already holds stays valid for up to the full 15-minute TTL — the one
   control that would close that window is wired into the middleware but never triggered.
3. The per-request Redis GET is pure overhead: getAdminTokenValidAfter always returns null.

Fix: call markAdminTokensInvalidBefore(adminId) from resetPassword and from any future
disable/role-change, and add an admin-management/deprovisioning route (a hard requirement for
an operator platform).

Related (verified STRENGTH): refresh rotation + reuse detection is correct — login->RT1;
refresh(RT1)->204+RT2; replay RT1->401 "Session invalidated" and the whole family is revoked;
RT2 afterwards->401. tokens.js:67-92.
Related (weakness): subject refreshSession (auth-subject.service.js:65-69) does NOT re-check
subject status, whereas admin refresh does (auth-admin.service.js:203). A deactivated subject
keeps minting 15-min access tokens from a still-valid refresh token.

================================================================================
## P2-4  No `trust proxy` behind Caddy -> (a) IP rate-limiters collapse to one global bucket, and (b) the evidentiary access-log source IP is spoofable
================================================================================
(b) OBSERVED; (a) INFERRED from topology + code.

Production runs behind Caddy `reverse_proxy backend:4000` (deploy/Caddyfile) but
`app.set('trust proxy', ...)` is set NOWHERE (grep over backend/src: NONE). Express treats the
Caddy container as the client for req.ip.

(a) rateLimiter.js keys the IP limiters on req.ip: adminLoginIpLimiter(30/15m),
    subjectLoginIpLimiter(20), subjectVerifyIpLimiter(30), joinLookupIpLimiter(60),
    joinAcceptIpLimiter(20) — all become a SINGLE global bucket keyed by the proxy IP. 30 admin
    logins/15 min across the WHOLE platform => trivial self-DoS of login/join and a meaningless
    per-IP brute-force control. (The per-EMAIL limiters and per-account lockout still function,
    so brute force of one KNOWN account is still bounded.) INFERRED — could not reconfigure
    behind Caddy this session.

(b) accessLog.js reads the RAW X-Forwarded-For with no trust-proxy validation and stores it as
    the durable evidentiary IP, including for break-glass AccessEvents:
    backend/src/lib/accessLog.js:26-33

        const forwarded = req.headers?.['x-forwarded-for']
        const ip = (Array.isArray(forwarded)?forwarded[0]:forwarded)?.split(',')[0]?.trim()
        return { ip: ip || req.ip || req.socket?.remoteAddress || null, ... }

    Live proof — request sent DIRECTLY to :4000 with a forged header; the value was written
    verbatim into the AccessEvent the design calls evidence:

        subject read own photo, header  X-Forwarded-For: 203.0.113.77, 10.9.9.9  -> 200
        DB AccessEvent (latest for that photo):
           {"ip":"203.0.113.77","userAgent":"curl/8.16.0","action":"VIEW"}

    Any client that can reach the backend directly (it is on the compose network) or influence
    XFF can forge the source IP recorded for biometric reads and break-glass decrypts
    (requireBreakGlass -> recordAccess uses the same clientMeta), defeating the forensic value
    of the records RUNBOOK_BREACH relies on.

Fix: `app.set('trust proxy', 1)` (or real hop count) so both req.ip and the limiter key derive
from a TRUSTED XFF; stop hand-parsing the raw header in accessLog.

================================================================================
## P2-5  Account enumeration — subject login status oracle, plus admin-login timing + status oracles
================================================================================
OBSERVED.

Subject login reveals existence by status code:

    POST /auth/subject/login {"email":"<nonexistent>"} -> 404 {"error":"No account found for this email"}
        (auth-subject.service.js:15)
    POST /auth/subject/login {"email":"<real subject>"} -> 200 "Verification code sent"

(Contrast admin request-reset, correctly non-revealing — auth-admin.service.js:136-138.)

Admin login is safe on the message axis (not-found and wrong-password both 401 "Invalid email
or password") but leaks on TIMING because bcrypt.compare only runs when the account exists:

    not-found email                                  -> 0.27 s
    wrong-pass (real active account, bcrypt cost 12) -> 2.64 s   (~2.4 s delta)

auth-admin.service.js:30-42 (early `if (!admin) throw` before any bcrypt; cost 12 line 16). Two
distinct 403 messages also leak state: "Please accept your invite first" (INVITED) and "This
account has been disabled" (DISABLED) — auth-admin.service.js:33-34.

Fix: uniform 200 for subject login; dummy bcrypt on the not-found path; collapse INVITED/DISABLED
to a generic message.

================================================================================
## P3-6  DSAR existence oracle — /me/dsar/:id returns 403 for another principal's real id, contradicting the stated 404 design
================================================================================
OBSERVED.

me.routes.js:165-167 states: "another principal's request id is a 404, because confirming that it
exists is [a leak]". But getRequest throws 403:
backend/src/modules/dsar/dsar.service.js:145-149

    if (actor.subject) {
      if (request.subjectId !== actor.subject.masterUserId)
        throw new ApiError(403,'This request belongs to another data principal')  // 403, not 404
      return withSla(request)
    }

Live (subject A=de351590 probing subject B's real DSAR 7d1f25de owned by 5c1211e5):

    GET /me/dsar/5a13e5a1 (A's own)              -> 200
    GET /me/dsar/7d1f25de (B's real id)          -> 403 "This request belongs to another data principal"
    GET /me/dsar/9999...9999 (nonexistent)       -> 404 "DSAR request not found"
    GET /me/dsar/7d1f25de/timeline               -> 404   (correct — getSubjectTimeline hides existence)
    GET /me/dsar/9999...9999/timeline            -> 404

So the base detail (and the certificate route, same getRequest) is an existence oracle: 403 =
"exists, someone else's" vs 404 = "doesn't exist". UUIDv4 ids keep practical exploitability low,
but it violates the documented 404 contract and confirms a DSAR id belongs to another principal.
Fix: return 404 for the not-yours case.

================================================================================
## P3-7  JWT verification pins no algorithms / audience / issuer (defense-in-depth)
================================================================================
OBSERVED (behaviour) + INFERRED (hardening).

`jwt.verify(token, secret)` (tokens.js:23,35) passes no options. Under jsonwebtoken 9.0.3 with a
string secret this restricts to HMAC (so RS256->HS256 confusion is unreachable) and alg:none is
rejected (verified: alg:none -> 401). But there is no explicit `algorithms:['HS256']`, no `aud`,
no `iss`. The only thing separating admin and subject token families is the secret plus a
`principalType` claim — no `aud` binds a token to a service. Fragile if the two secrets are ever
equal. Fix: pin algorithms and add distinct aud/iss per family.

================================================================================
## P3-8  errorHandler returns raw err.message for 500s (internal error disclosure)
================================================================================
INFERRED (code).

backend/src/middleware/errorHandler.js:30-38 — for any error without statusCode (default 500) it
logs server-side AND returns `error: err.message` to the client, leaking internal text (Prisma
column names, file paths). Stack traces are not returned. The subject router even notes a raw
Prisma error is a "500, leaks internals" (subject.routes.js:23) yet the global handler still
forwards err.message for 500s. Fix: generic "Internal server error" for statusCode>=500.

================================================================================
## P3-9  All security gating keys on NODE_ENV === 'production' exactly
================================================================================
OBSERVED (devOtp leak) + INFERRED (rest).

cookies.js:1 (`secure: isProd`), otp.js:38-40 (`devOtp` returns the plaintext code unless
NODE_ENV==='production'), storage.js (encryption only enforced/throws under
NODE_ENV==='production'), preflight failures only fatal under IS_PROD. A NODE_ENV of 'prod',
'staging', 'Production', or unset silently ships non-Secure cookies, LEAKS OTP codes, writes
plaintext media, and turns the gate advisory. Live proof of the OTP leak in the current dev env:

    POST /auth/subject/login {"email":"<real subject>"} -> 200 {"message":"...","devOtp":"525168"}

devOtp is a master key to any subject account in any non-exact-'production' env; combined with
subject enumeration (P2-5) it is full subject-account takeover without email access. Fix: derive
one explicit IS_PROD, validate NODE_ENV against an allowlist at boot, fail closed on unknown.

================================================================================
## P3-10  No security headers (helmet); X-Powered-By exposed; no CSRF token
================================================================================
OBSERVED (headers) + INFERRED.

grep for helmet/csurf/csrf over backend/src + package.json: NONE. Responses carry
`X-Powered-By: Express` and none of X-Content-Type-Options, X-Frame-Options, HSTS, CSP,
Referrer-Policy. CSRF has no token; mitigated in practice by SameSite=Strict on all auth cookies
(verified: `Set-Cookie: ...; HttpOnly; SameSite=Strict`; refresh cookies additionally Path-scoped
to their refresh endpoint) plus credentialed CORS restricted to an allowlist (verified: evil
origin NOT reflected; localhost:5180 reflected with Allow-Credentials:true). CSRF risk is low
today, but a biometric platform ships with zero response hardening. Fix: helmet with
HSTS+CSP+nosniff+frameguard; disable X-Powered-By.

================================================================================
## Verified SOUND (not re-flagged)
================================================================================
- Vertical RBAC holds live: collectionAgent, dataAdmin, dataOwner, dpo each got 403 on every
  elevated route tested (invite=super-only, users=dataOwner/super, projects POST=owner/super,
  subjects-identity=agent/super, audit=dpo/dataAdmin/super).
- Session scoping is correct via loadSession() (session.service.js:24-46): agent cannot read
  another agent's session (403); dataOwner cannot read a session in a project it does not own
  (403); holds for the media routes mounted ahead of sessionRoutes (photos/redacted/raw all 403
  cross-tenant). The app.js mount-order shadowing claims (lines 95-141) check out; dataAdmin
  oversight media reads return 200.
- Subject /me/* takes the subject id from the token, never the path; cross-subject photo (404)
  and enrollment reads are scoped by subjectId. Subject token cannot reach admin routes (401)
  and vice-versa.
- Break-glass is fully gated (requireBreakGlass.js): role floor (agent->403), dsarRequestId
  required (400), justification>=20 (400), DSAR must exist (404) and be DISCOVERY/EXECUTING
  (RECEIVED->403), object must belong to the named subject, super_admin needs a DPO second
  approver, recordAccess (fail-closed) + DsarEvidence + audit written BEFORE decrypt.
- logAccess is fail-closed (no log -> no read). OTP hashed at rest, 6 digits, 5 attempts/code,
  10-min expiry, 60s resend cooldown, 10/15m per-email verify limiter -> brute force bounded.
- CORS: credentialed, allowlist-only, no wildcard, evil origin not reflected.

================================================================================
## What I could NOT check
================================================================================
- The global-bucket rate-limiter impact (P2-4a) is INFERRED: I hit :4000 directly (req.ip=::1),
  so could not reproduce the Caddy-fronted req.ip=proxy behaviour without reconfiguring the
  running stack (out of scope). The XFF-spoof half (P2-4b) IS observed.
- Account lockout (10 failures -> 30-min lock) was read from code, not driven to the lock, to
  avoid locking a shared seed account; I only incremented failed counters by 1 on dpo@ and
  agent@ (well under 10; reset on next success).
- Production NODE_ENV behaviour (Secure cookies, storage throw, preflight fatal) was read from
  code; I did not restart under NODE_ENV=production (out of scope). devOtp leak observed in dev.
- I created then deleted one throwaway admin (attacker-probe@evil.test) proving JWT forgery;
  delete confirmed (count:1). A few LOGIN/LOGIN_FAILED/break-glass audit+access rows were
  generated by tests (append-only ledger, expected).
