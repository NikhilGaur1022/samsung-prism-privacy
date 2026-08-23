# Export/download + metadata — deep audit (2026-08-21)

Domain: `backend/src/modules/dsar/export.service.js`, the download surfaces in both portals, the
non-existent project-wide export, and the metadata-stamping design. Builds on the lead's
`00-LEAD-metadata-and-scale.md` (ingest strips EXIF, byte-proven) and
`00-LEAD-live-api-and-pipeline.md` (route inventory: no project-wide export route exists). Neither
is re-derived here.

All shell transcripts below are literal (copy-pasted from the actual run), not reconstructed.
Every claim is tagged OBSERVED (I ran it against the live stack) or INFERRED (reasoned from code
I read in full, cited by path:line).

---

## Part 1 — `export.service.js`, documented in full (778 lines, read start to end)

### What builds a package: `buildAccessPackage(dsarRequestId, admin, { selection })` (L116-619)

- **Who may call it, and for what request types** (L116-126): any `DsarRequest` of `type=ACCESS`
  produces a package on any path (subject self-service or operator). Any **other** type
  (`CORRECT`, `GRIEVANCE`, `WITHDRAWAL_ERASURE`, `NOMINATION`) only produces one when `admin` is
  truthy — the code comment (L119-123) frames this as **"a handler's working copy"**, evidenced
  identically to a §11 package but not intended for subject self-service. **This intent is never
  enforced in code** — see Part 3, Finding EXP-4.
- **Selection** (`resolveSelection`, L47-101): `'ALL'` (default, whole subject), `'SELECTED'`
  (whatever an operator marked with a Phase-5 `EXPORT` `DsarItemAction`), `{itemIds}` (ad hoc,
  re-checked against the request's own `subjectId` so another principal's grid can't leak in,
  L72-74), or `{filter}` (type/origin/projectId/date range). All four resolve to a `Set` of
  `PhotoSubject.id` and `Recording.id`.
- **What is fetched, unconditionally, regardless of selection** (L132-230): subject profile,
  consents, **all** `PhotoSubject` links, **all** `Recording`s the subject speaks in (queried by
  `segments: { some: { subjectId } }`, not filtered by selection at the query level — selection is
  applied later, in the per-item loop), face/voice enrollment **counts** (never templates),
  **200** most recent `AccessEvent` rows, and **all** `TextSpan`s. This unconditional recordings
  fetch is the root of Finding EXP-1 below: a broken row in it kills every build for that subject,
  no matter what was selected.
- **Fail-closed rule, applied identically to photos (L268), recordings (L332) and text (L397)**: an
  item is excluded with a stated `reason` unless its redacted derivative exists **and** its
  worker-confirmed status is terminal-clean (photo `piiStatus` not `DEFERRED`/`FAILED` and has
  `redactedPath`; recording `status` not `DEFERRED`/`PENDING_ANALYSIS`; document `status ===
  'REDACTED'`). Originals are **never** read for the package — only `redactedPath`/equivalent.
  This is deliberate policy stated in the file header (L14-21): shipping originals would disclose
  every bystander in a shared frame.
- **Per-file naming inside the archive**: `photos/${photo.id}.jpg` (L283, always `.jpg`,
  independent of `photo.mimeType`), `recordings/${recording.id}.${extensionFor(recording.mimeType)}`
  (L347 — **this is the line that crashes when `mimeType` is `null`**, see EXP-1),
  `documents/${doc.id}.redacted.txt` (L412).
- **Per-file integrity**: each included file gets a `sha256` in the manifest (L287, L351, L416),
  computed over the plaintext buffer just read.
