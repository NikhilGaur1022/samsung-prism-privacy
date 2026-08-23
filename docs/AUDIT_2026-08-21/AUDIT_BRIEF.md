# PRISM audit brief — shared context for all audit agents

## Repo
`C:\Users\gaur3\Desktop\Projects\samsung project`  (Windows, git branch `main`, tree clean)
Use Bash tool (Git Bash / POSIX) for reads: `sed -n '1,200p' FILE`, `grep -rn ... --include=*.js`.
NEVER grep into `node_modules/`, `.venv/`, `dist/`, `__pycache__/` — always scope with
`--include` and explicit dirs (`backend/src`, `admin-portal/src`, `user-portal/src`,
`ai-core/<worker>/*.py`). A bare `grep -r ai-core` takes >2 minutes.

## What this is
PRISM — a DPDP/GDPR privacy-compliance data-collection platform (Samsung PRISM project).
Collection agents run sessions capturing photos / audio / video / text documents of consenting
subjects; faces are detected, clustered and matched against subject enrollments; bystander
faces and PII are redacted; subjects exercise DSAR rights (access / erasure) through a
self-service portal; data admins run discovery, item actions and export packages.

## Topology (ALL OF THIS IS LIVE RIGHT NOW — test against it)
| Component | Where | Notes |
|---|---|---|
| Backend API | `http://localhost:4000` | Express, `backend/src`, ESM |
| Postgres | `localhost:5433` (docker `jre-pg`) | app connects as `prism_app` (NOSUPERUSER/NOBYPASSRLS) |
| Redis | `localhost:6379` | BullMQ queues |
| Qdrant | `http://localhost:6333` | face/voice vector galleries |
| face-worker | `http://localhost:8001` | Python/insightface |
| image-pii-worker | `http://localhost:8002` | fail-closed dep of redaction |
| audio-worker | `http://localhost:8003` | whisper + pyannote + ECAPA |
| text-worker | `http://localhost:8004` | NOT running |
| video-worker | `http://localhost:8005` | NOT running (opt-in profile) |
| user-portal | `http://localhost:5173` | React 19 + Vite 8 + Tailwind 4 |
| admin-portal | `http://localhost:5180` | React 19 + Vite 8 + Tailwind 4 |

`/health` and `/health/deep` on 4000 both return 200 with postgres/qdrant/redis all true.

## Live credentials (dev seed, password `Prism@2026!`)
`dpo@prism.local`, `dataowner@prism.local`, `agent@prism.local`, `dataadmin@prism.local`
(there is also a super_admin `nikhilgaur1022@gmail.com` whose password is unknown).
Login is cookie-based:
```
curl -s -c /tmp/c.txt -X POST http://localhost:4000/auth/admin/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"dataowner@prism.local","password":"Prism@2026!"}'
curl -s -b /tmp/c.txt http://localhost:4000/api/v1/projects
```
Pre-made cookie jars already exist (re-login if expired):
`SCRATCH/cookies.dpo.txt`, `cookies.dataowner.txt`, `cookies.agent.txt`, `cookies.dataadmin.txt`
where SCRATCH = `C:/Users/gaur3/AppData/Local/Temp/claude/C--Users-gaur3-Desktop-Projects-samsung-project/d6272007-bced-4868-9d91-b7ebe6977b05/scratchpad`

## Live DB data present
subject 9 · project 4 · session 36 · photo 110 · photoSubject 79 · subjectDataItem 91 ·
dsarRequest 3 · importBatch 0 · recording 29 · videoAsset 0 · textDocument 7 ·
faceDetection 108 · faceCluster 13 · auditLog 4817

Query it directly (run from `backend/`):
```
cd backend && node --input-type=module -e "
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
console.log(await p.photo.findMany({ take: 5 }))
await p.\$disconnect()"
```

## Layout
- `backend/src/{app.js,server.js}` — Express app factory + `listRoutes()` route walker
- `backend/src/modules/<domain>/*.{routes,service,controller,validation}.js` — 30 modules
- `backend/src/workers/{recognition,redaction,purge,retention,itemAction}.worker.js` — BullMQ
- `backend/src/lib/` — storage, blobCrypto, embeddingCrypto, keyring, zip, auditLog, accessLog,
  faceGallery, voiceGallery, tokens, otp, consent, revocation, cleanup, signingKey
- `backend/src/middleware/` — requireAdminAuth, requireSubjectAuth, requireRole,
  requireAnyPrincipal, requireBreakGlass, rateLimiter, logAccess, errorHandler
- `backend/prisma/schema.prisma` — 1638 lines, ~50 models
- `backend/tests/{unit,integration,security,e2e}/` — 15 files, baseline **123 pass / 0 fail**,
  full run ~19 min. Run in background only.
- `admin-portal/src/pages/{collectionAgent,dataOwner,dataAdmin,dpo}/` — 63 files
- `user-portal/src/pages/` — 36 files
- `ai-core/{image-pii-worker,audio-worker,text-services,video-worker,prism-visual-pipeline}/`
- `docs/` — 01_PRIVACY_DATAFLOW, 02_ROLE_PERMISSION_MATRIX, DPIA, DEPLOY, RUNBOOK_BREACH,
  and a chain of HANDOFF_*.md. `docs/HANDOFF_2026-08-17_phase3-dead-code.md` is the current
  entry point (Phases 0–2 of a prior production-readiness plan done; Phases 3–5 never started).

## The user's explicit production requirements
1. Full flow works: upload → processing → finished data → data at rest → discovery → **project-wide download/export**.
2. **~5,000 images/day** sustained without becoming slow or unstable.
3. **Every photo in a project-wide download must carry persistent embedded metadata naming
   its project and its associated person, surviving a filename change.**
4. Clean, modern, responsive UI across desktop/tablet/mobile; real loading/error/empty states.
5. No data loss, corruption or mis-association anywhere in the pipeline.
6. Auth/authz/RLS/API validation/file handling/access control all sound.
7. Refresh, failure, retry, duplicate upload, interrupted processing must not break the workflow.

## Findings already established by the lead (do not re-derive; DO deepen)
- **No EXIF/XMP/IPTC metadata is written anywhere in the codebase.** A repo-wide grep for
  `exif|xmp|iptc|withMetadata` over `backend/src` returns exactly ONE hit, and it is a comment.
- `session.service.js:addPhoto()` does `sharp(buf).rotate().jpeg({quality:92})` with no
  `.withMetadata()` — sharp strips EXIF/ICC/XMP by default, so ingest actively destroys any
  metadata the camera wrote and adds none.
- **There is no project-wide export/download route at all.** `project.routes.js` has
  `/:projectId/report` and nothing that returns media. The only packaging path is the
  per-subject DSAR access package in `dsar/export.service.js` + `lib/zip.js`.
- `lib/zip.js` is a hand-rolled, fully in-memory ZIP writer: `Buffer.concat` of every entry,
  **no ZIP64** (hard 4 GiB / 65535-entry ceiling), no streaming.

## Rules for your report
- **Verify before you claim.** Prefer a live curl / DB query / actual file read over inference.
  Say explicitly whether each finding was *observed* or *inferred from code*.
- Do NOT write or edit any application file. This session is audit-only. Writing scratch files
  under SCRATCH is fine.
- Do NOT restart, kill or reconfigure the running services, and do not run `npm test`
  (19 minutes) unless your task says to.
- Cite `path/to/file.js:LINE` for everything.
- Severity: P0 = blocks production / data loss / security hole; P1 = must fix before launch;
  P2 = should fix; P3 = polish.
- No praise, no summary padding. Findings only.
