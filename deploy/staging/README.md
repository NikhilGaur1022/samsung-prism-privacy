# PRISM on one machine, reachable from anywhere

The whole stack — Postgres, Redis, Qdrant, the API, all seven workers, all five
AI workers, both portals — in one `docker compose` file, published at an HTTPS
URL any device can open. Nothing is installed on the host but Docker.

```bash
./init.sh          # once: generates .env and app.env with fresh secrets
./up.sh            # build (first run only), migrate, start, print both URLs
./bootstrap-admin.sh you@example.com          # an operator account
./seed-subject.sh  someone@example.com        # a data-principal account
```

`./up.sh` prints both URLs at the end. `./url.sh` prints them again later.

There are **two** public URLs, one per audience — operators and data
principals never share a link.

| | | |
|---|---|---|
| **User portal** | `<user-url>/` | what a data principal opens |
| **Admin console** | `<admin-url>/admin` | what an operator opens |
| API | served under *both*, at `/api/v1`, `/auth`, `/health` | |
| LAN, no TLS | `http://<lan-ip>:8081` (user) · `:8080` (admin) | |
| Postgres | `127.0.0.1:5434` (owner role `postgres`, db `prism`) | |

`<admin-url>/` also still serves the user portal, so a link minted before the
split keeps working. `<user-url>/admin` does **not** serve the console.

---

## The two decisions worth knowing about

### Two origins, each of them internally single-origin

The API sets its session cookies with `sameSite: 'strict'`
(`backend/src/lib/cookies.js`). That works in `deploy/compose.prod.yml` because
`prism.example.com` and `api.prism.example.com` share a registrable domain, so
the cookies are same-site.

It does not survive being split across tunnel hostnames.
`trycloudflare.com` is on the Public Suffix List, so two `*.trycloudflare.com`
names are *cross*-site to each other, and the browser would simply stop sending
the session cookie — both portals would appear to log you out on every request,
with nothing in any log to say why.

What *is* safe is giving each **audience** its own origin that carries its own
copy of the API underneath it. A cookie minted on the user origin is sent back
to the user origin on every request that portal makes, because those requests
are same-origin. Nothing ever needs to cross between the two: an admin session
and a subject session are separate sessions with separate cookie names
(`prism_admin_*` / `prism_subject_*`), and neither portal calls the other's
host. The split is per-audience, never portal-versus-API.

So `Caddyfile` declares two sites, each routing by path, and both mounting the
API at the exact prefixes `app.js` uses:

```
:8080  admin origin    /api/*, /auth/*, /health  ->  backend:4000
                       /admin/*                  ->  the admin SPA (base=/admin/)
                       everything else           ->  the user SPA

:8081  user origin     /api/*, /auth/*, /health  ->  backend:4000
                       everything else           ->  the user SPA
                       (no /admin route at all)
```

One `cloudflared` container per site — a quick tunnel takes exactly one origin.

Leaving `/admin` off the user origin is a routing decision, not a security
boundary: the console is inert without an admin session cookie, and only the
other origin can mint one. It keeps the console off the link that goes out to
data principals, which is worth having on its own.

Nothing is rewritten on the way through. That is deliberate: the refresh
cookies are scoped to `Path=/auth/subject/refresh` and `Path=/auth/admin/refresh`,
and stripping a prefix here would set a cookie path the browser never matches
again — silent session refresh would fail as random logouts fifteen minutes
into a session.

One consequence worth the trade: the portals are built with an empty
`VITE_API_BASE_URL`, so they issue same-origin relative requests — which is
also what lets one user-portal build serve on both origins, each talking to the
host it was loaded from. **Either tunnel URL can change without rebuilding a
single asset.** Only the backend's own env carries the public URLs, and only
for the links it emails (`ADMIN_APP_BASE_URL`) and encodes into join QRs
(`USER_PORTAL_URL`).

### `NODE_ENV=development`, with the reason on the record

`config/env.js` treats `staging` and `production` alike as *hardened*, and a
hardened environment never echoes an OTP code to the client (`lib/otp.js`). With
no SMTP credentials configured, that means nobody can log into the user portal
at all. So this stack runs `development` with `EXPOSE_DEV_OTP=on` and the code
comes back in the API response.

What that costs:

- session cookies are not marked `Secure` (they still work over the tunnel's
  HTTPS — `Secure` restricts, it does not enable);
- `preflight` failures print RED but exit 0.

What it does **not** cost: media encryption at rest. That is keyed off
`MEDIA_KEK` being present, not off `NODE_ENV`, and `init.sh` generates one. New
writes are sealed from the first boot.

