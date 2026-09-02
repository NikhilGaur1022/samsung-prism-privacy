# 26TS12VITV_Privacy-First_AI_Consent_and_Redaction_platform_for_Multimodal_AI_Data

SRIB-PRISM Program

PRISM is a DPDP-compliance platform for collecting multimodal AI training data
with consent, and for proving what happened to it afterwards. It captures
images, video, audio and text; recognises who is in each capture; redacts
everyone who did not consent; exports a signed, traceable dataset; and can erase
a person on request and certify that it did.

## Running it

### 1. Configure the environment

**Start here.** Templates for all four `.env` files live in [`env/`](env/), and
one command writes them with fresh per-machine secrets:

```bash
node scripts/setup-env.mjs
```

Every non-secret value is already correct for a local run. The script mints the
six cryptographic secrets itself, because two of them are not ordinary
passwords: `MEDIA_KEK` decrypts every stored photo, recording and face
embedding, and `DSAR_SIGNING_SEED` signs the deletion certificates and the
provenance stamps embedded in exported images. Those are never committed, and
[`env/README.md`](env/README.md) explains what each variable does and which
single value you have to supply yourself.

Short version of that one value: **audio needs a Hugging Face token**
(`HF_TOKEN`), because pyannote's models are licence-gated per account and a
borrowed token would not work for you. Image, video and text run without it.
**Email needs nothing** — `EXPOSE_DEV_OTP` returns the sign-in code on screen.

### 2. Bring up infrastructure and the AI workers

```bash
cd backend
docker compose --profile localdb up -d      # Postgres, Redis, Qdrant
npx prisma migrate deploy
```

Five Python services do the analysis: face `:8001`, image-PII `:8002`, audio
`:8003`, text `:8004`, video `:8005`. The audio worker loads four models and is
the slow one — wait for `http://127.0.0.1:8003/ready` to report `ready` before
running an audio session.

### 3. Seed and start

```bash
node backend/scripts/dev-seed-admins.js     # five accounts, one per role
npm run dev                                 # API, 7 queue workers, both portals
node backend/scripts/demo-seed.js           # a full worked project, all 4 pipelines
```

Admin portal `http://localhost:5180`, data-principal portal
`http://localhost:5173`. Use `localhost`, not `127.0.0.1` — the Vite dev servers
bind IPv6 only.

Seeded logins share the password `Prism@2026!`: `dpo@`, `dataowner@`, `agent@`
and `dataadmin@prism.local`.

> The stack is all-or-nothing. `npm run dev` runs under `concurrently -k`, so
> killing one worker tears down everything. To pick up a code change, restart
> the whole thing — Docker and the AI workers are unaffected, so it takes about
> twenty seconds.

## Verifying it works

None of these assert; they all check.

| Command | What it proves |
|---|---|
| `node backend/scripts/preflight.js` | Configuration is complete and the secrets are strong |
| `npm test` (in `backend/`) | 215 backend tests |
| `node admin-portal/scripts/check-ui-health.mjs` | Every admin route, as every role, free of exceptions and failed requests |
| `node user-portal/scripts/check-ui-health.mjs` | The same for the data-principal portal |
| `node user-portal/scripts/check-signup-flow.mjs` | Registration driven by real typing and clicking |
| `node admin-portal/scripts/check-capture-flow.mjs` | Capture to export by clicking: 12 files through the real file input, then the export downloaded |
| `node backend/scripts/verify-export.js <projectId> <exportId>` | Opens the archive; checks hashes, provenance and Ed25519 stamps |
| `node backend/scripts/verify-dsar.js <email>` | Drives an erasure to CLOSED and confirms absence from the principal's own session |
| `node backend/scripts/inspect-photo-provenance.js <projectId> <exportId>` | What a single exported photo still proves about its origin |

The UI checks need headless Chrome on `:9222`:

```bash
chrome --headless=new --remote-debugging-port=9222
```

## What it does

**Consent first.** A data principal registers, is shown the notice, and grants
consent per project and separately for biometric processing. Only consented
people can be added to a capture session — the roster search shows everyone but
offers an **Add** button on nobody else.

**Four capture pipelines.** Images (bulk upload, face recognition, clustering,
tagging, redaction), video (per-track recognition), audio (diarisation,
transcription, speaker identification against enrolled voices, PII muting) and
text (entity detection tuned for Indian identifiers — Aadhaar, PAN, phone
numbers).

**Redaction is the default.** Faces nobody claimed and printed PII are masked
server-side before an image leaves the API. The unredacted original is reachable
only by the collecting agent before archive, and by a DSAR operator through an
audited break-glass path.

**Exports are traceable.** Each archive carries redacted derivatives only, a
manifest naming each file's capture session and the pseudonymous people in it,
and an Ed25519 signature. Images additionally carry that stamp embedded in EXIF
and XMP, so a photograph found on its own still identifies its project, session,
consent record and subjects — as export-scoped pseudonyms, never names. The
pseudonym-to-name mapping is one access-controlled file inside the archive.

**Erasure is provable.** A DSAR request runs discovery, executes, and issues a
signed certificate enumerating every location purged, including the derived
caches. The principal's own portal is the check: what it says the platform holds
must match what the platform actually holds.

## Layout

```
backend/        Express API, Prisma schema, 7 BullMQ workers, tests
admin-portal/   React portal for DPO, data owner, collection agent, data admin
user-portal/    React portal for data principals
ai-core/        Five FastAPI services: face, image-PII, audio, text, video
env/            Environment templates and the setup guide
docs/           Role-permission matrix, audit notes, key custody
```

`docs/02_ROLE_PERMISSION_MATRIX.md` is the authority on who may reach what, and
it is enforced by a test that fails if a route is mounted without being
classified in it.
