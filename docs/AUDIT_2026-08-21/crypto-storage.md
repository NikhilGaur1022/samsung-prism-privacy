# Crypto / storage / key-management audit — encryption at rest, keyring, crypto-shred

Domain: `backend/src/lib/{storage,blobCrypto,embeddingCrypto,keyring,signingKey}.js`, `SubjectKey`,
`MEDIA_KEK`/`FACE_EMBEDDING_KEY`/`DSAR_SIGNING_SEED`/`AUDIT_HMAC_SECRET`, `scripts/migrate-media-encrypt.js`.

All evidence below is against the LIVE stack (`backend/storage/media`, Postgres on 5433, Qdrant on
6333, API on 4000) unless marked INFERRED. Every probe script is in
`scratchpad/{decrypt-probe,orphan-crops,orphan-crops-split,orphan-sessions,orphan-enrollments}.mjs`
— read-only: they open Prisma/fs in read mode and decrypt into memory, they write nothing back to
the repo or the DB. One throwaway file was briefly created inside `backend/` by mistake
(`backend/_audit_decrypt.mjs`) and was deleted in the same turn before any other tool call — `git
status` at the end of this audit shows no diff attributable to this session.

---

## FINDING C-1 (P0) — KEK rotation is broken for path- and project-scoped blobs, i.e. for nearly the entire media store. `MEDIA_KEK_PREVIOUS` does not do what its own comment says.

**Claim in the code**, `backend/src/lib/keyring.js:81-83`:
> "Rotation: the previous KEK stays readable so old blobs open while new writes use the new one.
> Blobs carry keyId, so re-encryption can be lazy-on-read instead of a flag-day rewrite of the whole
> store."

**This is true only for `subject` scope and `export` scope. It is false for `project` scope and
`path` scope — and `path` scope is what protects every session photo, every face crop, every
redacted derivative, every recording, every video, every text document, and (see C-2) every
enrollment selfie and voice clip.**

Read the actual key-resolution code, `backend/src/lib/keyring.js:139-168`:

```js
export function deriveProjectKey(projectId, { version } = {}) {
  const v = version ?? currentKekVersion()          // <-- no fallback to previous
  const kek = kekForVersion(v)
  ...
}
export function derivePathKey(scopeId, { version } = {}) {
  const v = version ?? currentKekVersion()          // <-- no fallback to previous
  const kek = kekForVersion(v)
  ...
}
```

And the caller, `backend/src/lib/storage.js:70-87` (`keyFor`, used by both `writeFile` and
`readFile`):

```js
async function keyFor(relativePath, options) {
  const { scope, scopeId, wrapped } = options?.scope ? options : scopeForPath(relativePath)
  switch (scope) {
    case 'project': return deriveProjectKey(scopeId)   // no version passed
    case 'subject': return getSubjectKey(scopeId)       // reads row.kekVersion from DB
    case 'export':  return wrapped ? openExportKey(wrapped) : createExportKey()  // version byte in wrapped blob
    case 'path':
    default: return derivePathKey(scopeId)               // no version passed
  }
}
```

`readFile` calls `keyFor` with **no version hint at all** — it never inspects the blob's own header
(`readHeader(buffer).version`/`keyId`) to decide which KEK to try. It always derives with
`currentKekVersion()`. Only two scopes carry version awareness:

- `subject` — `SubjectKey.kekVersion` is a real DB column, read back and passed to `kekForVersion`
  (`keyring.js:199`). Rotation-safe.
- `export` — the wrapped-DEK blob's first byte **is** the KEK version (`keyring.js:249,264`).
  Rotation-safe.
- `project` and `path` — **no persisted version anywhere.** The scope string alone is all that is
  ever passed. Not rotation-safe.

**Consequence, proved by tracing `openBlob`**: if an operator ever does what `preflight.js`,
`DEPLOY.md` and the code comments all describe as the supported rotation procedure — bump
`MEDIA_KEK_VERSION`, set the new `MEDIA_KEK`, move the old value into `MEDIA_KEK_PREVIOUS` — then
on the very next read of any `sessions/...`, `enrollments/...`, `voice-enrollments/...`, or any
other path-scoped object, `keyFor` derives a key under the **new** KEK version, `openBlob` compares
its computed `keyId` against the blob's stored header `keyId` (`blobCrypto.js:112-117`), they will
not match (`keyId` is an HMAC over `(version, info, salt)` keyed by the KEK — different KEK bytes,
different keyId even for the same salt), and it throws `BlobKeyMismatchError` **before even trying
to decrypt**. There is no retry against `MEDIA_KEK_PREVIOUS` anywhere in this call path. Every
photo, crop, redacted derivative, recording, video, text document, and (per C-2) every enrollment
image and voice clip in the deployment becomes permanently unreadable through the ordinary read
path the moment a KEK rotation is performed as documented.

`MEDIA_KEK_PREVIOUS` therefore only actually helps the small slice of data that flows through
`subject` scope (biometric embeddings, and imported-photo originals — see C-3) and `export` scope
(DSAR packages). The doc comment's "old blobs open while new writes use the new one" claim is
correct for those two scopes and **false** for the two scopes that hold the overwhelming majority
of stored bytes.

**Evidence type:** INFERRED from code (very high confidence — this is a straightforward trace of
`keyFor` → `derivePathKey`/`deriveProjectKey` → `kekForVersion`, no branch anywhere consults
`MEDIA_KEK_PREVIOUS` for these two scopes). Not exercised live because doing so would require
rotating `MEDIA_KEK` on the running system, which the audit rules forbid (do not reconfigure running
services). The trace is unambiguous: `derivePathKey`/`deriveProjectKey` take an **optional**
`version` parameter that **nothing in `storage.js` ever supplies**, so it always defaults to
`currentKekVersion()`.

**Fix:** on read, for `path`/`project` scope, try `currentKekVersion()` first; on
`BlobKeyMismatchError`, retry with each version in `MEDIA_KEK_PREVIOUS` (today just one, but the
retry should be a loop against a small ordered list so a future multi-hop rotation doesn't need a
second code change). Same pattern the `subject` scope already gets from its DB column — persist the
version that sealed a `path`/`project`-scope blob somewhere retrievable without decryifering it
first, e.g. read `readHeader(buffer).keyId` and reverse-map keyId→version by trying each known KEK
version's `computeKeyId` until one matches, which is cheap (HMAC, not AES) and requires no schema
change.

---

## FINDING C-2 (P0) — Raw enrollment selfies and raw voice-enrollment clips are NOT sealed under the per-subject DEK. They share ONE global, never-rotating, never-destroyable key each. `destroySubjectKey()` has zero effect on them. Proved by decrypting three different subjects' selfies live.

`backend/src/lib/storage.js:55-68`, `scopeForPath`:

```js
export function scopeForPath(relativePath) {
  const parts = String(relativePath).split(/[\\/]+/).filter(Boolean)
  const [head, second] = parts
  if (head === 'subjects' && second) return { scope: 'subject', scopeId: second }
  if (head === 'vault' && second) return { scope: 'project', scopeId: second }
  if (head === 'exports' || head === 'dsar') throw ...
  if (head === 'sessions' && second) return { scope: 'path', scopeId: `sessions/${second}` }
  return { scope: 'path', scopeId: head ?? 'root' }        // <-- fallback
}
```

`backend/src/modules/enrollment/enrollment.service.js:87`:

```js
const imagePath = `enrollments/${subjectId}/${randomUUID()}.jpg`
await writeFile(imagePath, normalised)                      // no {scope} option
```

`head` is `'enrollments'`, not `'subjects'` — it does not match any explicit branch, so it falls
into the last line: **`{ scope: 'path', scopeId: 'enrollments' }`**. Every subject's raw enrollment
selfie, regardless of who they are, is sealed under `derivePathKey('enrollments')` — one
deterministic key, computed from `HKDF(MEDIA_KEK, salt='enrollments', info='path-v1')`, identical
for every subject and stable for the life of the KEK.

`backend/src/modules/enrollment/voiceEnrollment.service.js:96` does the identical thing for the raw
audio clip:

```js
const audioPath = `voice-enrollments/${subjectId}/${randomUUID()}.wav`
await writeFile(audioPath, file.buffer)                      // no {scope} option
```
→ `{ scope: 'path', scopeId: 'voice-enrollments' }`.

**This directly contradicts the comment sitting six lines below the very `writeFile` call in
question** (`enrollment.service.js:92-97`, and the equivalent in `voiceEnrollment.service.js`):

> "Sealed under the subject's own DEK, not the global key... destroying that DEK is what
> crypto-shreds the biometric on erasure."

That comment is **true of the embedding vector** (`encryptEmbeddingForSubject`, a separate call a
few lines later, correctly subject-keyed — verified below) but **false of the raw selfie image
itself**, which is what the comment is textually attached to. The raw face photo — the actual
biometric artefact a bystander would recognise, more sensitive than the 512-float vector — is the
one that got the shared key.

### Live proof

Decrypted the enrollment selfies of three different subjects (`scratchpad/decrypt-probe.mjs`):

```
subject 29cf94b4-c018-48de-8ad3-980fcb9f1951 -> enrollments/29cf94b4.../8575721f....jpg
  scopeForPath -> {"scope":"path","scopeId":"enrollments"}
  header.keyId = 8a6fc4fd8b70a388   resolveKey().keyId = 8a6fc4fd8b70a388  (match)
  DECRYPT OK — valid JPEG (SOI ffd8)

subject de351590-aea7-457a-a784-2241dcf2fc66 -> enrollments/de351590.../0b25eb58....jpg
  scopeForPath -> {"scope":"path","scopeId":"enrollments"}
  header.keyId = 8a6fc4fd8b70a388   (SAME)
  DECRYPT OK

subject e69d2387-12e9-42c0-933a-bcbbd34dcf90 -> enrollments/e69d2387.../7c00f3cd....jpg
  scopeForPath -> {"scope":"path","scopeId":"enrollments"}
  header.keyId = 8a6fc4fd8b70a388   (SAME)
  DECRYPT OK
```

**`*** ALL SAME KEY? true`** — three unrelated subjects' raw face photos, all opened with the exact
same 32-byte DEK. The one voice-enrollment clip present in the live DB confirms the same pattern:
`voice de351590... sealed=true keyId=a493205c5db01db6 scope={"scope":"path","scopeId":"voice-enrollments"}`.

For contrast, the same probe against a session photo and a face crop shows the design working as
intended elsewhere: `sessions/<sid>/photos/...` → `scopeId:"sessions/<sid>"`, a key that at least
varies per session (not per subject, see C-4, but not shared globally either).

### Why this is a real regression, not an intentional design choice

`backend/scripts/migrate-media-encrypt.js:226-232`, the team's own backfill tool, encodes the
*intended* layout explicitly:

```js
// Selfies live at subjects/<uid>/..., so scopeForPath already resolves the
// per-subject DEK; the override is here for rows whose imagePath predates
// that layout.
const selfie = await sealInPlace(enrollment.imagePath, {
  scope: 'subject',
  scopeId: enrollment.subjectId,
})
```

The migration script believes — and forces, via an explicit override — that enrollment selfies live
under `subjects/<uid>/...`. **They do not; they live under `enrollments/<uid>/...`, live, right
now.** `import.service.js:47-53` shows the team knows how to do this correctly and explains why in
the comment:

```js
// Under `subjects/<uid>/`, which storage.scopeForPath maps to the per-subject
// DEK. That is deliberate and load-bearing: an imported photo must be reachable
// by the same crypto-shred that a captured one is, or an erasure certificate
// would be signed over a subject who still has readable imported media.
return `subjects/${subjectId}/imports/${sha256}.jpg`
```

So three independent pieces of evidence — the migration script's explicit override, the adjacent
code comment in `enrollment.service.js` itself, and the working pattern one module over in
`import.service.js` — all agree on what the path/scope should have been. The live path is
`enrollments/<uid>/...`, not `subjects/<uid>/...`. This is drift between the intended design and
the shipped code, not a deliberate trade-off.

### Compliance consequence

`destroySubjectKey(subjectId)` (`keyring.js:213-228`) sets `SubjectKey.salt = NULL`, which makes
`getSubjectKey(subjectId)` throw `KeyDestroyedError` forever after. **It has no effect whatsoever
on the `enrollments`/`voice-enrollments` path key** — that key is derived straight from
`MEDIA_KEK` + the literal string `'enrollments'`, with no DB row, no salt, no destroy path at all.
Today, actual erasure of these files happens only through `purge.service.js`'s `L4`/`L16` handlers,
which physically `shredFile()` the bytes (overwrite the header, then unlink) — **not** through
crypto-shred. That is why the current live corpus is functionally erasable today (physical deletion
still works). But it means:

- **Crypto-shred provides zero defence-in-depth for the single most identifiable biometric artefact
  in the system** (a bystander recognises a face photo; nobody recognises a 512-float vector). If a
  copy of an enrollment selfie ever escapes the `shredFile()` sweep — a backup snapshot, a replica,
  a bug in discovery that misses an enrollment row (see C-5's session-analogue for how easily rows
  go missing), a partially-executed purge job — `destroySubjectKey()` gives the DPO no way to make
  that copy unreadable. They would have to find and physically shred every copy, forever, which is
  exactly the "we think we got all the copies" problem the `keyring.js` header comment says
  crypto-shred exists to avoid (`keyring.js:20-25`).
