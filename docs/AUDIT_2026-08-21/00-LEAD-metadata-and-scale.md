# Lead note — metadata requirement and export scale, proven at byte level (2026-08-21)

Probe script: `scratchpad/metadata-probe.mjs`, run from `backend/` against the real `sharp` build
and the real `backend/storage/` tree. Everything below is **OBSERVED**, not inferred.

---

## FINDING M-1 (P0, metadata) — ingest actively DESTROYS all image metadata

`backend/src/modules/sessions/session.service.js:249` is:

```js
const normalized = await sharp(file.buffer).rotate().jpeg({ quality: 92 }).toBuffer()
```

I built a JPEG carrying EXIF (an `ImageDescription` of `PRISM project=nikhil subject=SUBJ-12345`,
plus `Artist` and a `UserComment`) and an ICC profile, then pushed it through that exact line and
walked the resulting JPEG marker segments by hand.

**Before (2857 bytes):**
```
FFE1 APP1 (EXIF)  len=288  :: Exif..II*...
FFE2 APP2/ICC     len=496  :: ICC_PROFILE...
FFDB DQT / FFC0 SOF0 / FFC4 DHT / FFDA SOS
EXIF blob contains: "PRISM project=nikhil subject=SUBJ-12345 . PRISM . PRISM-COLLECTION"
```

**After `.rotate().jpeg({quality:92})` (2069 bytes):**
```
FFDB DQT / FFDB DQT / FFC0 SOF0 / FFC4 DHT x4 / FFDA SOS
```

**Every APPn segment is gone.** `sharp.metadata()` reports `exif=ABSENT xmp=ABSENT icc=ABSENT
iptc=ABSENT orientation=none`. sharp strips metadata on re-encode unless told otherwise, and it is
not told otherwise anywhere in this codebase.

Adding `.withMetadata()` to the same chain restores it exactly — 2857 bytes, `FFE1 APP1` and
`FFE2 APP2` both back, EXIF payload intact. So the mechanism is a one-call change; the *policy* is
the hard part (see M-3).

**Combined with the repo-wide grep** (`exif|xmp|iptc|withMetadata` over `backend/src` returns
exactly one hit, and it is a code comment on line 247 of the same file), the position today is:

> **No PRISM image, anywhere, at any stage, carries any project or person metadata. The pipeline
> removes what the camera wrote and adds nothing. The user's stated production requirement is 0%
> implemented.**

This is not a bug to patch at the export boundary alone — see M-3 for where the write has to happen.

## FINDING M-2 (confirms the approach) — embedded metadata is filename-independent

Wrote the `.withMetadata()` output to `renamed-test.jpg`, copied it to
`totally-different-name-9999.jpg`, re-read it: `exif still present: YES (286 bytes)`.

Embedding in APP1 satisfies the "must survive a filename change" clause by construction. State the
limits honestly in the plan, though — EXIF survives a rename, a copy, a move and most archive
round-trips; it does **not** survive a screenshot, a re-encode by a tool that strips (most social
platforms strip deliberately), or a format conversion through a naive pipeline. A sidecar manifest
plus a visible-watermark option are complements, not replacements.

## FINDING M-3 (P0, design) — where the write must happen, and the privacy tension

Two candidate insertion points, and the choice matters:

1. **At ingest** (`addPhoto`) — add `.withMetadata()` plus the PRISM fields.
   Problem: at ingest time **the person is not yet known**. Face matching has not run; `PhotoSubject`
   rows do not exist; a session can be re-tagged, clusters merged and split, and a subject can later
   be added or removed from a frame. Metadata written at ingest would be wrong for exactly the
   photos the requirement cares about.
2. **At export** (in the packaging path) — re-stamp each image as it is written into the archive,
   from the authoritative `SubjectDataItem` / `PhotoSubject` / project rows at that moment.
   This is correct, because export is the only point where "which project, which person" is settled.

**Recommendation: write at export, and additionally `.withMetadata()` at ingest** so a camera's
original capture data (timestamp, device, orientation) is not silently lost — that lost provenance
is itself a data-integrity gap for a chain-of-custody system.

**The privacy tension must be stated, not smoothed over.** Embedding a person's identity into an
image that then leaves the platform is *creating new personal data in a less-controlled place*, and
it directly fights the crypto-shred guarantee: once an image with `subjectId` baked in has been
downloaded, erasure cannot reach it. The resolution to put in the plan:

- Embed **pseudonymous** identifiers (`projectId`, an export-scoped `subjectRef`, `consentId`,
  `captureSessionId`, `redactionState`, `exportId`, a content hash) — **never a name or an email**.
- Ship a **manifest** inside the package that maps `subjectRef` to identity, so the mapping is one
  access-controlled file rather than 5,000 images.