To go hardened later, in `compose.yml`'s `x-backend-env`: set
`NODE_ENV: production`, drop `EXPOSE_DEV_OTP`, and fill `SMTP_*` in `app.env`.
`DATABASE_URL` already carries `sslmode=require` and Postgres already serves
TLS, so preflight check #7 passes as-is. Read `docs/DEPLOY.md` §4 before
setting `MEDIA_REQUIRE_SEALED`.

---

## No GPU is used, or needed

Four of the five AI workers build from `python:*-slim` and have no CUDA path at
all. `video-worker`'s Dockerfile is CPU by default by design and probes
`onnxruntime.get_available_providers()` at runtime. `audio-worker` is the only
one whose Dockerfile had a CUDA base; its loaders already do
`"cuda" if torch.cuda.is_available() else "cpu"`, so this stack builds it with
`--build-arg BASE=python:3.12-slim` (wired into `compose.yml`) rather than
pulling several GB of driver stack nothing here can call.

The cost is speed, in one place: audio diarization and transcription. Drop
`WHISPER_MODEL_SIZE` in `.env` to `base` or `tiny` if that matters.

---

## What is running

| Service | Notes |
|---|---|
| `web` | Caddy plus both SPAs, built from source in the image |
| `tunnel` | `cloudflared` quick tunnel — the public URL |
| `postgres` | 16, TLS on with a self-signed cert from the `pg-certs` one-shot |
| `redis` | 7.4 — BullMQ's floor is 6.2 and preflight #15 enforces it |
| `qdrant` | v1.12.4, face and voice galleries |
| `backend` | the API |
| `worker-recognition` | sessions stay `PROCESSING` forever without it |
| `worker-redaction` | drains `piiStatus=DEFERRED` photos; nothing else retries them |
| `worker-purge` | DSAR erasures and their deletion certificates |
| `worker-retention` | the only thing that deletes an L2 original on a timer |
| `worker-item-action` | DSAR item-level actions |
| `worker-export` | project export packages |
| `worker-reaper` | orphaned blobs |
| `face-worker` | insightface `buffalo_l`, ~300MB fetched once into a volume |
| `image-pii-worker` | **not optional** — redaction fails closed without it |
| `text-worker` | document/text PII |
| `video-worker` | shares `face_models` with `face-worker` on purpose: a track embedded with a different model produces confident nonsense against the gallery |
| `audio-worker` | diarization, transcription, voice embeddings |

`deploy/compose.prod.yml` declares only four of the seven Node workers.
`item-action`, `export` and `reaper` exist in `backend/src/workers/` and are
started by the repo's own `npm run dev`, so they are here too.

### `HF_TOKEN` — set, and diarization is live

`audio-worker` needs a Hugging Face read token for the gated
`pyannote/speaker-diarization-3.1` checkpoint. It is set in `.env`, the licence
on that account is accepted, and `/analyze` has been confirmed loading the
pipeline and returning 200 end to end. The ~580MB of weights live in the
`audio_models` volume (`/root/.cache/huggingface`), so they survive a restart
and are fetched once.

Without a token the container still starts and `/embed` and `/redact` work —
only `/analyze` raises `HF_TOKEN is not set`. To replace the token: accept the
licence at <https://huggingface.co/pyannote/speaker-diarization-3.1>, edit
`HF_TOKEN` in `.env`, and `docker compose up -d --force-recreate audio-worker`.

Note the interpreter: this image is `uv`-managed, so its dependencies live in
`/app/.venv` and the system `python` has none of them. Anything run by hand in
this container needs `uv run python`, not `python`.

---

## Test accounts

Two audiences, two ways in, neither of which needs a working mailbox on this
stack.

**An operator.** `./bootstrap-admin.sh you@example.com` mints one `super_admin`
in `INVITED` state and prints an accept-invite link on the admin origin. It
refuses to mint a second link once an admin row exists, so keep the token it
gives you — if you lose it, `docker compose exec backend node prisma/seed-admin.js`
is the same script, and the token lives in `auth_tokens` with
`purpose='ADMIN_INVITE'`.

For the other four roles at once there is `backend/scripts/dev-seed-admins.js`,
which mints one ACTIVE admin per role with a shared known password
(`DEV_ADMIN_PASSWORD`, default `Prism@2026!`) and no invite flow at all:

```bash
docker compose run --rm --no-deps backend node scripts/dev-seed-admins.js
```

It is a deliberate bypass of the invite audit trail — those accounts have no
inviter and nobody proved mailbox control for them — and it refuses to run under
`NODE_ENV=production`. Fine here, never on a real deployment.

**A data principal.** `./seed-subject.sh someone@example.com ["Name"] [GROUP]`.
This is not a back door: it drives the same public `/auth/subject/register`
endpoint the portal's own signup page uses, then prints the OTP. Groups are
`SAMSUNG_EMPLOYEE`, `EX_SAMSUNG_EMPLOYEE`, `SEED_LAB_EMPLOYEE`,
`EX_SEED_LAB_EMPLOYEE`, `VOLUNTEER` (the default).