- Every enrollment selfie/clip ever written, for every subject, past and future, sits behind one
  key. A compromise of that one derived key (e.g. via the KEK leaking) exposes every subject's
  raw enrolled face/voice at once — there is no per-subject blast-radius containment, which
  per-subject DEKs exist specifically to provide.

**Fix:** change `enrollment.service.js:87` and `voiceEnrollment.service.js:96` to pass an explicit
`{ scope: 'subject', scopeId: subjectId }` to `writeFile` (mirroring `import.service.js`), or
rename the path prefix to `subjects/<uid>/enrollments/...` so `scopeForPath`'s existing `subjects`
branch picks it up without a call-site change. Either way, run `migrate-media-encrypt.js` against
the corpus afterward — but note it currently assumes the `subjects/<uid>/...` layout for enrollment
selfies (matching the fix) while the *voice* enrollment migration path does not exist in the script
at all (`migrateEnrollments()` only handles `subjectFaceEnrollment`; there is no
`migrateVoiceEnrollments()` — grep confirms `subjectVoiceEnrollment` never appears in
`migrate-media-encrypt.js`). The voice-enrollment re-key has no tooling yet.

---

## FINDING C-3 (P0/P1, data-loss risk) — 189 of 200 session directories on disk (94.5%) have no matching `Session` row in Postgres. 901 files, 202.6 MB of sealed biometric media are permanently invisible to discovery, purge and any erasure certificate — and the mechanism that produces this is reachable from ordinary `prisma.session.deleteMany()` calls, which the test suite itself uses as its standard teardown.

This deepens and generalises the brief's specific ask about `recognition.service.js:107`'s
`faceDetection.deleteMany()` orphaning crop files. The orphan-crop mechanism is real (traced below,
C-3a) but the live dataset currently shows **zero** instances of it. What the live dataset actually
shows, at far larger scale, is the same failure at the **session** level, and its cause is
identifiable in the codebase, not just theoretical.

### Live measurement

`scratchpad/orphan-sessions.mjs`:

```
Session rows in DB: 36
Session directories on disk: 200
Orphan session dirs (no matching DB row): 189
Live session dirs (matching DB row): 11
TOTAL orphan session files (photos+crops+redacted+audio+video+text): 901
TOTAL orphan session bytes: 212,443,080  (202.60 MB)
```

Example structure of one orphan directory (`023d39bc-be1c-4d51-998c-4f2508f9628b`, no `Session` row
with this id exists): `['crops', 'photos', 'redacted']` — a full, ordinary session tree, sealed,
sitting on disk, with nothing in Postgres pointing at it.

`scratchpad/orphan-crops-split.mjs` isolates the crop-file subset of this and confirms it is a
**superset** of what the brief specifically flagged:

```
Type A - recognition.service.js re-run orphans (session STILL in DB, crop has no FaceDetection row):
   files=0  bytes=0
Type B - cascade-delete orphans (session row does NOT exist in DB at all):
   files=383  bytes=4,542,160  (4.4 MB)
```

`scratchpad/orphan-enrollments.mjs` shows the identical pattern in two more buckets:

```
enrollments:        onDisk=141  orphans=135  orphanBytes=9,036,001   (9.0 MB)
voice-enrollments:   onDisk=1   orphans=0
dsar (export pkgs):  onDisk=29  orphans=27   orphanBytes=23,011,595  (23.0 MB, see caveat below)
```

### Root cause, identified in code

