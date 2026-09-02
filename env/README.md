# Environment configuration

Everything PRISM needs to run, in one place, so a reviewer can go from a fresh
clone to a working system without hunting for variables.

There are four `.env` files across the project. Templates for all four live in
this folder:

| Template | Copy to | What it configures |
|---|---|---|
| `backend.env.example` | `backend/.env` | API, database, queues, crypto, AI service URLs |
| `admin-portal.env.example` | `admin-portal/.env` | Where the admin portal finds the API |
| `user-portal.env.example` | `user-portal/.env` | Where the data-principal portal finds the API |
| `audio-worker.env.example` | `ai-core/audio-worker/.env` | Whisper size, pyannote token |

## The fast way

From the repository root:

```bash
node scripts/setup-env.mjs
```

That writes all four files with every non-secret value already correct for a
local run, and **mints fresh cryptographic secrets for this machine**. It never
overwrites an existing `.env` unless you pass `--force`.

Then fill in the one value it cannot generate — see *What you must supply*
below.

## Why the real `.env` files are not in this repository

They contain live key material, and two of those keys are not ordinary
passwords:

- **`MEDIA_KEK`** is the key-encrypting-key for the sealed media store. Anyone
  holding it can decrypt every photo, recording and face embedding the platform
  has ever stored. That is the biometric data of real people.
- **`DSAR_SIGNING_SEED`** signs deletion certificates and the Ed25519 provenance
  stamps embedded in exported images. Anyone holding it can forge a certificate
  claiming data was erased when it was not, and forge the stamp that proves
  where a photograph came from. The integrity claim this whole platform rests on
  is exactly this key staying secret.

There is also precedent in this repository for why shipped secrets are not a
theoretical problem. `backend/tests/security/secrets-and-tokens.test.js` records
a finding where a **dev default** `JWT_ADMIN_SECRET` that had been left in place
was used to mint a forged `super_admin` token, which the live server accepted
and which then created an administrator through a super-admin-only route. Every
secret below is generated per-machine for that reason.

Git history is permanent. A secret committed once is compromised even if a later
commit removes it.

## What the generator produces for you

Fresh, cryptographically random, unique to your machine:

| Variable | Purpose |
|---|---|
| `MEDIA_KEK` | Seals the media store |
| `DSAR_SIGNING_SEED` | Signs deletion certificates and export stamps |
| `JWT_ADMIN_SECRET` | Admin session tokens |
| `JWT_SUBJECT_SECRET` | Data-principal session tokens |
| `AUDIT_HMAC_SECRET` | Audit-chain tamper evidence |
| `FACE_EMBEDDING_KEY` | Encrypts stored face embeddings |

## What you must supply

**`HF_TOKEN`** in `ai-core/audio-worker/.env` — required only if you want the
audio pipeline (diarisation and speaker identification). It cannot be shared:
pyannote's models are licence-gated per Hugging Face account, so a borrowed
token would not work for you anyway.

1. Create a free account at <https://huggingface.co>
2. Accept the terms on **both** models:
   - <https://huggingface.co/pyannote/speaker-diarization-3.1>
   - <https://huggingface.co/pyannote/segmentation-3.0>
3. Create a read token at <https://huggingface.co/settings/tokens>
4. Put it in `ai-core/audio-worker/.env` as `HF_TOKEN=hf_...`

Without it, image, video and text still work end to end; only audio is
unavailable.

**Email is not required.** `EXPOSE_DEV_OTP="on"` returns the one-time code in
the API response and shows it on screen, so you can sign in as a data principal
with no mail provider configured. Leave `RESEND_API_KEY` and the `SMTP_*`
values as they are unless you specifically want to test real delivery.

## Notes on specific values

- **`DATABASE_URL`** points at the local Postgres in
  `backend/docker-compose.yml` (profile `localdb`, host port **5434**). The
  credentials there are local-only and deliberately not secret. Start it with
  `docker compose --profile localdb up -d` from `backend/`.
- **`MEDIA_REQUIRE_SEALED=on`** makes the API refuse to read any media object
  that is not encrypted. Leave it on; turning it off is what lets unencrypted
  blobs go unnoticed.
- **`EXPOSE_DEV_OTP="on"`** is a development convenience and must be `off`
  anywhere real. `backend/scripts/preflight.js` is the go-live gate that checks
  this and the secret strength.
- **The face thresholds** are tuned values, not defaults. Changing them changes
  who gets matched to whom.

## Verifying your setup

```bash
node backend/scripts/preflight.js
```

It checks that every required variable is present, that the secrets are strong
enough, and that the services it depends on are reachable.