The code is readable at all only because this stack is non-hardened with
`EXPOSE_DEV_OTP=on` — the portal shows it on its own verify screen too, so on a
phone you can type the email and read the code off the page. Under
`NODE_ENV=production` none of that happens and OTP delivery needs real `SMTP_*`.

---

## Session types

Four capture modalities, chosen when the session is created:

| Type | Code | Collects | Workspace |
|---|---|---|---|
| Image | `COL-` | photos (and clips) | session page |
| **Video** | `VID-` | clips only | session page |
| Audio | `AUD-` | recordings | `/sessions/:id/audio` |
| Text | `TXT-` | documents | `/sessions/:id/text` |

`VIDEO` exists so a session can collect clips and nothing else. Before it, video
had no type of its own: clips hung off `IMAGE`, and because the end-of-session
button was gated on `session.photos.length > 0`, a session holding only video
could never be ended from the UI — so the recognition pass was never enqueued and
every clip sat at `PENDING_ANALYSIS` looking like a dead pipeline. The button now
enables on photos **or** clips.

An `IMAGE` session may still hold clips alongside stills, deliberately: that is
how video worked before `VIDEO` existed and those sessions are still out there,
which is why `itemCountFor()` counts photos + videos for `IMAGE` rather than
moving clips under the new member.

**Analysis is triggered by ending the session**, for every type. A freshly
uploaded clip sitting at `PENDING_ANALYSIS` is not stuck — nothing has been asked
to run yet. `endSession` needs at least one participant on the roster and at
least one captured item, or it 409s.

Measured on this machine: an 8.7s 1280×720 clip took **~75 seconds** end to end
(upload → `ANALYZED`, 11 face tracks). CPU-only; a GPU would cut that severalfold.

---

## Video: clips must be silent

`POST /api/v1/sessions/:id/videos` refuses any clip carrying an audio track with
a 422. That is deliberate, not a fault: no voice-consent decision is attached to
a video, so a soundtrack in one cannot lawfully be processed or served. Every
phone recording hits it.

The supported way through is to mute the file:

```bash
./mute-video.sh clip.mp4          # writes clip.muted.mp4 beside it
```

ffmpeg runs inside the `video-worker` container (this host has none) and the
video bitstream is copied rather than re-encoded, so there is no quality loss.

`VIDEO_ALLOW_AUDIO=true` in `x-backend-env` switches the check off. It exists for
deployments where a voice-consent decision *is* attached to clips. Setting it
here would disable a consent control the service treats as a legal requirement,
so leave it alone unless that has genuinely changed.

Two notes on reading the pipeline's state:

- A freshly uploaded clip sits at `PENDING_ANALYSIS`, and that is correct — video
  analysis runs inside the recognition pass, which `endSession` enqueues. It is
  not stuck.
- `endSession` needs at least one participant on the roster and at least one
  photo or clip, or it 409s.

---

## What is still open to configure

Everything below is optional for testing — the stack is fully working without
any of it. This is the list of what you would touch, and what each one unlocks.

### `.env` — compose interpolation only