- **Sign** the metadata block (the existing `DSAR_SIGNING_SEED` / `signingKey.js` machinery already
  does this for certificates) so the stamp is tamper-**evident**, which is what an auditor actually
  needs.
- Record the export in `AccessEvent` so the DPIA can answer "who took what out, when".

Library choice for Node: `sharp.withMetadata({ exif: {...} })` covers EXIF on JPEG and is already a
dependency — prefer it over adding `piexifjs` or `exiftool-vendored` (a vendored binary is a
supply-chain and packaging cost this does not need). Note the constraint that sharp writes EXIF on
JPEG/WebP/AVIF but **not PNG**; PNG needs `tEXt`/`iTXt` chunks written separately, and the stored
corpus is 100% JPEG today (see below), so JPEG-first is the right scope for v1.

---

## FINDING S-1 (P0, scalability) — the in-memory, non-ZIP64 archive cannot hold a project

Measured against the real storage tree (1,353 files):

| Group | Files | Size | Avg |
|---|---|---|---|
| `.jpg` (sealed) | 1,293 | 304.7 MB | **241.3 KB** |
| `.zip` (built export packages) | 28 | 21.9 MB | 802.7 KB |
| `.wav` | 29 | 0.3 MB | 11.8 KB |
| `.m4a` | 1 | 0.5 MB | 495.9 KB |

`backend/src/lib/zip.js` builds the whole archive with `Buffer.concat` and writes **no ZIP64
extensions** (its own header comment concedes the 4 GiB / 65535-entry scope limit). Against the
measured 241.3 KB average and the stated 5,000 images/day:

| Ceiling | Reached at | = days of intake at 5,000/day |
|---|---|---|
| 65,535-entry cap | 65,535 images | **13.1 days** |
| 4 GiB offset cap | 17,381 images | **3.5 days** |
| Heap (`Buffer.concat` of the full archive before a byte is sent) | ~2-4 GB v8 default | sooner than either, and it OOMs the API process rather than erroring cleanly |

**A project-wide download becomes impossible after three and a half days of collection at the target
rate.** And the failure mode is the worst kind: the archive is assembled entirely in the API
process's heap before the response starts, so it takes the whole API down for every other user
rather than failing that one request.

**Fix:** stream the archive. Replace `lib/zip.js` with a streaming ZIP64 writer piped straight to
the response (`archiver`, or extend the existing writer with ZIP64 + a `Readable`), never
materialising the archive. Add per-request size/entry caps with a documented split-into-parts
behaviour above them. This is a prerequisite for the project-wide export feature, which is why it
must land before the export work, not after.

## FINDING S-2 (P1, capacity) — storage growth, stated plainly

At the measured 241.3 KB/image, counting original + redacted derivative (and excluding thumbnails,
which do not exist yet — see below):

- **2.30 GB/day**
- **69 GB/month**
- **840 GB/year**

Plus audio, video and export packages. Any production sizing that assumes less than ~1 TB/year for
a single collection stream is wrong. Retention policy enforcement (`retention.worker.js`) is what
keeps this bounded and must therefore be verified as actually running, not merely present.

---

## Two things that are RIGHT, and must not be broken by the fixes

Recording these deliberately, because an audit that only lists faults misleads about the baseline.

**Encryption at rest is real and working.** All 1,293 stored `.jpg` files begin with
`5052534d 01 8a6fc4` — ASCII `PRSM` plus a version byte and a header. **Zero** start with `FFD8`.
There is no plaintext media on disk. The 28 built export packages are sealed the same way
(`5052534d 01 878648`), so a package sitting in the vault is not a plaintext ZIP either. Whatever
the metadata plan does, it must write **inside** the sealed container and must not introduce a
plaintext staging file on disk.

**The refusal UX is good.** See `00-LEAD-browser-pass.md` OBSERVED-7 — the role-refusal and
ownership-refusal screens are well written and should be preserved verbatim through the UI rework.

---

## What this note could not establish

- Whether a **project-wide** export route exists at all — the lead's earlier route enumeration found
  none (`project.routes.js` exposes `/:projectId/report` and no media route), but the
  `export+metadata` auditor was tasked with confirming that exhaustively against the live route
  table. Treat this note as the metadata/scale half; take the route inventory from that report.
- The contents of a built package: the 28 stored `.zip` files are **sealed**, so listing their
  entries requires going through `storage.js` with the right DEK rather than reading the file. The
  `e2e:live-flow` auditor was asked to build and download a fresh package through the API, which is
  the correct way to see inside one.
- PNG/WebP/HEIC behaviour — the stored corpus is 100% JPEG, so nothing on disk exercises it.