- **Manifest** (`manifest.json`, unshifted to the front of the file list, L429-522): `version: 3`
  (but see EXP-6 — a package built against different code paths at different times can carry an
  **older schema version in the same DSAR request's evidence trail**, observed live below),
  `packageType`, `generatedAt`, a `selection` block that states completeness so a partial package
  can never be mistaken for a full §11 answer, `dataPrincipal` (full profile fields — name, email,
  phone, DOB, guardian/nominee contacts), `consents[]` (with `signatureHash`), `biometrics`
  (**counts and pose labels only — "Face templates are held encrypted and are never exported,
  displayed, or disclosed to any operator," L485, and this is true: no embedding ever appears in
  `files`**), `photos[]`/`recordings[]`/`textDocuments[]` (one entry per item, `included` +
  `reason` for every excluded one), `processingSummary` (purposes in force, a static list of the
  three named workers, and the 200 `recentAccessEvents`), and `yourRights`.
- **No signature on the manifest.** `certificate.service.js` Ed25519-signs deletion certificates
  (`getSigningKey()` from `signingKey.js`); `export.service.js` never imports `signingKey.js` or
  `node:crypto`'s `sign`. The manifest's only integrity anchor is the archive-level `contentHash`
  (SHA-256 of the whole zip, L566) recorded in the evidence row — which proves the zip wasn't
  altered **after** build, but nothing inside the package itself is signed, and (EXP-3 below) the
  archive-level hash itself goes stale the moment a second package is built for the same request.
- **README.txt** (L524-554): plain-language restatement of what's included/excluded and the
  30-day/single-use terms.
- **Where it's written**: `storagePath = \`dsar/${dsarRequestId}/package.zip\`` (L557) — **fixed
  per request, not per build**. This is the root of Finding EXP-3.
- **Sealing**: `writeFile(storagePath, archive, { scope: 'export', scopeId: dsarRequestId })`
  (L561) mints a **fresh** per-package DEK every call (`keyFor()` in `storage.js:81-82`: scope
  `'export'` with no `wrapped` passed in ⇒ `createExportKey()`, always new). The wrapped (KEK-sealed)
  DEK is returned and stored **only** in that build's own `DsarEvidence.payload.wrappedKey`
  (L585) — nowhere else. This is exactly the crypto-shred design the file's comment describes
  (L558-560), and it is sound **for a single build**. It does not anticipate a second build at the
  same path (EXP-3).
- **Evidence row** (`dsarEvidence.create`, L572-595): `kind: 'EXPORT_PACKAGE'`, `contentHash`,
  `storagePath`, and a `payload` carrying `tokenHash` (never the raw token), `wrappedKey`
  (base64), `expiresAt`, `consumedAt: null`, `sizeBytes`, `fileCount`, per-type included/excluded
  counts, and the full `selection` descriptor. This row is permanent (never deleted) and is what
  `GET /dsar/evidence` and `GET /dsar/:id/timeline` read to answer "what packages exist for this
  request" — see EXP-3 for why its claims can silently stop being true.
- **Audit**: `writeAuditLog({ action: 'ACCESS_PACKAGE_BUILT', ... })` (L597-608), separate from
  `AccessEvent` (which fires later, at download time).
- **Return to caller**: `{ evidenceId, token (raw, once), expiresAt, contentHash, sizeBytes,
  selection }` (L611-618). **This is the only place the raw token ever exists in memory or in a
  response body.** The admin route (`dsar.routes.js:260-274`) returns this JSON directly to
  whichever admin called `POST /:requestId/package` — meaning **the token that unlocks the
  package is handed to the admin who built it**, not only to the subject (see EXP-4).

### Token semantics — build-time token vs. re-issued token

- **Build-time token** (`buildAccessPackage`, above): 32 random bytes, base64url, hashed with
  SHA-256 (`tokenHash`, L34-36) before storage. Returned raw exactly once, in the build response.
- **Re-issued token** (`issuePackageToken(dsarRequestId, subjectId)`, L636-687): subject-only
  (called from `meRoutes.post('/dsar/:requestId/package-token')`, `me.routes.js:198-205`, which
  sits behind `requireSubjectAuth`, `me.routes.js:20`). Ownership check is `request.subjectId !==
  subjectId` (L642-644) — **it does not check `request.type`**, so it works identically for an
  `ACCESS` request and for a `CORRECT`/`GRIEVANCE` "handler's working copy" (EXP-4). It looks up
  the **most recently created** `EXPORT_PACKAGE` evidence row for the request
  (`orderBy: { createdAt: 'desc' }`, L647-649) — always the latest build, never a specific one
  (EXP-3). Refuses if `payload.shreddedAt` is set (410) or the **build-time** `expiresAt` has
  passed (410, L653-657) — a re-issued token cannot outlive the original 30-day boundary, only
  fall short of it via its own shorter `REISSUE_TTL_MINUTES` (default 15, L624). Overwrites
  `tokenHash` and clears `consumedAt` on the evidence row (L663-676) — so **minting a new token
  makes the previous token permanently invalid**, whether or not it was used (its hash is
  discarded).

### Download — `downloadPackage(dsarRequestId, token, { req, subjectId })` (L697-751)

Order of checks, all confirmed live below:
1. Look up the **latest** `EXPORT_PACKAGE` evidence row for the request (L698-701) — same
   "latest wins" pattern as token issuance.
2. **Ownership**, if `subjectId` is supplied by the caller (it always is, from `me.routes.js:185`):
   `request.subjectId !== subjectId` → 403 (L704-707). **This check runs before the token is
   even looked at.**
3. **Token match**: `timingSafeEqual` over the SHA-256 hashes, constant-length-checked first
   (L710-721) → 403 on any mismatch (including a token minted for a since-superseded evidence
   row, since `expected` is always the *current latest* row's hash).
4. **Single-use**: `payload.consumedAt` set → 410 (L722).
5. **Expiry**: whichever of `payload.expiresAt` / `payload.tokenExpiresAt` is set and in the past
   → 410 (L723-728).
6. **Mark consumed** (`consumedAt` written) **before** the blob is opened (L730-733) — the file
   comment states this is deliberate: a clicked link is spent even if the download then fails.
7. **`recordAccess` (`AccessEvent`) is written here** (L736-743), `objectType: 'DSAR_PACKAGE'`,
   `action: 'DOWNLOAD'`, `dsarRequestId` — **after** steps 1-5 all pass, meaning a failed
   attempt (wrong owner, bad token, already-consumed, expired) leaves **no `AccessEvent` at all**
   (Finding EXP-5).
8. Read and return plaintext bytes (`readFile(evidence.storagePath, { scope:'export', scopeId,
   wrapped: payload.wrappedKey })`, L745-749) — unsealed server-side; the client receives a
   normal (unsealed) ZIP, confirmed by magic bytes below.
9. `filename: \`prism-data-${dsarRequestId}.zip\`` — **not versioned by evidence id**, so a
   re-downloaded/re-issued link for the same request always produces a file with the same name
   even though its contents can differ build to build (EXP-3).

### Expiry sweep — `expirePackages(now)` (L755-778)

Runs from `retention.worker.js:6,247` (confirmed wired in, not dead code). Iterates **every**
`EXPORT_PACKAGE` evidence row with a non-null `storagePath` (no distinct-by-`storagePath`), shreds
the file the first time an expired row's path is reached, and marks `payload.shreddedAt` +
drops `wrappedKey`. Because multiple evidence rows can share one `storagePath` (EXP-3), this loop
calls `shredFile` on the same path multiple times across a sweep — harmless (idempotent overwrite)
but wasted work, and a sign that "one evidence row = one distinct package" is an assumption the
rest of the file (this function included) does not actually hold.

---

## Part 2 — building and downloading a real package for DSAR `5a13e5a1-9fe6-46c1-9a56-55e0dd64b377`

### 2a. The request itself (OBSERVED, direct Prisma read)

```
REQUEST 5a13e5a1-9fe6-46c1-9a56-55e0dd64b377
  subjectId: de351590-aea7-457a-a784-2241dcf2fc66
  type: CORRECT        status: RECEIVED       createdAt: 2026-07-30
SUBJECT de351590...
  fullName: "niga"   email: nikhilgaur1022@gmail.com   phone: 121212121
```

Type is `CORRECT`, not `ACCESS` — per Part 1, a package built on it is, by the code's own
description, "a handler's working copy," not a §11 self-service deliverable. Four
`EXPORT_PACKAGE` evidence rows already existed for it (built 2026-08-05, before my session),
all sharing `storagePath: dsar/5a13e5a1.../package.zip`:

| evidenceId | createdAt | selection | fileCount | sizeBytes | consumedAt |
|---|---|---|---|---|---|
| `82c098cb…` | 07:04:18 | `ALL`, 43 photos | 45 | 23,931,642 | null |
| `d0c03cca…` | 07:05:35 | `SELECTED`, 0 items | 2 | 3,458 | null |
| `a9bce945…` | 07:05:49 | `SELECTED`, 0 items | 2 | 3,458 | null |
| `097d1d1e…` | 07:05:53 | `SELECTED`, 0 items | 2 | 3,457 | null |

### 2b. Finding EXP-1 (P0) — building a fresh package for this exact request crashes with a 500 (and this is a data-layer bug that also breaks recording playback — confirmed in "What I could not check", not left as an inference)

OBSERVED. Logged in as `dataadmin@prism.local` (fresh cookie jar,
`scratchpad/em.da.txt`), then:

```
$ curl -s -b em.da.txt -c em.da.txt -X POST \
    http://localhost:4000/api/v1/dsar/5a13e5a1-9fe6-46c1-9a56-55e0dd64b377/package \
    -H 'Content-Type: application/json' -d '{"selection":"ALL"}' -w '\nHTTP_STATUS:%{http_code}\n'

HTTP_STATUS:500
{"error":"\nInvalid `prisma.recording.findMany()` invocation:\n\n\nError converting field
\"mimeType\" of expected non-nullable type \"String\", found incompatible value of
\"null\".","correlationId":"dc461d19-fe89-4872-9ee6-e799f164e2aa"}
```

Root cause, traced with a raw SQL read (Prisma's typed client can't return the row at all, so a
`$queryRawUnsafe` was needed to see it):

```sql
SELECT id, session_id, mime_type, status, redacted_path FROM recordings
WHERE EXISTS (SELECT 1 FROM audio_segments s WHERE s.recording_id = recordings.id
              AND s.subject_id = 'de351590-aea7-457a-a784-2241dcf2fc66')
```
```
{ id: '3756c42d-7bab-4819-8204-49238174b41c', session_id: '139dcdc2-...',
  mime_type: null, status: 'REDACTED',
  redacted_path: 'sessions/139dcdc2.../audio/3756c42d....redacted.wav',
  created_at: 2026-08-19T04:20:44.066Z }
```

```sql
SELECT column_name, is_nullable, column_default FROM information_schema.columns
WHERE table_name='recordings' AND column_name='mime_type'
→ { is_nullable: 'YES', column_default: null }
```

Six `recordings` rows in the live table have `mime_type IS NULL` at the database level, even
though `prisma/schema.prisma:1349` declares `mimeType String @default("audio/wav")` — a
non-nullable Prisma type. **The database schema has drifted from the Prisma schema**: the column
is genuinely nullable with no default at the Postgres level, so a null can and did get written
(`recording.service.js:176` does `mimeType: file.mimetype`, which inserts whatever the upload's
`Content-Type` was, including `null`/`undefined` if the client omitted it — the DB accepted it
silently because the constraint isn't actually enforced there). The offending row is from
**2026-08-19**, four days after this DSAR's four earlier evidence rows were built (2026-08-05),
which is exactly why the earlier builds succeeded and every build attempted **from now on**
fails.

**This is not scoped to `selection`.** `buildAccessPackage`'s `Promise.all` (L132-230) fetches
**every** recording the subject speaks in unconditionally, before `selection` is ever consulted —
confirmed by reading the code (Part 1) and confirmed live: the crash reproduces identically
regardless of `selection: 'ALL' | 'SELECTED' | {itemIds} | {filter}`, because the query that
throws runs before any of those branches. **Every future DSAR package build for this subject —
ACCESS, CORRECT, GRIEVANCE, any type — is permanently broken until either the null `mime_type`
rows are backfilled or the query/mapping is made to tolerate a null.** For a platform whose
flagship requirement is "project-wide download," a single malformed row silently breaks the
per-subject export it's built on top of, with a raw Prisma stack trace as the only signal
(`correlationId` in the response, nothing surfaced anywhere else) — no alert, no admin-facing
banner, nothing in `/health` or `/health/deep`.

**Fix**: two independent layers, both needed —
1. Data: backfill `mime_type` for the 6 null rows (they have real files on disk with real
   extensions inferable from `redactedPath`/`storagePath`), and add the missing `NOT NULL
   DEFAULT 'audio/wav'` constraint at the Postgres level via a migration, so schema drift like
   this cannot recur silently.
2. Code: `export.service.js`'s recording select should not request a field the schema declares
   non-nullable if the database can hand back null — either `select` a nullable-safe read (raw
   SQL / `Prisma.validator` workaround) or coalesce at read time; more robustly, `extensionFor()`
   (`recording.service.js:52-53`) already does `String(mimeType).toLowerCase()`, i.e. it already
   tolerates `undefined`/`null` turning into the `'bin'` fallback extension — the crash is purely
   in Prisma's response deserialization, not in application logic, so the fix belongs in the
   query/schema layer, not in `extensionFor`.

### 2c. Finding EXP-2 (P0) — a genuinely stale evidence row silently overwrites a real, larger package, and the earlier evidence's own key can no longer open it (empirically proven)

This surfaced while working around EXP-1 to satisfy the task's "download a real package" ask.
Since the ALL-selection build for `5a13e5a1` is permanently blocked, I instead minted a download
token for the request's **existing** (pre-built, 2026-08-05) evidence and downloaded it — which
is exactly the workflow a real subject would use from `SecureInbox.jsx` (module code aside, see
Part 4).

OBSERVED — refreshed a pre-existing subject session for `de351590...` from
`scratchpad/subj.A.txt` (refresh token still valid, `POST /auth/subject/refresh` → 204):

```
$ curl -s -b em.subjA.txt -X POST \
    http://localhost:4000/api/v1/me/dsar/5a13e5a1.../package-token
{"token":"MrlQ4yenXdFXPwCb37HoOuT2jOoN56TPPXCTJsoZC8k","expiresAt":"2026-08-20T19:35:41.403Z",
 "sizeBytes":3457}
```

**`sizeBytes: 3457`** — the token was minted against the **latest** evidence row (`097d1d1e…`,
the third empty `SELECTED` build), not the 23.9 MB / 43-photo `ALL` build (`82c098cb…`) that is
still a live, unexpired, unconsumed evidence row promising 43 photos. This matches Part 1's
description of `issuePackageToken`'s "always latest" lookup exactly.

Downloaded it:

```
$ curl -s -b em.subjA.txt \
    "http://localhost:4000/api/v1/me/dsar/5a13e5a1.../package?token=MrlQ4y..." \
    -o pkg1.zip -D pkg1.headers.txt -w '\nHTTP:%{http_code}\n'
HTTP:200
Content-Disposition: attachment; filename="prism-data-5a13e5a1-....zip"
Content-Length: 3457
```

```
$ file pkg1.zip
pkg1.zip: Zip archive data, made by v2.0, extract using at least v2.0,
last modified Sun, Aug 05 2026 07:05:52, uncompressed size 21749, method=deflate
$ xxd -l 16 pkg1.zip
504b 0304 1400 0008 0800 ba38 055d 3a49   PK.........8.]:I
```

A real, standard `PK\x03\x04` ZIP — confirms the lead's observation that the wire copy is unsealed
plaintext (the `PRSM`-sealed envelope in `storage/media/` is a rest-only property; `downloadPackage`
correctly unseals before sending, L745-749). Unzipped:

```
manifest.json (21749 bytes)   README.txt (708 bytes)
```
```json
{
  "version": 2,
  "selection": { "mode": "SELECTED", "markedItems": 0, "complete": false, "itemCount": 0,
                 "excludedCount": 43, "excludedBySelection": 43 },
  "photosCount": 43
}
```

**Zero photo bytes in the archive.** `photos[]` has all 43 entries, every one
`"reason": "NOT_SELECTED — outside the selection this package was built for"`. This is what the
subject actually receives today if they click "Download my data" on this request: an empty shell
listing 43 photos it explicitly refuses to include, while the DPO's evidence vault still shows a
`82c098cb…` row claiming "DPDP §11 access package… 43 items… 23.9 MB" that **cannot be reached by
any token, from any principal, through any route** — its own token was superseded the moment the
second build ran (its `tokenHash` was never invalidated explicitly; it's just that
`downloadPackage`/`issuePackageToken` never look at anything but the newest row).

**Proved the underlying bytes are actually gone**, not merely unindexed — called
`storage.js:readFile()` directly (read-only, no write) against the on-disk path using the **first**
evidence row's own recorded `wrappedKey`:

```
$ node --env-file=.env <script calling readFile('dsar/5a13e5a1.../package.zip',
    { scope:'export', scopeId:'5a13e5a1...',
      wrapped: Buffer.from('ASGEEyjFxh1FuqkRHs6CYgXLkToEXi79V+lcZanIRCTIf4Mt4l57o116n2cVJpts0bhPe2YyrJ2F0/xn4A==','base64') })>

FAILED AS EXPECTED: Blob was sealed with keyId 4077fd3f42b28f9f but key 7a1e8f85fedb2152 was supplied
```

This is definitive: the ciphertext currently on disk at `dsar/5a13e5a1.../package.zip` was sealed
under `keyId 4077fd3f...` (the fourth build's own fresh DEK), not `7a1e8f85...` (the first build's
DEK, still sitting in evidence row `82c098cb…`'s `payload.wrappedKey`). **The first package's
bytes were physically overwritten by the second build, and there is no way — none — to recover
them.** `expirePackages()` will, in 15 days, mark that evidence row `shreddedAt` for a file it
never actually held; the DB will have "confirmed shredded" a package that was silently destroyed
weeks earlier by an unrelated write, and the row's own `contentHash` (recorded as
`e0880f7513674d17...`) will forever assert a hash that matches nothing that has existed on disk
since 07:05:35 that same morning.

**Why this happens (Part 1, L557)**: `storagePath = \`dsar/${dsarRequestId}/package.zip\`` is
keyed **only** on the request id. Every `POST /:requestId/package` call for the same request —
whether triggered by the "Package marked items" button, the "Package everything" button, a retry
after a timeout, or a double-click — writes to the exact same path. Nothing checks for or blocks
a concurrent/repeat build; nothing versions the filename; nothing invalidates the stale evidence
row's claims once superseded.

**Fix**: make the storage path unique per build, not per request —
`dsar/${dsarRequestId}/${evidenceId}.zip` (the evidence row's own id is already minted before the
write and is a UUID, guaranteed unique) or a timestamp/build-counter suffix. This is a small,
surgical, low-risk change: `writeFile`'s call site (L557, L561) and `readFile`'s call site
(L745) both already thread `evidence.storagePath` through, so no other code needs the path format
to be predictable. Pair it with either (a) a hint in the evidence-vault UI that an older row is
superseded, or (b) actively shredding the previous build's file when a new one for the same
request completes, so storage isn't silently duplicated per request (each additional accidental
click currently otherwise costs nothing to storage under the *current* code purely by accident of
overwriting, but would start costing real disk under the fix — needs the sibling policy "at most
one live `EXPORT_PACKAGE` per request, older ones auto-shredded on new build").

### 2d. Empirical EXIF proof on the actual bytes the export path ships

Since `5a13e5a1` cannot currently produce a photo-bearing package (EXP-1), I read the **exact**
bytes `export.service.js:275`'s `readFile(photo.redactedPath)` would push into the archive for one
of this DSAR's own 43 linked photos, and ran the same `sharp` check the lead used at ingest — this
time on an artifact one hop from an actual DSAR delivery, not on a synthetic ingest test:

```
$ node --env-file=.env -e "<readFile('sessions/04f886f4.../redacted/e3f1c84e....jpg') via storage.js, then sharp(...).metadata()>"

bytes: 320599
first16hex: ffd8ffdb004300030202020202030202        # plain FFD8 JPEG SOI, not PRSM-sealed
METADATA {
  "format": "jpeg", "width": 1920, "height": 1080,
  "hasExif": false, "hasIcc": false, "hasIptc": false, "hasXmp": false
}
```

**Confirmed on the literal object type an export package ships**: the redacted derivative that
`photos/${photo.id}.jpg` in every DSAR archive is built from carries zero EXIF/ICC/IPTC/XMP.
Cross-checked against the code: `export.service.js` (778 lines, full read) contains **no** `sharp`
import, **no** `.withMetadata(` call, and **no** reference to `exif`/`xmp`/`iptc` anywhere — the
package-build path does not touch image bytes at all beyond `readFile`/`Buffer` handling and
`sha256`. So even setting aside that ingest already strips metadata (lead's finding), **the export
path itself has zero mechanism to add any**, even if a future fix restored EXIF at ingest. Any
metadata-stamping fix has to land in this file, not rely on ingest alone (matches lead's M-3).

---

## Part 3 — export integrity holes

### EXP-3 — storage-path collision / stale-evidence overwrite

Covered in full in 2c above. **Severity P0**: this is not a theoretical race — it is the current,
reproducible, deterministic state of a real DSAR request's evidence trail, hit by ordinary use of
the two "Package…" buttons on `DsarRequestDetail.jsx` (any second click on either button for the
same request reproduces it).

### EXP-4 (P1) — the "handler's working copy, not for subject download" rule is enforced only by UI omission, not by the API

`export.service.js:119-126`'s own comment states a `CORRECT`/`GRIEVANCE`/etc. package is
"a handler's working copy" and, by implication, not a subject-facing deliverable the way an
`ACCESS` package is. **Nothing in `issuePackageToken` or `downloadPackage` checks
`request.type`** — both check only `request.subjectId === callerSubjectId` (L642-644, L704-707).
Proved live in Part 2c: request `5a13e5a1` is `type: CORRECT`, and the subject nonetheless
successfully minted a token and downloaded the package for it through the ordinary `/me` routes,
using nothing but their own valid session — exactly the same call a legitimate `SecureInbox.jsx`
click makes.

The only place `type === 'ACCESS'` is actually checked is client-side, in
`user-portal/src/pages/SecureInbox.jsx:97` (`items.filter(r => r.status === 'CLOSED' || r.status
=== 'REJECTED')`) and `:146` (`r.status === 'CLOSED' && r.type === 'ACCESS'` gates whether the
`PackageDownload` button even renders). **This is textbook security-in-the-client**: the
restriction the code comments describe as intentional policy is not reachable by any means except
"the official web app happens not to draw a button for it." A subject who knows (or has ever seen,
in a network tab, in an old bookmark, in a saved `curl` command) their own `CORRECT`/`GRIEVANCE`
request id can pull a "handler's working copy" package directly, at any point in the request's
lifecycle — including mid-triage, before a DPO/handler has reviewed or approved anything for
release. Given `buildAccessPackage` builds identically-shaped `photos[]`/`recordings[]` manifests
regardless of type, the *content* isn't more sensitive than an ACCESS package would be — but the
**workflow guarantee** ("nothing goes to the subject until a handler decides it should," which is
the entire reason `SecureInbox` gates on `CLOSED`) is not actually a guarantee.

**Fix**: `issuePackageToken` and `downloadPackage` should both require `request.type === 'ACCESS'`
**and** `request.status === 'CLOSED'` (or an explicit `releasedForSubject` flag set by whatever
action moves a request to `CLOSED`), matching what `SecureInbox.jsx` already assumes is true.
Non-ACCESS packages should get a distinct evidence label enforced server-side (not just in the
`label` string, L576-579) so the two categories can never be confused.

### EXP-5 (P2) — failed download attempts leave no `AccessEvent`

Confirmed by code (Part 1, step 7) and live: after the 410 (already-consumed) and 403
(wrong-principal) attempts below, `AccessEvent` was queried and holds exactly **one** row for
`objectType='DSAR_PACKAGE', dsarRequestId='5a13e5a1...'` — the single successful download, not the
subsequent failed re-download or the cross-subject attempts:

```
$ curl -s -b em.subjA.txt ".../me/dsar/5a13e5a1.../package?token=<already-used>"
{"error":"This download link has already been used"}          HTTP:410
$ curl -s -b em.subjB.txt -X POST ".../me/dsar/5a13e5a1.../package-token"
{"error":"This request belongs to another data principal"}    HTTP:403
$ curl -s -b em.subjB.txt ".../me/dsar/5a13e5a1.../package?token=aaaa..."
{"error":"This package belongs to another data principal"}    HTTP:403
```
```
$ <query accessEvent where objectType='DSAR_PACKAGE' and dsarRequestId='5a13e5a1...'>
[ { id: '46394cef...', actorType: 'SUBJECT', actorId: 'de351590...', action: 'DOWNLOAD',
    createdAt: '2026-08-20T19:21:14.011Z' } ]     ← only 1 row, the successful GET
```

A repeated-use attempt on an already-spent link, or a wrong-principal probe, is exactly the
signal a DPO investigating a leaked download link would want in the ledger — and it is invisible.
**Fix**: call `recordAccess` (with `action: 'DOWNLOAD_DENIED'` or similar) on the rejection paths
too, not only on success — mirrors the lead's P-3 finding that the ledger is already hard to read
past its newest 200 rows; this compounds it by never writing some of the most security-relevant
rows at all.

### EXP-6 — manifest schema drift within one request's own evidence trail (P3, noted for completeness)

The package downloaded in 2c carries `"version": 2"` in its manifest. `export.service.js:430`
currently stamps `version: 3`. Nothing reads or checks this field on download (no
version-compatibility gate exists), so it's inert today — but it demonstrates that a request's
evidence history can span manifest schema versions with no migration or even a warning, which
will matter the day a consumer (a compliance tool, a script parsing exported manifests) is written
against "the" schema.

### Confirmed sound, live (no praise — stated as verified fact, not a finding)

- **Single-use is enforced**: a second `GET` with the same consumed token returns 410 (2c/EXP-5
  transcript above).
- **Cross-subject access is blocked** at both `package-token` mint and `package` download, and the
  ownership check runs before the token is even inspected (Part 1 step 2) — the 403 message does
  not distinguish "wrong owner" from "bad token," which is the right behaviour (no oracle for
  guessing valid request ids).
- **Resumability**: `me.routes.js:179-193` sends the whole buffer with `res.type('application/zip
  ').send(buffer)` — no `Accept-Ranges`, no `Content-Range` handling, unlike the recording
  streaming path (`recording.routes.js:212` `sendAudioWithRange`, which does support Range).
  **A dropped connection on a large download restarts from zero**, and there is no code path that
  could resume even in principle, since the single-use token is already consumed by the time the
  first byte left the server (Part 1 step 6 fires before step 8's `readFile`). This directly
  compounds with the lead's S-1 finding: once project-wide export exists and packages can run into
  GB+, an interrupted download is not just slow to retry, it is impossible to retry with the same
  link — a second attempt needs a freshly minted token from scratch.

---

## Part 4 — designing the project-wide export that does not exist

Confirmed (lead's E-1, and independently re-confirmed against the same 156-route enumeration):
`project.routes.js` exposes only `/:projectId` CRUD, `/submit|/approve|/reject|/close`, and
`/assignments|/sessions|/handoffs|/report`. Nothing returns media. `admin-portal/src/lib/api.js`
has no `export`/`download`/`package` call outside the three DSAR ones. This section is the design
for the missing route, informed by everything above.

### Route and method

```
POST /api/v1/projects/:projectId/export           → { jobId }              (kick off async job)
GET  /api/v1/projects/:projectId/export/:jobId     → { status, progress, downloadUrl? }
GET  /api/v1/projects/:projectId/export/:jobId/download   (single-use, resumable, streamed)
```

Async by construction — see "why async" below. Mirrors the existing `PurgeJob` shape
(`createPurgeJob`/`executePurgeJob`/`getPurgeJob` in `purge.service.js`) closely enough that the
same polling/progress UI pattern the admin portal would need for purge jobs can be reused for
export jobs.

### RBAC

Existing role vocabulary in this codebase (from `requireRole` call sites across `dsar.routes.js`,
`project.routes.js`): `dpo`, `dataOwner`, `dataAdmin`, `super_admin`, plus a separate
`collectionAgent`/`agent` principal type that never appears in any privileged route. Recommend:

- **`dataOwner`, own project(s) only** — a Data Owner already owns `/projects/:id/sessions`,
  `/report`, `/handoffs` for their own project(s); this is the natural extension of their existing
  surface, and `ProcessedData.jsx` (the screen the lead identified as "the natural home for this")
  is already a Data Owner page. Ownership check should mirror whatever currently scopes
  `GET /projects/:id/sessions` to the caller's own projects (not audited in this pass — flag for
  the next session to confirm that scoping actually exists and isn't role-only).
- **`dataAdmin`, `super_admin`** — cross-project, same floor as `POST /dsar/:id/package` today.
- **`dpo`** — read-only visibility into export jobs (list/status), not a trigger, matching their
  role everywhere else in this codebase (oversight, not operation) — same pattern as `dpo` being
  excluded from `POST /:requestId/execute` today (`dsar.routes.js:220`, `dataAdmin`/`super_admin`
  only).
- Every export **must** be logged as its own `AccessEvent` kind (`PROJECT_EXPORT` or similar) —
  see "Audit" below — this is what would let a DPO answer "who took a whole project out, and when"
  the way `AccessEvent` already answers that question for individual DSAR packages (Part 1, step 7)
  and for redacted-photo reads (`me.routes.js:100`, `session.service.js`'s per-photo `logAccess`).

### Scope: originals vs. redacted-only

`ProcessedData.jsx`'s own comment ("Raw originals stay out of reach") already states the intended
policy; `export.service.js`'s DSAR package already implements exactly this policy for
subject-scoped exports (Part 1: only `redactedPath` is ever read, never `storagePath`). **Reuse
the identical fail-closed rule** for project export: a photo without a confirmed-clean redacted
derivative (`piiStatus` not `CLEAN`, or `redactedPath` null) is **excluded**, not degraded to the
original. This is the same rule that would have caught the lead's R-1/R-2 findings (27 PENDING
photos, one ARCHIVED session with 16 never-redacted frames) at the export boundary even if the
UI-level blockedCount bug (R-2) is never fixed — export becomes a second, independent
fail-closed gate on top of the archive/handoff transition gate the lead recommended. State this
explicitly in the manifest (reusing the existing `selection.excludedCount` /
`byType.photos.excluded` shape from the DSAR manifest) so a project export is self-describing about
what it left out, exactly as the §11 package already is.

### Consent filtering

`ProjectConsent.status` (`schema.prisma:453`, enum `ACTIVE | REVOKED | PURGED`) is the field to
gate on. A project-wide archive must join every candidate `PhotoSubject`/`AudioSegment`/`TextSpan`
through its `consentId` and drop any link whose `ProjectConsent.status !== 'ACTIVE'` — a revoked
subject's images must not appear in a project export issued after the revocation, even though
their `PhotoSubject` row itself may still exist pending the separate erasure workflow. This is a
**new** filter — `export.service.js` doesn't need it today because a subject-scoped DSAR package
only ever contains that one subject's own consented data — so it has to be designed, not copied.
Recommended shape: same per-item `included: false, reason: 'CONSENT_REVOKED'` pattern the DSAR
manifest already uses for `NOT_SELECTED`/`REDACTION_INCOMPLETE` (Part 1), so the manifest schema
for project exports is a superset of the DSAR one rather than a divergent format.

### Per-item audit

Reuse `recordAccess` (`lib/accessLog.js`) once per item actually read, the same invariant DSAR
downloads follow today ("Invariant 6: logged before the blob is opened," `export.service.js:735`)
— at project scale (thousands of items) this needs to be a **batched** write, not one `INSERT` per
photo synchronously in the request path, or the export job's own logging becomes the bottleneck
(same class of problem as the lead's P-1/P-2 per-row-aggregate findings). A `createMany` per
progress checkpoint (e.g., every 500 items) is a reasonable middle ground.

### Async job + progress + resumable download — why, and how

**Why async is not optional**: `buildAccessPackage` today is synchronous and in-memory (Part 1),
and the lead's S-1 finding already shows that breaks at 3.5-13 days of intake at the stated rate.
A project-wide export is *always* going to be larger than any single DSAR package (it's every
subject in the project, not one), so it inherits S-1's ceiling immediately and cannot ship as a
synchronous request-response the way `POST /dsar/:id/package` is today — the HTTP request would
time out (all 10 worker `fetch()` calls in this codebase already have no timeout per the lead's
finding; an export endpoint must not repeat that mistake in the other direction by blocking a
client indefinitely).

**Job shape**: model on `PurgeJob`/`PurgeJobLocation` (`purge.service.js`) — one `ProjectExportJob`
row (status: `QUEUED → RUNNING → DONE|FAILED`, `progress: {done, total}`), enqueued onto the
existing BullMQ infrastructure (`backend/src/workers/` already runs four worker types off Redis
queues — add a fifth, `export.worker.js`, rather than inventing a new job system). Resumability
at the **job** level (crash mid-build, worker restarts, continues from last checkpoint) is the
same pattern `purge.service.js`'s own doc comment already describes for purge jobs ("It is
resumable. Every location is its own row with its own status, so a crash halfway through resumes
instead of restarting," `purge.service.js:22-23`) — that exact design should be copied, not
reinvented, for export.

**Resumability at the download level** (separate concern from job resumability): once the archive
exists, serve it with `Accept-Ranges: bytes` / `Content-Range` support (the pattern already exists
in this codebase — `recording.routes.js:212` `sendAudioWithRange` — just not applied to zip
downloads anywhere, including today's DSAR download, EXP "confirmed sound" section above). This
matters far more for a project export than a DSAR package, given project exports are the case
that will actually exceed hundreds of MB routinely.

### Streaming ZIP64 writer — recommendation

The lead's S-1 already establishes `lib/zip.js` cannot be reused past 4 GiB / 65,535 entries and
must not build the whole archive in memory. Two constraints shape the choice:

1. **The sealed-at-rest guarantee is a whole-blob AES-GCM envelope** (`storage.js:100-116`,
   `sealBlob`) — there is no partial-seal/streaming-seal API today, and inventing one is exactly
   the "unsealed temp file on disk" risk `export.service.js`'s own header comment (L25-31) already
   flags as unacceptable. **Do not solve this by writing a plaintext ZIP to a temp path and sealing
   it afterward** — that recreates the exact hazard the current design goes out of its way to
   avoid.
2. Zero zip-related dependencies exist in `backend/package.json` today (checked directly) — the
   current `lib/zip.js` is dependency-free by explicit choice (its own header comment: "taking a
   transitive dependency tree to concatenate a few files would be a larger supply-chain surface
   than the format deserves").

**Recommendation**: extend `lib/zip.js` in place rather than adopting a streaming library
(`archiver`, `yazl`), for three reasons: (a) it keeps the "why no encryption/no ZIP64" reasoning
the file already documents intact and just widens the documented ceiling rather than replacing the
whole approach; (b) a streaming third-party ZIP writer is built to pipe to an HTTP response or an
fs stream — neither matches this codebase's actual write primitive
(`storage.writeFile(path, buffer, opts)`, which wants **one Buffer**, not a stream, because the
whole point is sealing one AEAD envelope over the whole object); adapting a streaming library to
buffer-then-seal anyway would spend the dependency cost and get none of its benefit;
(c) `createZip`'s local-header/central-directory logic (`zip.js:44-113`) is already correct APPNOTE
6.3.x ZIP, and ZIP64 is additive — a `zip64EndOfCentralDirectory` record plus 8-byte
size/offset fields in the local/central headers when a threshold is crossed (>4 GiB total, or any
single entry >4 GiB, or >65,535 entries), not a rewrite. Concretely: (1) build the archive to a
**bounded-memory accumulator that still becomes one Buffer at the end** — this doesn't remove the
memory ceiling, it raises the addressable *format* ceiling from 4 GiB/65,535 to the ZIP64 limits
(~18 EB / 2^32-1... practically "as much as fits in memory/disk"); (2) pair this with **splitting
the actual job into size-bounded chunks** at the job-planning level (e.g., one archive per N GB or
per N items, several `download` links per job) so no single archive-build step needs multi-GB
RAM regardless of the format ceiling. This two-part fix (format ceiling + job chunking) is more
work than swapping in a library, but it is the only option that doesn't reopen the
unsealed-plaintext-on-disk risk `export.service.js` was explicitly designed around. If a true
constant-memory streaming seal is wanted later, that requires extending `blobCrypto.js` to support
a chunked/streaming AEAD mode (e.g. per-chunk nonces with a chained MAC) — a real project in its
own right, out of scope for "make project export exist."

---

## Part 5 — designing the metadata stamp

Builds directly on the lead's M-1/M-2/M-3 (byte-level proof metadata is stripped at ingest and
absent everywhere) and Part 2d above (proof the export path has zero metadata-writing code of its
own). Design for where the lead's M-3 recommends writing it: **at export**, plus `.withMetadata()`
at ingest to stop actively destroying camera-original EXIF (both needed, per M-3's reasoning,
which is not repeated here).

### Field set (embedded in the image, pseudonymous per M-3's privacy-tension analysis)

| Field | Value | EXIF tag (JPEG, via `sharp`) |
|---|---|---|
| Project | `projectId` (UUID, not name) | `ImageDescription` (or a custom private tag) |
| Person | export-scoped `subjectRef` — **not** `subject.masterUserId` verbatim; derive a
  per-export pseudonym (e.g. HMAC of `masterUserId` keyed by `exportId`, so the same person gets a
  *different* ref in two different exports and the ref cannot be reversed without the manifest) |
  `Artist` or a custom tag |
| Export id | `evidenceId`/job id, ties the image back to one manifest | `UserComment` (structured
  JSON, same technique the lead's M-1 byte-level proof already used to confirm sharp preserves an
  arbitrary payload in this tag) |
| Consent id | `ProjectConsent.consentId` at export time | same `UserComment` JSON blob |
| Redaction state | `'REDACTED'` always (originals are never exported, Part 4) | same blob |
| Content hash | SHA-256 of the plaintext being stamped (parallels the existing per-file `sha256`
  already computed in `export.service.js:287` for DSAR packages — reuse, don't reinvent) | same
  blob |

**Never** `fullName`, `email`, or any other direct identifier — matches M-3's explicit
recommendation and this codebase's existing convention of keeping identity out of anything that
leaves the trust boundary (the DSAR manifest itself is the one place identity legitimately
appears, because it stays inside the encrypted, single-use, short-lived package — an image file
extracted from a zip and forwarded, screenshotted, or re-saved has none of those protections).

### `sharp` call shape

```js
sharp(plaintextBuffer)
  .withMetadata({
    exif: {
      IFD0: {
        ImageDescription: `PRISM export ${exportId}`,
        Artist: subjectRef,                 // pseudonymous, not masterUserId
      },
      Exif: {
        UserComment: JSON.stringify({
          v: 1, projectId, subjectRef, consentId, exportId,
          redactionState: 'REDACTED', sha256: contentHash,
          signature: /* see below */,
        }),
      },
    },
  })
  .toBuffer()
```

Confirmed against the lead's byte-level probe (M-1): this exact `IFD0`/`Exif` shape is what their
test wrote and re-read successfully with `sharp` 0.35.3 (`backend/package.json:41`) — no new
library needed, matching M-3's recommendation to prefer `sharp` over `piexifjs`/
`exiftool-vendored`. **Placement in the export path**: inside `export.service.js`'s photo loop
(L274-293, right where `readFile(photo.redactedPath)` currently returns the raw buffer verbatim)
— stamp the buffer there, immediately before `files.push(...)`, so the `sha256` recorded in the
manifest (L287) is computed over the **stamped** bytes (what actually ships), not the pre-stamp
bytes, keeping the manifest's hash meaningful.

### Tamper-evidence — signing the stamp

Reuse `signingKey.js`/the certificate pattern (`certificate.service.js`) exactly: canonicalize the
`UserComment` JSON payload (sorted keys, matching the existing canonical-JSON helper's approach,
`certificate.service.js:25-27`), Ed25519-sign it with `getSigningKey()` (**do not** mint a
separate key — reusing `DSAR_SIGNING_SEED` means one public key an auditor already has to trust
verifies both deletion certificates and export stamps), and embed the base64 signature plus the
signing `keyId` as two more fields in the same `UserComment` JSON. A verifier reads the JSON out of
`UserComment` with any EXIF tool, re-canonicalizes the fields minus the signature, and checks it
against the published public key (`GET /dsar/signing-key`, `dsar.routes.js:168-174`, which already
exists and already serves exactly this purpose for certificates — reuse the same route or add a
sibling). This gets "tamper-evident" (a modified stamp fails verification) without needing a
trusted third party or timestamp authority.

### PNG/WebP/AVIF handling

`sharp` writes EXIF on JPEG/WebP/AVIF but not PNG (lead's M-3 note, and general `sharp`
documentation knowledge — not independently re-verified this pass since the stored corpus is
100% JPEG, confirmed by the lead's S-1 file-type breakdown). For v1, scope to JPEG only — matches
the actual data (`Photo.mimeType` is `image/jpeg` for the one item independently checked in Part
2d, and the lead's whole-corpus scan found only `.jpg`). If PNG ever enters the corpus (e.g. from
a future import path), it needs `tEXt`/`iTXt` chunk writing instead — `sharp` doesn't expose
arbitrary tEXt chunk injection either, so that's a second, separate piece of work, not a
same-code-path extension; flag it explicitly as **not covered by this design** rather than
silently degrading (an exported PNG with no stamp and no warning would be a silent gap
identical in shape to the one this whole feature exists to close).

### Non-image artefacts

- **Audio** (`recordings/${id}.wav`): EXIF has no meaning for audio. WAV supports a `LIST/INFO`
  chunk (`IART`/`ICMT` etc.) for free-text metadata, or an `id3` tag can be appended (common for
  WAV via RIFF extension) — either carries the same pseudonymous JSON payload as the image
  `UserComment`. Neither is implemented anywhere in this codebase today (no WAV-metadata library
  is a dependency); this is new work, not a `sharp`-adjacent extension.
- **Video** (`video-worker` is not running per the brief's topology, and `videoAsset` count is 0
  live) — out of scope for v1 by virtue of there being no data to test against; note the same
  approach (container-level metadata atoms, e.g. MP4 `udta`/`moov` box) applies in principle.
- **Text documents** (`documents/${id}.redacted.txt`): plain text has no metadata container at
  all. The only options are (a) a sidecar file per document (`documents/${id}.redacted.txt.meta.json`)
  carrying the same pseudonymous+signed payload, following exactly the "sidecar manifest... as a
  complement" pattern the lead's M-2 already recommends for the filename-independence caveat, or
  (b) a leading comment block if the format tolerates one (fragile — depends on downstream
  consumers, not recommended). Sidecar file is the safer default and is consistent with the
  existing manifest-at-package-root pattern (Part 1) — it's one more file per document, not a
  format-specific hack per document type.

### Pseudonymous-id + manifest-mapping approach — keeping this from being a privacy own-goal

Directly implements M-3's stated resolution:
- The `subjectRef` embedded in every image is **derived, not the real id** — e.g.
  `HMAC-SHA256(masterUserId, key=exportId)`, truncated to a short token. Two different exports of
  the same photo (a DSAR package today, a project export tomorrow) yield two different `subjectRef`
  values for the same person, so a leaked image cannot be correlated across exports, and reversing
  the ref requires the per-export HMAC key, which lives only in that export's manifest (below) —
  not in the image.
- `manifest.json` — the file already present at the root of every DSAR package (Part 1) — gains a
  `subjectMap: { [subjectRef]: { masterUserId, fullName? } }` section for project exports (a DSAR
  package needs no such map, since it only ever names its own single subject, already present in
  `dataPrincipal`). **This is the one access-controlled file that carries the mapping**, exactly
  as M-3 specifies — the 5,000 images in a project export never individually carry a reversible
  identity, only the one manifest does, and that manifest sits inside the same sealed,
  single-use-token-gated, `AccessEvent`-logged download as everything else in this design (Part 4).
- Record the export itself in `AccessEvent` (Part 4's "Audit" section) so the DPIA can answer "who
  took what out, when" — completing M-3's fourth requirement.

---

## Part 6 — every download surface in both portals, checked against real routes

**Method**: grepped `download|Download` (case-sensitive both ways) across
`admin-portal/src/pages`, `admin-portal/src/components`, and `user-portal/src/pages` — not
`export`/`package` alone, since those words appear in unrelated contexts (e.g.
`PackageCheck` icon import, "packaged" in prose) that don't represent a download control.

### admin-portal — zero download controls exist, anywhere

`grep -rn "download|Download" admin-portal/src/pages admin-portal/src/components` → **one** hit
total, in `DsarRequestDetail.jsx`, and it's the informational string "Package built. The subject
can now mint a single-use download link from their own portal — nothing is sent to them from
here." (L343) — prose, not a button, not a link, not an `<a>`. Confirms and extends the lead's
E-1 finding (which checked `ProcessedData.jsx` specifically and `api.js` for `download`/`export`
calls): **the entire admin portal, all 63 files, has no download affordance for anything** — not
photos, not sessions, not evidence, not certificates, not packages. The only thing an admin can do
with a built DSAR package is watch a toast tell them the subject can now get it — there is no
route by which the admin who built it, or any admin, can retrieve the bytes themselves (confirmed
in Part 1: no `GET`-with-admin-auth package route exists in `dsar.routes.js` at all — the single
`GET .../package` route lives on `me.routes.js`, gated by `requireSubjectAuth`, which an admin
session cannot satisfy).

### user-portal — exactly one download control, and it reaches a real endpoint

| Page | Control | Reaches |
|---|---|---|
| `SecureInbox.jsx:40-48` (`PackageDownload`) | "Download my data" button | `POST
  /me/dsar/:id/package-token` then `GET /me/dsar/:id/package?token=` — **both real, both
  confirmed live** (Part 2c) |
| `Certificate.jsx` | none (view-only; no "download" string in the file) | n/a |
| Everywhere else (`DataRights.jsx`, `MyData.jsx`, `ProjectDetails.jsx`, `RequestStatus.jsx`, …) |
  no download strings found | n/a |

The one control that exists is real and functionally correct in isolation (Part 3's "confirmed
sound" list) — but it is gated by a filter (`SecureInbox.jsx:97`, `status IN {CLOSED, REJECTED}`
+ `:146` `type === 'ACCESS'`) that the backend does not itself enforce (EXP-4), and — separately —
sits behind a workflow where "package built" and "request closed" are two independent admin
actions (Part 1's `runExecute` vs `buildPackage`, `DsarRequestDetail.jsx:333-381) that can be
performed out of order or not at all, exactly as happened to the four already-built packages on
`5a13e5a1` (still `RECEIVED`, never closed, so — even setting aside that its `type` is `CORRECT`
— **none of its four built packages would ever appear in `SecureInbox` even if its type were
`ACCESS`**, because the request has never been closed). For the live data in this system today,
**zero** of the three real DSAR requests in the database are in a state (`CLOSED` + `ACCESS`) that
would show a download button to a subject through the actual UI:

```
5a13e5a1...  CORRECT   RECEIVED   ← 4 packages built, none reachable through the UI
75eae901...  ACCESS    RECEIVED   ← no package built yet; wouldn't show even if there were one
7d1f25de...  ACCESS    RECEIVED   ← same
```

---

## What I could not check

- **A real, item-populated project-wide export** — because the route doesn't exist (confirmed by
  the lead and re-confirmed here), there was nothing to build or download for Part 4; the design
  is grounded in the DSAR package's proven patterns and this codebase's own existing primitives
  (`PurgeJob`, `sendAudioWithRange`, `signingKey.js`, BullMQ workers) rather than in a working
  prototype.
- **A live, executed whole-subject `ERASE` against `runDiscovery`'s L9/L10 handling** — I read
  `discovery.service.js:412-426` (L9/L10 location generation, scoped to *all* of a subject's DSAR
  evidence via `dsarRequest.findMany({ where: { subjectId } })`, not just the request being
  purged) and `purge.service.js:519-527` (`L9`/`L10` handlers both call `shredFile`) and
  `purge.service.js:94-255` (`locationsForItems`, the **scoped/partial** erasure path, which
  never emits L9 or L10 at all). This lets me state with confidence, from code alone (**INFERRED,
  not executed live**): a full whole-subject erasure *does* eventually shred previously-built
  export packages (all of them, via every one of the subject's past DSAR requests) at *purge
  execution time* — but a scoped/partial item-level erasure *never* touches any previously-built
  package, so a photo purged from L2/L6 via a scoped delete can still sit, byte-for-byte, inside an
  already-built `EXPORT_PACKAGE` for up to the full 30-day TTL. I chose not to run an actual
  `ERASE` execution against a live subject to observe this end-to-end (create package → execute
  full erasure → attempt re-decrypt of the package's still-referenced evidence row) because it is
  a genuinely destructive, hard-to-undo action against the shared dev dataset (crypto-shredding a
  subject key is irreversible by design) and the brief's guidance is to avoid changing state
  beyond what's needed to prove a finding — the code-path evidence above is unambiguous enough
  without it. **This should be the first thing the next session verifies live**, ideally against a
  disposable seeded subject rather than one of the three real DSAR subjects in this dataset.
- **The task's literal ask ("build and download a real package… on DSAR request
  5a13e5a1…")** could not be completed as a fresh `ALL`-selection build, because that build
  crashes (EXP-1) — this crash **is** the most load-bearing finding in this report, but it means
  the "dump EXIF of the images inside" step had to be satisfied two different ways instead: (a)
  downloading the request's **existing** (pre-crash) evidence, which turned out to be empty due to
  EXP-2/EXP-3, and (b) reading the exact bytes the export code would have shipped, directly, for
  one of this same request's 43 linked photos (Part 2d) — which is the artifact-level proof the
  task asked for, just reached by a different path than "unzip the downloaded package and look
  inside `photos/`."
- **PNG/WebP/HEIC EXIF-write behaviour with `sharp`** — not independently tested this pass (no
  such files exist in the live corpus to test against, matching the lead's note); the "PNG can't
  carry EXIF via `.withMetadata()`" claim in Part 5 is carried from the lead's M-3 note and general
  `sharp` API knowledge, not re-verified byte-for-byte the way JPEG was.
- **Whether `GET /projects/:id/sessions` (or any project route) is actually scoped to "the
  caller's own project" for a `dataOwner`**, which Part 4's RBAC recommendation assumes — flagged
  explicitly in that section as unverified and left for the next session, since confirming it
  properly means reading `project.service.js`'s authorization logic in full, which is outside this
  pass's time budget once the EXP-1/EXP-2/EXP-3 chain (the highest-value findings in this domain)
  had to be chased down empirically.
- ~~Whether the six null-`mime_type` recordings (EXP-1) affect any other code path beyond
  `export.service.js`~~ — **checked, and confirmed live, not left open.** `loadRecording()`
  (`recording.service.js:144-149`) does `prisma.recording.findFirst({ where: {...} })` with no
  `select` (full-row read, `mimeType` included), feeding both `readRawRecording` and
  `readRedactedRecording` (`:685-689`, `:761-771`). OBSERVED, same recording used in EXP-1
  (`3756c42d-7bab-4819-8204-49238174b41c`, session `139dcdc2-...`, `dataadmin` session,
  fresh-refreshed cookie):

  ```
  $ curl -s -b em.da.txt \
      "http://localhost:4000/api/v1/sessions/139dcdc2.../recordings/3756c42d.../redacted"
  HTTP:500
  {"error":"\nInvalid `prisma.recording.findFirst()` invocation:\n\n\nError converting field
  \"mimeType\" of expected non-nullable type \"String\", found incompatible value of
  \"null\".","correlationId":"7d881355-6529-43a0-b273-528c1ce72230"}
  ```

  **This is the same crash, same root cause, hit through a completely different feature**: an
  agent or data owner trying to play back this recording's redacted audio in the review timeline
  gets an identical unhandled 500. EXP-1 is not an export-only edge case — it is a database
  schema-drift bug (`mime_type` nullable at the Postgres level, non-nullable in the Prisma schema,
  six live rows already null) that independently breaks **DSAR export** and **core recording
  playback** for the same six recordings, with no shared detection, no health-check coverage, and
  a raw Prisma stack trace as the only signal in both places. This raises EXP-1's blast radius
  beyond the export domain and argues for fixing it at the data/schema layer (backfill + `NOT
  NULL` constraint) rather than patching each of the ~6 call sites
  (`recording.service.js:342,543,612,688,770` plus `export.service.js:347`) individually.