| Key | State | What it gates |
|---|---|---|
| `PUBLIC_URL`, `USER_URL` | managed by `./up.sh` | Only edit by hand for a fixed hostname (§ A stable URL). |
| `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | generated by `./init.sh` | Nothing to do. |
| `HF_TOKEN` | **set** | Audio `/analyze` (speaker diarization). Verified loading the gated `pyannote/speaker-diarization-3.1` pipeline; weights cached in the `audio_models` volume. |
| `WHISPER_MODEL_SIZE` | `small` | Transcription accuracy vs. CPU time. There is no GPU here, so `medium`/`large-v3` get slow fast. |

### `app.env` — the backend's own environment

Secrets are already generated. **`MEDIA_KEK` is not recoverable** — lose it and
every sealed media blob is permanently unreadable.

| Key | State | What it gates |
|---|---|---|
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | **empty** (port `587`, a `prism.local` from-address) | Real email: OTPs, admin invites, DSAR notifications. Not needed while `EXPOSE_DEV_OTP=on`; **required** before `NODE_ENV=production`, or nobody can log in at all. |
| `MEDIA_REQUIRE_SEALED` | **empty** | Refuse to serve any media blob that is not encrypted. Turn it on **only after** `docker compose run --rm --no-deps backend node scripts/migrate-media-encrypt.js` reports zero missing and zero failed — otherwise pre-existing plaintext blobs become unreadable. |
| `FACE_*`, `VOICE_*` thresholds | defaults | Match/auto-tag sensitivity, blur strength, enrollment limits. Tune against your own test media, not in the abstract. |
| `DSAR_*`, `SESSION_INVITE_TTL_MINUTES` | defaults | SLA clocks and how long a join QR stays valid. Shorten `SESSION_INVITE_TTL_MINUTES` if you want to watch expiry behaviour without waiting. |

### `compose.yml` — `x-backend-env`

These are set here rather than in `app.env` so a stale value copied out of a dev
`.env` cannot override them.

| Key | Current | Change it when |
|---|---|---|
| `NODE_ENV` | `development` | Going hardened. Requires real `SMTP_*` **and** removing `EXPOSE_DEV_OTP` first. |
| `EXPOSE_DEV_OTP` | `on` | Must be gone before hardening — preflight FAILs on it, and with it on, any account is takeable with nothing but an email address. |
| `AUDIO_CAPTURE_ENABLED`, `VIDEO_CAPTURE_ENABLED` | `on` | Turn one off to have the API answer `503` on that modality — the portals read that as "not offered here" rather than as a failure. |
| `TRUST_PROXY_HOPS` | `2` | Only if you change the proxy chain (currently cloudflared → caddy). An exact count, never `true`: Express would otherwise trust the whole `X-Forwarded-For` chain, letting a client forge the IP written into the access ledger. |

### Not configuration, but worth knowing

`preflight.sh` reports one WARN (`EXPOSE_DEV_OTP`) and zero FAILs in this
shape — that WARN is the intended state here and the thing to fix on the way to
production.

The retention worker logs `permission denied for table access_events` as a WARN
with `refused: true` and completes its sweep anyway. That is the least-privilege
role working as designed, not a misconfiguration; giving the sweep its own
exempt role is upstream work, not a setting.

---

## A stable URL

A quick tunnel needs no Cloudflare account, which is why it is the default — and
the price is that the hostname changes every time a `tunnel` container restarts.
`./up.sh` handles the rotation automatically for both (it rewrites `PUBLIC_URL`
and `USER_URL` and recreates only the backend containers; no asset is rebuilt),
and it asserts afterwards that the values actually reached the container rather
than trusting that they did.

One thing the rotation does not fix, because it cannot: an accept-invite link
or a session-join QR handed out under the old hostname points at a tunnel that
no longer exists. The *token* is still valid — swap the host in the URL for the
new one and it works. `./bootstrap-admin.sh` refuses to mint a second link once
an admin row exists, so keep the token rather than re-running it.

For hostnames that survive a restart, replace each tunnel service's command
with a named tunnel — this needs a Cloudflare account and a domain:

```yaml
  tunnel:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run --token ${CF_TUNNEL_TOKEN_ADMIN}
  tunnel-user:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run --token ${CF_TUNNEL_TOKEN_USER}
```

Point one tunnel's public hostname at `http://web:8080` and the other's at
`http://web:8081` in the Cloudflare dashboard, put both tokens and the fixed
`PUBLIC_URL` / `USER_URL` in `.env`, and delete the URL-detection block at the
bottom of `up.sh`. Two ngrok static domains work the same way.

With real hostnames you can also drop back to one tunnel if you want: two
subdomains of a domain you own (`admin.example.com`, `portal.example.com`) are
same-site, unlike two `*.trycloudflare.com` names, so the cookie constraint that
forces this shape disappears.

---

## Operating it

```bash
./preflight.sh                       # the 15-check go-live gate, docs/DEPLOY.md §2
./url.sh                             # both current public URLs
./seed-subject.sh you@example.com    # a test data-principal account + its OTP
./mute-video.sh clip.mp4             # strip audio so a clip can be uploaded
./down.sh                            # stop; volumes survive
docker compose logs -f backend
docker compose ps
```

Health: `/health` is liveness; `/health/deep` reports Postgres and
Qdrant — both are served under either URL. Neither checks Redis or the Python
workers, so a green `/health/deep` is not a full readiness proof — `docker
compose ps` is.

**A portal renders as a blank page after a rebuild.** That browser is holding a
cached `index.html` that points at asset filenames the new build no longer has.
`Caddyfile` now sends `Cache-Control: no-cache` on the entry points (and
`immutable` on the content-hashed assets), so this cannot recur — but a browser
that cached the old copy *before* that fix has to be forced past it once with a
hard reload (Ctrl-Shift-R, Cmd-Shift-R on macOS). Telltale: the HTML loads fine
with curl and the page is an empty `<div id="root">`.

**`docker compose down -v` destroys the database, the media tree, the galleries
and the downloaded weights.** It is not reversible, and `MEDIA_KEK` in
`app.env` cannot decrypt blobs that no longer exist.