`Photo.session` is declared `onDelete: Cascade` (`prisma/schema.prisma`, `Photo` model —
`session Session? @relation(fields: [sessionId], references: [id], onDelete: Cascade)`), and
`FaceDetection.photo` cascades from `Photo` the same way. Deleting a `Session` row therefore
silently cascade-deletes every `Photo`/`FaceDetection`/`Recording`/`VideoAsset`/`TextDocument` row
that pointed at it — which is exactly what removes the last trace `discovery.service.js` and
`purge.service.js` need to ever find the corresponding files (both walk *from* live DB rows; see
C-5). **Nothing in the codebase hooks session (or its children's) row-deletion to a storage sweep.**
`storage.js` has no lifecycle awareness of Prisma deletes at all — it is a pure read/write/shred
API, called explicitly, never triggered by a DB event.

And this is not a hypothetical: it is the test suite's own idiom, used in **eight** files:

```
tests/e2e/world.js:311:                        await prisma.session.deleteMany({ where: { projectId: world.project.id } })
tests/integration/dsar-audio-erasure.test.js:199:      await prisma.session.deleteMany({ where: { id: ids.session } })
tests/integration/dsar-export-selection.test.js:191:   await prisma.session.deleteMany({ where: { id: { in: [...] } } })
tests/integration/dsar-full-lifecycle.test.js:193:     await prisma.session.deleteMany({ where: { id: ids.session } })
tests/integration/dsar-item-actions.test.js:171:       await prisma.session.deleteMany({ where: { id: ids.session } })
tests/integration/dsar-item-search.test.js:211:        await prisma.session.deleteMany({ where: { id: { in: ids.sessions } } })
tests/integration/dsar-timeline.test.js:144:           await prisma.session.deleteMany({ where: { id: ids.session } })
tests/unit/itemIndex.test.js:121:                      await prisma.session.deleteMany({ where: { id: ids.session } })
```

None of these calls `shredFile`/`deleteFile` on the session's storage tree first. Every test that
creates a session with real photos through the real `sealBlob`/`writeFile` pipeline
(`scripts/make-e2e-fixtures.js` builds real sealed fixtures for exactly this purpose) and then tears
down with `session.deleteMany()` leaves that session's sealed media on disk forever. **This is the
observed, live, measured mechanism that produced the 202.6 MB / 901-file / 189-directory corpus
above** — it is what running this repo's own test suite against real storage does, every run, with
no cleanup step anywhere for it. `scripts/migrate-media-encrypt.js`'s `migrateOrphans()` pass
(walks the whole tree, seals anything unsealed) does not help either — it has no concept of "this
directory's owning row is gone," it just re-confirms these files are sealed and leaves them in
place forever (`stats.orphansSealed` counts files it sealed, not files with no owner).

### Why this is P0, not just untidy test hygiene

The *mechanism* — a DB-level session deletion (test teardown today; a future "delete session" admin
action, a botched migration, a manual `DELETE FROM sessions`, or a restore from an inconsistent
backup tomorrow) leaves sealed media permanently orphaned — is exactly as available in a production
deployment as it is in this dev/test environment. `discovery.service.js` enumerates locations by
walking **from** `Photo`/`FaceDetection`/etc rows (confirmed: `discovery.service.js:153`
`select: { id, photoId, cropPath, taggedSubjectId }` off `faceDetection.findMany`, same shape for
every other object type in the file). Once the row is gone, discovery cannot find the file, so
`createPurgeJob()` never plans a location for it, so `executePurgeJob()` never shreds it, so
**a deletion certificate can be issued attesting a subject's data was erased while their actual
sealed photos remain fully decryptable on disk by anyone holding `MEDIA_KEK`** (path-scope keys, per
C-1/C-2, never expire and never rotate away). This is the identical failure mode the brief's
`recognition.service.js` question was pointing at, just proven here at a much larger, empirically
measured scale, with an identified, reproducible cause.

### C-3a — the brief's specific mechanism, traced (currently zero live instances, but real)

`backend/src/modules/sessions/recognition.service.js:107-108`:

```js
await prisma.faceDetection.deleteMany({ where: { photo: { sessionId } } })
await prisma.faceCluster.deleteMany({ where: { sessionId } })
```

runs at the top of every `processSession()` call, unconditionally — including on a *re-run* of a
session that already has crops. The new detection loop (`recognition.service.js:113-129`) creates
fresh `FaceDetection` rows with fresh UUIDs and writes fresh crop files at
`sessions/${sessionId}/crops/${record.id}.jpg` — a **different filename** than the deleted rows
pointed at, because `record.id` is a new UUID each time. The **old** crop files, whose owning rows
were just deleted, are never touched — `writeFile` is only ever called for the new ones. This is a
straight read of the code; I did not re-run recognition on a live session to reproduce it (that
would mutate the running system, which the audit rules forbid). Currently `liveSessionOrphanCrops
== 0` because no live session in this dataset has actually been reprocessed a second time yet — the
mechanism is real but unexercised in the current data. C-3's cascade-delete mechanism (Type B above)
is the one actually responsible for the corpus measured.

### Caveat on the `dsar/` (export package) orphan count

The 27 unreferenced `dsar/*/package.zip` files are a different risk profile from C-2/C-3's
path-scoped orphans, and should not be treated with the same urgency. Export packages are sealed
under `scope: 'export'` — a truly random 32-byte DEK (`keyring.js:239-257`, `randomBytes(32)`),
never derivable from `MEDIA_KEK` alone; the only copy of the wrapped key lives in
`DsarEvidence.payload.wrappedKey` (JSON). `DsarRequest.evidence` cascades
(`prisma/schema.prisma` `DsarRequest` model → `evidence DsarEvidence[]`), so the same
`dsarRequest.deleteMany()`-in-test-teardown pattern that orphans a session also orphans its export
package's *tracking row* — but because the wrapped DEK lived only in that row, **the orphaned `.zip`
bytes on disk are very likely already cryptographically unreadable** (no surviving copy of the
wrapping key). This is a storage-hygiene / retention leak (contributes to the growth numbers in the
lead's S-2 finding), not a live confidentiality hole like C-2/C-3's path-scoped orphans — worth
fixing (a reaper that deletes files with no `DsarEvidence` row, distinct from `expirePackages()`
which only handles *expiry* of packages that still have a row, see C-6) but it is P2, not P0.

**Fix (for C-3 as a whole):** tie storage lifecycle to DB lifecycle. Either (a) forbid hard-deleting
`Session`/`DsarRequest` rows outside a code path that first walks and shreds their storage tree
(a Prisma extension/middleware on `delete`/`deleteMany` is the natural hook), or (b) add a
standalone reaper that compares `storage/media/sessions/*` against live `Session.id`s (exactly what
`orphan-sessions.mjs` does) and shreds anything with no owner, run on a schedule and logged to the
audit trail with an explicit "orphan sweep" action. Either way, fix the eight test-teardown call
sites so the test suite stops manufacturing the exact corpus this finding measures, every run.

---

## FINDING C-4 (P1, design-as-documented, worth restating precisely) — face crops and every session-scoped derivative are keyed by SESSION, not by subject. `destroySubjectKey()` never reaches them; only physical `shredFile()` does.

Live decrypt of a real face crop confirms the design: `sessions/<sid>/crops/<faceDetectionId>.jpg`
→ `scopeForPath` → `{scope:'path', scopeId:'sessions/<sid>'}` → one key per **session**, shared by
every face detected in it, regardless of which subject each face belongs to. Same for the original
photo, the bystander-redacted derivative, and — more surprisingly — the **per-person** redacted
cache at `session.service.js:1583-1587`:

```js
const cachePath = `sessions/${sessionId}/redacted/${photoId}.person-${subjectId}.jpg`
...
// No explicit scope: storage.scopeForPath derives the DEK from the path, so a
// per-person derivative is sealed under the same key as the session it belongs
// to and stays readable after a process restart.
await writeFile(cachePath, derived)
```

Despite the filename literally encoding `subjectId`, this artefact — "subject X's specific view of
photo Y" — is sealed under the **session's** key, not X's. This is called out explicitly and
correctly in `storage.js`'s own header comment (`sessions/<sid>/... -> path scope keyed on the
session prefix (L2/L3/L6/L7)`) so it is not miscategorised anywhere; I am restating it here with
live proof because the brief specifically asked what `destroySubjectKey()` does and does not reach,
and this is the majority of stored bytes (1,293 of ~1,353 files per the lead's earlier scan) that it
does not touch. Erasure of this data relies entirely on `purge.service.js`'s `L2`/`L3`/`L6`/`L7`
handlers doing `shredFile()` correctly and being reached by discovery — which is exactly the
mechanism C-3 shows can silently fail to happen.

---

## FINDING C-5 (P1, observability/rotation) — `Photo.encKeyId` is not populated by the highest-volume write path, defeating its own stated purpose.

`prisma/schema.prisma`, `Photo.encKeyId`: *"keyId of the DEK that sealed storagePath / redactedPath.
null = plaintext legacy blob not yet swept by scripts/migrate-media-encrypt.js."* The column exists
specifically so a rotation/audit sweep can tell, from the DB alone, which key protects which row —
`storage.js:96` says the same thing generically: *"keyId belongs in the row's `encKeyId` column so a
later key rotation knows what it is looking at."*

`session.service.js:250`, `addPhoto()` (the path every session-captured photo goes through):

```js
await writeFile(storagePath, normalized)          // return value discarded
```

`writeFile` returns `{ fullPath, keyId, encrypted, wrapped }` — `keyId` is dropped on the floor.
The subsequent `prisma.photo.create({...})` (lines just below) does not set `encKeyId` at all.

**Live proof:** queried a real `Photo` row and its file together
(`scratchpad/decrypt-probe.mjs`):

```
Photo row: { id: '10a818f8-...', storagePath: 'sessions/e221257d.../photos/e204eb49....jpg', encKeyId: null, ... }
--- session photo (original) ---
sealed: true
header: keyId=e3d765bb30ba3733 ...
resolveKey -> derived keyId=e3d765bb30ba3733 (matches header: true)
DECRYPT OK
```

The file is genuinely sealed with a real, correctly-derived key — but `Photo.encKeyId` is `NULL` in
the database for it. Contrast with `video.service.js:138` and `recording.service.js:183`, which
both correctly do `const { keyId } = await writeFile(...)` and persist it (`encKeyId: keyId`) on the
row. Photos — the largest and highest-volume media type — are the one write path that drops it.

**Consequence:** compounds C-1. Even after C-1 is fixed with a reverse keyId→version lookup, an
operator wanting to know "how many photos are still sealed under the old KEK version and need
re-encrypting" cannot answer that from the database for the majority of photos — they would have to
open every file and read its header. It also means `migrate-media-encrypt.js`'s idempotency check
(`stampIfNeeded`, only writes if `currentKeyId !== keyId`) is comparing against a value that was
never set correctly in the first place, so the "already sealed but unstamped from an interrupted
run" self-heal the script is designed around silently repairs data that plain application traffic
broke on the very first write.

**Fix:** `session.service.js:addPhoto` (and the two other `writeFile(storagePath, normalized)` /
`writeFile(redactedPath, ...)` call sites in the same file that also discard the return value —
lines 1242, 1343, 1586) should capture `keyId` and persist it the same way `video.service.js` and
`recording.service.js` already do.

---

## FINDING C-6 (P0, secrets) — `AUDIT_HMAC_SECRET` silently falls back to a hardcoded, published default with no boot-time enforcement, unlike every other secret in this file.

`backend/src/lib/auditLog.js:4-5`:

```js
export const DEFAULT_AUDIT_SECRET = 'dev-only-secret-change-in-prod'
const HMAC_SECRET = process.env.AUDIT_HMAC_SECRET ?? DEFAULT_AUDIT_SECRET
```

This constant is computed **once, at module import**, with a plain `??` fallback and **no
`NODE_ENV` check anywhere in this file.** Compare to every other secret this audit covers:

- `storage.js:27-36` — `ENCRYPTION_ENABLED` computation **throws at import time** if
  `NODE_ENV=production` and no `MEDIA_KEK`.
- `embeddingCrypto.js:26-31` — throws at import time if neither `MEDIA_KEK` nor
  `FACE_EMBEDDING_KEY` is set, unconditional on `NODE_ENV`.
- `signingKey.js` — throws (not silently substitutes) if neither `DSAR_SIGNING_SEED` nor
  `MEDIA_KEK` is available.

`AUDIT_HMAC_SECRET` is the **only** one of the four secrets in this domain that has a silent,
functioning, non-throwing fallback to a value that is published verbatim in the repo:
`.env.example:44` — `AUDIT_HMAC_SECRET="dev-only-secret-change-in-prod"`.

The enforcement that exists — `backend/scripts/preflight.js:41-48` — is real and correctly written
(`WEAK_VALUES` includes both `DEFAULT_AUDIT_SECRET` and the literal string; `FAIL`s if unset,
default, or under 32 chars) but it is **a separate, manually-invoked script.** Confirmed by grep:
`preflight` is referenced nowhere in `src/`, `server.js`, `app.js`, or any `Dockerfile` `CMD`. The
backend's own container just runs `node src/server.js` (`Dockerfile:200` area). `package.json`
exposes it as `npm run preflight` but nothing calls that script automatically before `npm start`,
in a `Dockerfile` `ENTRYPOINT`, or in CI (no CI workflow file references it either — not searched
exhaustively outside `backend/`, see "what I could not check"). `docs/DEPLOY.md:66` states *"A green
preflight is a precondition for go-live"* — which is a **process** requirement, not a code-enforced
one, and it is the only one of the four secrets in this domain for which that is true.

**Consequence:** a production deployment that boots without `AUDIT_HMAC_SECRET` set (missed env var,
typo'd name, secret-manager misconfiguration) does not crash, does not log an error, does not
degrade visibly. It signs the entire 7-year-retention audit hash-chain (`audit_log`, 4,880 live rows
today) with a value that is sitting in plain text in this very repository's `.env.example`. Anyone
who has ever cloned the repo, or read `docs/DEPLOY.md`, knows the fallback secret. Every
`payloadHash` computed under that condition is forgeable by definition — `computeChainHash` is a
keyed HMAC, and the "key" would be public. `/api/v1/audit/verify` would report `valid: true` for a
forged chain built with the known default, because verification only checks internal
self-consistency (see C-7).

**Fix:** apply the same pattern `storage.js` uses — throw at import (or at least when
`NODE_ENV=production`) if `AUDIT_HMAC_SECRET` is unset, equals `DEFAULT_AUDIT_SECRET`, or is under
32 characters, rather than leaving that check to a script an operator has to remember to run.

---

## FINDING C-7 (P1, design limitation, not a bug) — the audit chain has no rotation story for `AUDIT_HMAC_SECRET`, and its tamper-evidence is only as strong as the confidentiality of one static, plaintext, co-located secret.

Two related points, both confirmed by reading `audit.service.js:92-146` and `auditLog.js` in full:

**No rotation.** `HMAC_SECRET` is a single module-level constant, no version, no keyId, no per-row
marker of which secret signed it — unlike `MEDIA_KEK` (which at least has `MEDIA_KEK_VERSION`/
`_PREVIOUS` scaffolding, even though C-1 shows it is incompletely wired) or the Ed25519
`DSAR_SIGNING_SEED` (`signingKey.js` derives a public `keyId` from the key itself specifically so
rotation is detectable). If `AUDIT_HMAC_SECRET` is ever legitimately rotated — the exact hygiene
`preflight.js` implicitly expects an operator to be capable of — **every previously-written row's
`payloadHash` stops matching a recomputation with the new secret.** `verifyChain()` would report
`HASH_MISMATCH` for the entire pre-rotation history, indistinguishable from real tampering, with no
way to tell "we rotated the key" apart from "someone edited a row" from the verify output alone.

**Verified live, both dimensions the brief asked for:**

```
GET /api/v1/audit/verify?entityType=Session&entityId=b60c54e9-b5a8-4b21-80d0-e1e6292e245f
  -> {"entries":7,"valid":true,"verified":0,"linkageOnly":7,
      "caveat":"7 legacy entries predate payloadDigest and were checked by linkage only","breaks":[]}

GET /api/v1/audit/verify?entityType=Subject&entityId=de351590-aea7-457a-a784-2241dcf2fc66
  -> {"entries":114,"valid":true,"verified":73,"linkageOnly":41,
      "caveat":"41 legacy entries predate payloadDigest and were checked by linkage only","breaks":[]}
```

The chain does validate live — both `LINKAGE_BROKEN` (prevHash continuity) and `HASH_MISMATCH`
(HMAC recompute) checks run, and confirmed no breaks on two real entities. This is a positive
finding worth recording plainly. **But there is no whole-ledger verify** — the route takes one
`(entityType, entityId)` pair at a time (`audit.routes.js:57-63`, `verifyQuerySchema` requires
both), and `writeAuditLog` scopes the chain **per entity**
(`auditLog.js:29-32`, `prevHash = lastEntry` found via `findFirst({where:{entityType,entityId}})`).
There is no global sequence, no cross-entity anchor, and no endpoint that enumerates every
`(entityType, entityId)` pair that exists — an operator has to already know what to ask for.

**Where a gap breaks it silently.** Because each entity's chain is independent and there is no
external anchor (no periodic Merkle-root publication, no append-only external log, no monotonically
increasing global counter the app itself checks), **deleting the single most recent row for a given
entity is invisible to `verifyChain()`** — the function only walks the rows it is handed and checks
that each one's `prevHash` matches its predecessor; a chain that is simply one entry short at the
tail has nothing after it to notice the gap. I verified this is not exploitable through the
application's own DB credentials: live query against `information_schema.role_table_grants` shows
`prism_app` (the app's runtime role) holds **only `INSERT, SELECT`** on `audit_log`:

```
[ { grantee: 'prism_app', privilege_type: 'INSERT' },
  { grantee: 'prism_app', privilege_type: 'SELECT' } ]
```

matching the RLS migration (`prisma/migrations/20260710000002_.../migration.sql:83`,
`REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM prism_app`). This is real, verified,
well-designed defence-in-depth — the running application cannot truncate or edit its own audit
trail even via a hypothetical SQL-injection bug. **It does not, however, require DELETE privilege to
forge the chain going forward**: `INSERT` plus knowledge of `AUDIT_HMAC_SECRET` is sufficient to
append arbitrary new rows that recompute as internally valid — because HMAC-chain tamper-evidence
only proves "whoever wrote this knew the secret," not "whoever wrote this was the legitimate actor
at the legitimate time." And the secret sits in the same plaintext `.env` file
(`backend/.env:33`) as `DATABASE_URL` (`.env:...`) — anyone with filesystem read access to that one
file has everything needed to both write directly to Postgres (bypassing the app, and RLS's INSERT
policy is `WITH CHECK (true)` — unconditional) and compute matching hashes. This is an inherent
limitation of a shared-secret HMAC chain rather than a fixable bug; the codebase already has the
right tool for a stronger guarantee sitting next to it — `signingKey.js`'s Ed25519 keypair (used
today only for DSAR deletion certificates) would let each audit entry (or periodic batches of them)
carry an asymmetric signature that a holder of only the *public* key can verify but not forge, which
a compromised `AUDIT_HMAC_SECRET`/`DATABASE_URL` pair cannot fake.

**Fix:** version `AUDIT_HMAC_SECRET` the way `MEDIA_KEK` is (an `hmacKeyVersion` alongside each row,
or at minimum a documented "rotation requires re-signing history or freezing verification of
pre-rotation rows" runbook entry — right now there is none). Consider periodically anchoring
(signing) the current chain tip with the existing Ed25519 signing key so tampering that stays
internally self-consistent (the forge-with-the-known-secret scenario) becomes detectable against an
independent, asymmetric root of trust. Lower priority: add a `GET /api/v1/audit/entities` (or
similar) so a DPO doing an investigation is not required to already know every entityType/entityId
pair to audit.

---

## FINDING C-8 (P1, confidentiality) — face-gallery embeddings are stored in Qdrant as PLAINTEXT vectors with plaintext PII payload (full name, subject id, consent id), for as long as the ephemeral collection exists. Not sealed under `MEDIA_KEK`, not sealed under the per-subject DEK, no `AES-GCM` anywhere near this path.

`backend/src/lib/faceGallery.js:44-58`:

```js
export async function addEnrollmentPoint(
  sessionId,
  { embedding, masterUserId, consentId, fullName, enrollmentId },
) {
  await qdrant.upsert(collectionName(sessionId), {
    wait: true,
    points: [{
      id: randomUUID(),
      vector: embedding,                                      // raw 512 floats, unencrypted
      payload: { masterUserId, consentId, fullName, enrollmentId }, // plaintext name
    }],
  })
}
```

Called from `session.service.js:393` (`buildSessionGallery`), which loads every enrolled
participant's decrypted embedding (via `resolveEnrollmentEmbedding` → `decryptEmbeddingForSubject`,
correctly decrypting the sealed-at-rest column) and immediately re-serialises it **unencrypted**
into Qdrant, next to their real full name, for the duration of the session's recognition pass.

The `Photo`/`FaceDetection` schema comment (`prisma/schema.prisma`, above `FaceDetection`) says
*"Face embeddings are NEVER persisted here or in Qdrant"* — that is true of **per-detection**
embeddings (correctly dropped after clustering, never written anywhere), but it does not describe
what actually happens to **enrollment** embeddings, which this same file's `addEnrollmentPoint`
does write to Qdrant, in the clear, with a name attached.

`backend/src/config/qdrant.js`:

```js
export const qdrant = new QdrantClient({ url: process.env.QDRANT_URL })
```

No `apiKey` option anywhere in the codebase (`grep -rn "QDRANT" .env .env.example` shows only
`QDRANT_URL`) — there is no code path to configure Qdrant authentication at all, in any environment.
Confirmed live: `curl http://localhost:6333/collections` succeeds with **zero** auth headers.
Whatever network boundary protects Qdrant in production is entirely external to the application; the
app itself never sends credentials and has no support for doing so.

### "Zero collections despite 108 FaceDetections" — resolved: ephemeral design, working as intended for completed sessions, BUT a live contradiction exists for the one session currently RUNNING

```
curl http://localhost:6333/collections  -> {"result":{"collections":[]}...}
```

`faceGallery.js` is explicitly ephemeral by design (header comment: *"One Qdrant collection per
session, built at endSession and destroyed at finalize... nothing here outlives the session"*), and
`destroyGallery(sessionId)` is called on every finalize success path (`session.service.js:1055`) and
on every terminal job failure (`recognition.worker.js:51,59`), plus a backstop sweep
`cleanupOrphanGalleries()` (`lib/cleanup.js:43-67`, not itself scheduled — see below). For the 25
completed/finalized sessions in this dataset, an empty `/collections` list is exactly what "ephemeral
by design, working correctly" looks like.

**But** one session is not finished: `COL-7224` (id `faa3e6fd-9a1a-4d2a-b6c7-23a9a430ac49`),
`status: PROCESSING`, `RecognitionJob` `status: RUNNING`, `startedAt: 2026-08-19T20:00:02Z` (already
flagged by the lead as stuck — R-1). The code order is fixed and unconditional
(`session.service.js:476-489`): `buildSessionGallery()` (creates the collection, upserts every
enrolled participant's plaintext vector+name) is `await`ed and **must succeed** before
`recognitionJob.create()` even runs — `buildSessionGallery` throws `ApiError(503, ...)` on
`createGallery` failure (`session.service.js:359-363`), which would have prevented the
`RecognitionJob` row from ever being created. Since the job row exists and is `RUNNING`, the Qdrant
collection `session_faa3e6fd-9a1a-4d2a-b6c7-23a9a430ac49` **must have existed** as of
2026-08-19T20:00:02Z. Queried it directly:

```
GET /collections/session_faa3e6fd-9a1a-4d2a-b6c7-23a9a430ac49  -> HTTP 404
  {"status":{"error":"Not found: Collection `session_faa3e6fd-...` doesn't exist!"}}
```

It is gone. None of the three code paths that call `destroyGallery` should have fired for this
session (it is neither finalized nor `FAILED`/`ARCHIVED`, so `cleanupOrphanGalleries` would not
touch it even if that sweep were running, which — per its own comment — it is not scheduled
anywhere in this codebase; it is meant to be invoked by an external scheduler that does not appear
to be configured). The most likely explanation is that the Qdrant container/volume was restarted at
some point in the ~1.3 days since, silently dropping in-flight collections with **zero application
awareness** — no error, no alert, nothing in the job's `error` column (`null`). This is a secondary,
narrower finding on top of R-1 (the lead's fetch-without-timeout hang): even independent of that bug,
a mid-flight gallery can vanish under the running job with no detection, and if/when this stuck job
is ever forcibly resumed, `searchGallery()` (`recognition.service.js:159`) will throw against a
phantom collection with no handling visible in `processSession` for that specific case — it would
propagate as an unhandled rejection to BullMQ's `failed` handler along with everything else.

**Consequence for the primary ask (encrypted at rest in Qdrant: NO):** while a gallery exists —
which per this observation can be for over a day on a stuck session, not just "the few minutes" the
code comment assumes — a Postgres-external, unauthenticated-by-default store holds every enrolled
participant's raw biometric vector next to their real name, fully queryable by anyone who can reach
port 6333, with none of the AES-256-GCM/HKDF machinery this audit's other findings otherwise apply
throughout the rest of the stack.

**Fix:** at minimum, configure and require Qdrant API-key auth (`QdrantClient({ apiKey })`) — there
is no code path for it today, so this is a real gap, not a missing env var. Longer-term, if session
processing genuinely needs minutes-not-days for the ephemeral-gallery assumption to hold, R-1's
missing fetch timeouts need fixing so a gallery is never left alive across a multi-day hang. Schedule
`cleanupOrphanGalleries`/`cleanupOrphanVoiceGalleries` (both exist, neither is wired to a scheduler
in this codebase — confirmed by grep, only referenced from `lib/cleanup.js` itself and nowhere that
invokes it periodically).

---

## FINDING C-9 (P2, correctness/robustness) — `subjects/orphan/...` fallback paths pass the literal string `'orphan'` as a subject id into `getSubjectKey`, which will fail against a `@db.Uuid` column rather than silently using a weak key.

`session.service.js:1240`, `session.service.js:1583` (comment), and `video.service.js:363-366` all
have an "imported/orphan item with no session" fallback of the shape:

```js
const redactedPath = photo.sessionId
  ? `sessions/${photo.sessionId}/redacted/${photo.id}.jpg`
  : `subjects/${photo.subjects[0]?.subjectId ?? 'orphan'}/imports/redacted/${photo.id}.jpg`
```

If `photo.subjects[0]` is ever `undefined` for an imported (sessionless) photo being re-redacted,
this resolves to `subjects/orphan/...` → `scopeForPath` → `{scope:'subject', scopeId:'orphan'}` →
`getSubjectKey('orphan')` → `prisma.subjectKey.findUnique({ where: { subjectId: 'orphan' } })`
against a column typed `@db.Uuid`. This is not a syntactically valid UUID, so Postgres/Prisma should
reject it at the query layer (an invalid-input-syntax error), meaning this specific edge case fails
loudly rather than silently using a weak/shared key — a correctness bug (an unhandled exception on
an edge case), not a confidentiality one. Not reproduced live (would require an imported photo with
an empty `subjects[]`, which the normal import flow should not produce — `import.service.js`
requires `assertImportableSubject` before ingest). Flagging as INFERRED, low-likelihood-but-possible,
and worth a defensive `if (!subjectId) throw` rather than a silent `?? 'orphan'` string fallback that
reads as if it were meant to be a safe sentinel.

---

## FINDING C-10 (P2, storage hygiene) — plaintext audio/video sits briefly on the OS temp volume, outside `STORAGE_ROOT`/encryption, before sealing; the `finally`-block cleanup is well-implemented for the common case but has a real crash-window gap with no restart-time sweep.

`recording.routes.js` and `video.routes.js` both use `multer.diskStorage` (deliberately, not
`memoryStorage` — the comment explains this correctly: buffering a 200 MB upload twice in the Node
heap took the API down under concurrent load) writing to `path.join(os.tmpdir(),
'prism-audio-uploads')` / `'prism-video-uploads')` — **outside `STORAGE_ROOT`, unencrypted, in a
predictable, world-visible-by-name shared OS temp directory** — before the route handler reads it
into a buffer and calls `storage.writeFile` (which seals it).

This is well-engineered for the ordinary case: both routes wrap the handler in
`try { ... } finally { await cleanup([req.file]) }`, and `cleanup` unlinks the temp file whether the
handler threw or not (verified by reading the full route handlers, not just the multer config).
**The gap is the crash window**: if the process is killed (`kill -9`, OOM-killer, power loss, a
Windows service stop) between multer finishing the write and the `finally` block running, the
plaintext file survives indefinitely — there is no startup sweep of `prism-audio-uploads`/
`prism-video-uploads` anywhere in the codebase (confirmed: those two literal strings appear only in
the two route files that create them). Live check confirms both directories exist and are currently
empty (`ls .../Temp/prism-audio-uploads`, `.../prism-video-uploads` → both empty) — i.e. no active
leak right now, consistent with no recent crash, not evidence the gap doesn't exist. Also worth
noting: cleanup is a plain `fs.rm` (unlink), not the overwrite-then-unlink `shredFile()` pattern this
codebase uses elsewhere specifically because unlink-only leaves recoverable blocks on SSD/COW
filesystems (`storage.js:144-153`'s own reasoning) — here applied to genuinely unencrypted bytes,
where that residue matters more than it does for ciphertext.

**Fix:** add a startup sweep that clears both temp directories on boot (safe — nothing valid should
ever be waiting there across a restart, given they're `mkdtemp`-adjacent scratch space per multer's
own model), and/or move `cleanup()` to use a short-lived overwrite before unlink for these two
specific directories given they hold plaintext.

---

## FINDING C-11 (P3, dead code / minor) — `vault/<projectId>` project-scoped encryption is fully implemented and entirely unused.

`scopeForPath`'s `vault` branch (`storage.js:60`) and `deriveProjectKey` (`keyring.js:139-150`) are
complete, tested-shaped code with no call site anywhere in `backend/src` that ever writes to a
`vault/...` path (`grep -rn "vault/" backend/src` returns only the two definition sites; no
`storage/media/vault` directory exists on disk). This lines up with the lead's independent finding
that there is no project-wide export feature at all (`00-LEAD-live-api-and-pipeline.md`, FINDING
E-1) — `L8` in the purge vocabulary, which would be the natural consumer of project-scoped storage,
is a permanent no-op in `purge.service.js` (`async L8() { return 'SKIPPED' }`). Not a risk by itself;
flagging so that whoever eventually builds the project-wide export (E-1) knows the project-scope
key-derivation machinery already exists and is unit-testable in isolation from the export feature
itself — and so they know it currently carries none of C-1's rotation gap protection either (project
scope shares the exact same `derivePathKey`/`deriveProjectKey`-has-no-version-fallback defect).

---

## What is RIGHT and must survive any fix (recorded so a rewrite doesn't regress it)

- **The envelope format itself is sound.** `blobCrypto.js`: AES-256-GCM, fresh CSPRNG `randomBytes(12)`
  nonce per blob (no counter, no deterministic derivation anywhere — checked every call site:
  `sealBlob`, the legacy path in `encryptEmbedding`, `createExportKey`'s wrap step), header
  `magic|version|keyId|nonce|tag` authenticated as AAD so a bit-flip in the keyId or version fails
  authentication exactly like a bit-flip in the ciphertext (`sealBlob`/`openBlob:96,120`). Verified
  live: decrypted a real session photo, a real face crop, and three enrollment selfies — GCM tag
  checked out on every one, `openBlob` recomputes and compares `keyId` before even touching the
  cipher (fail-fast, correct-error-type design: `BlobKeyMismatchError` vs `BlobIntegrityError` are
  usefully distinguishable).
- **HKDF-SHA256 domain separation is real** — `INFO_PROJECT`/`INFO_SUBJECT`/`INFO_EXPORT`/`INFO_PATH`
  are distinct info strings, so even a salt collision across scopes cannot produce the same derived
  key. `keyId` is itself an HMAC (not a hash) over `(version, info, salt)` keyed by the KEK, so a
  keyId leak does not help an attacker without the KEK.
- **`MEDIA_REQUIRE_SEALED=on` is set in this live `.env`** (`backend/.env:60`) — legacy unsealed
  reads are a hard error here, not a silent pass-through. Confirms the hardening flag is actually
  turned on, not just documented.
- **`shredFile()`'s crypto-aware overwrite is correct**: it overwrites only the header
  (magic+version+keyId+nonce+tag) for a sealed blob rather than the whole file — enough to make the
  remaining ciphertext unopenable even if the truncated write or the unlinked inode is later
  recovered — and overwrites the whole file for a legacy plaintext blob, matching the different
  threat model each case has. The `ENOENT`-is-success handling makes purge resumable, which
  `purge.service.js` relies on correctly throughout.
- **`prism_app`'s Postgres grants on `audit_log` are exactly `INSERT, SELECT`, verified live** — a
  real, working defence-in-depth control against the application (even a compromised one) truncating
  or editing its own audit trail. See C-7 for what this does and does not protect against.
- **`import.service.js`'s subject-scoping of imported photo originals is correct and its comment
  explains exactly why** (`subjects/<uid>/imports/<sha256>.jpg` → per-subject DEK, so an imported
  photo is reachable by the same crypto-shred a captured one is). This is the pattern C-2's fix
  should copy.
- **The migration script (`migrate-media-encrypt.js`) is careful about not leaking plaintext**: the
  re-sealed embedding's decrypted value is described in its own comment as existing "only inside
  this expression," matches the code (no intermediate variable escapes the `try` block, never
  logged), and its resumability is built from a property of the bytes on disk (the magic number)
  rather than a checkpoint file that can disagree with reality after a crash — a genuinely robust
  design for a one-shot backfill tool.

---

## What I could not check

- **Did not perform a live `MEDIA_KEK` rotation** to directly reproduce C-1 (bumping
  `MEDIA_KEK_VERSION`/setting `MEDIA_KEK_PREVIOUS` and re-reading a photo) — the audit rules forbid
  reconfiguring the running service, and this secret is read once at process start
  (`kekCache`/`resetKeyringCache` is a "test seam only") so it would have required a restart, also
  forbidden. C-1's mechanism is traced through the source with high confidence but is not
  live-reproduced.
- **Did not reproduce C-3a (recognition re-run leaving live-session crop orphans) live** — doing so
  would mean re-running recognition on a real session (mutating the running system), which is out of
  scope for an audit-only pass. The mechanism is traced through the exact deleteMany/writeFile
  sequence in `recognition.service.js`, and the live dataset independently confirms the *general*
  class of bug (orphaned crops that survive their owning row) at large scale via C-3's cascade-delete
  path — I could not isolate a naturally-occurring instance of the re-run-specific sub-case within
  the audit window.
- **Did not determine why the 189 orphan session directories accumulated specifically** (single large
  test run vs. many runs over time vs. a `prisma migrate reset` that only clears the DB) — the
  eight `session.deleteMany()` teardown call sites are sufficient to explain the *mechanism*, and the
  file/byte counts are directly measured, but I did not correlate directory `mtime`s against
  specific historical test runs or git history to build a precise timeline.
- **Did not find or inspect a CI workflow** that might invoke `npm run preflight` outside the
  `backend/` tree (e.g. `.github/workflows/`) — searched `docs/` and `backend/` only, per the domain
  scope and the instruction to avoid wide/slow greps outside named directories. If such a workflow
  exists and gates deploys on preflight, C-6's severity should be reassessed down from "no
  enforcement at all" to "enforced in CI but not at boot," which is materially better.
- **Did not test the `subjects/orphan` UUID-rejection hypothesis in C-9 live** — would require
  constructing a photo row with an empty `subjects[]` array while sessionless, which the normal
  import path should prevent; flagged as INFERRED/low-confidence-severity accordingly.
- **`ai-core/*` workers** (face-worker, image-pii-worker, audio-worker) are out of this domain's
  scope per the brief's file list, but they are the ones actually computing embeddings from
  plaintext images/audio in-process before handing vectors back over HTTP — I did not check whether
  any of those Python services themselves write plaintext to disk during inference (e.g. a
  library's internal temp-file cache). Flagging as an adjacent area another auditor's domain likely
  covers, not verified here.
- **Did not check whether `backups`/replicas of Postgres or the storage volume exist**, which would
  be the most consequential amplifier of C-1/C-2/C-3 (a KEK rotation or a crypto-shred is
  retroactively defeated by any backup taken before it that is later restored without re-applying
  the shred) — infrastructure-level, outside what's inspectable from the running application and
  its repo.
