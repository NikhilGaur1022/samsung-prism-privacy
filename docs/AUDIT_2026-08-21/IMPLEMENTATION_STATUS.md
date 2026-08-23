# PRISM production-readiness — implementation status

Against the plan at `https://claude.ai/code/artifact/aeefb75c-0360-4df5-8426-ab2fd0f42e96`.
Branch `main`, starting from `8496c58`. The audit evidence the plan was built on is
in this directory (16 domain reports, ~4,600 lines).

**Nothing below is ticked on the basis of code reading.** Each line names the
artefact — a passing test, a script with output, or a measurement.

---

## Decisions carried in, not re-litigated

1. **Mobile/phones are OUT OF SCOPE.** Supported floor 1024px, design target
   1280px. The drawer-shell rebuild is CUT.
2. **Project export is REDACTED DERIVATIVES ONLY, no approval workflow.**
   `dataOwner`, own project only, via `assertOversight()`, with a mandatory
   `AccessEvent` of kind `EXPORT` — the audit record replaces the approval gate,
   so it is not optional.
3. **RLS position — STILL OPEN.** See "Open decision" at the bottom.

## Phase order was load-bearing and was followed

Export is redacted-only, and redaction leaves visible only faces with
`tagStatus === 'TAGGED'`. An export from a session whose pipeline stalled would
ship the subject blurred out, silently. So Phase 2 (pipeline) and Phase 3
(erasure) landed before Phase 4 (export), and the export builder refuses any
photo that is not terminal — twice, once at request and once at build.

---

## Phase 0 — unblock and stop the bleeding

| Finding | Change | Evidence |
|---|---|---|
| F-01 subject registration dead | `req.user.id` → `req.admin.id` in four handlers | `tests/contract/route-contract.test.js` — asserts no handler reads a request property no middleware sets |
| S-01 forged super_admin JWT | Algorithm pinned to HS256 on verify; distinct `aud`/`iss` per token family; secret strength enforced at sign AND verify; both JWT secrets rotated | `tests/security/secrets-and-tokens.test.js` — 13 tests, including forging with the old shipped default |
| S-01 preflight passed weak secrets | `isWeak()` now checks length ≥32, placeholder markers, and character diversity; `.env.example` placeholders blanked | Same suite. `isWeak` is **imported from the shipped preflight**, not re-derived |
| S-02 plaintext OTP in response | Two independent gates: `IS_HARDENED` must be false **and** `EXPOSE_DEV_OTP` must be exactly `"on"`. `scripts/preflight.js` FAILS if the flag is set in a hardened environment, so the combination cannot ship quietly | Same suite — the code is probed in a child process per case (`production` and `staging` refuse it even with the flag on; `""`, `off`, `true`, `1`, `ON` all stay shut), plus one positive case so the negatives cannot pass vacuously |
| S-02 exact-string NODE_ENV gate | `src/config/env.js` — allowlist validated at boot, refuses to start on an unknown value; `IS_PROD` / `IS_HARDENED` used at all seven sites | Same suite — `prod`, `Production`, `PRODUCTION`, `live`, `stage` all refuse to load |
| F-05 raw internal errors on 5xx | Generic message + correlation id for ≥500; `details` allowlisted by key; Prisma `meta` and worker `detail` no longer forwarded | `tests/security/upload-abuse.test.js` — asserts no libvips/BytesIO/heap-address text crosses the boundary |
| S-03 ledger accepts arbitrary strings | `middleware/uuidParams.js` — `router.param()` validation installed on every mounted router, ahead of `logAccess` | `tests/security/idor-matrix.test.js` — asserts a junk id writes **zero** ledger rows |
| S-04 IDOR on project detail + assignments | `assertAssigned()` now scopes `dataOwner` to owned projects | `tests/security/idor-matrix.test.js` — 10 tests, owner A vs owner B across every project sub-route |
| S-06 no security headers, forgeable IP | `helmet` with a `default-src 'none'` CSP; `trust proxy` as an exact hop count from `TRUST_PROXY_HOPS`; `accessLog` reads `req.ip` instead of the raw header | `app.js`; `.env.example` documents why the value must never be `true` |
| 93% of the access ledger unreachable | `nextCursor` on both ledger endpoints, `take: limit + 1` | `audit.routes.js`, `accessLog.js` |

**Gate 0** — RBAC matrix green (4/4, 167 routes classified); a subject can be
registered; a forged token is rejected; no 5xx returns an internal string.

## Phase 1 — the contracts

- **`src/lib/photoState.js`** — one `isUnresolved()` predicate, **inverted**:
  it enumerates the two terminal states (`CLEAN`, `MASKED`) and treats
  everything else as unfinished, so a new enum value fails safe. Applied at all
  nine backend sites plus the two portal screens.
  - `tests/unit/photoState.test.js` — 10 tests, every enum value
  - `tests/contract/no-enumerated-pii-states.test.js` — greps the source and
    **forbids the old form coming back**
  - `admin-portal/src/lib/photoState.test.js` — reproduces the exact live
    distribution (CLEAN 83 · PENDING 27) that used to report zero
- **`src/lib/imageMetadata.js`** — stamp field set, EXIF tag mapping, Ed25519
  signing scheme, export-scoped pseudonyms.
- **Error envelope** — `{error, code, details, correlationId}`; zod `path: []`
  fixed so field-level errors survive; both portals read `code` and `fields`.
- **Viewport floor** — 1024px declared in `UnsupportedViewport.jsx` and asserted
  by `admin-portal/scripts/check-viewport.mjs`.

**Gate 1** — decisions written down here; the predicate is in use and the grep
test forbids the old form.

Two things the first pass of this got wrong, found by running the suite end to
end rather than by reading the code:

- `dashboard.service.js` and `project.service.js` still summed the buckets by
  name — `(PENDING ?? 0) + (DEFERRED ?? 0) + (FAILED ?? 0)`. Widened to include
  PENDING, so it read as fixed, and still silently drops the next enum value
  from the one number that decides whether a project can hand anything off.
  Both now call `countBlockedFrames()`, and the grep test bans the additive
  spelling alongside the query spellings.
- `tests/unit/photoState.test.js` asserted `isUnresolved(photo(status,
  undefined))`, but the helper's default argument substituted a path for
  `undefined` — so the case it meant to cover (the column absent from a partial
  `select`) was never exercised. The assertions now build the object directly.

## Phase 2 — make the pipeline honest

| Finding | Change | Evidence |
|---|---|---|
| F-04 no worker timeouts | `src/lib/workerFetch.js` — per-service `AbortSignal.timeout()`, bounded jittered retry, per-service circuit breaker. All 10 call sites converted; `await fetch(` no longer appears in `src/` outside that module | `tests/integration/pipeline-interruption.test.js` — deadline, 503-not-500, breaker opens, breaker is per service |
| F-03 stalled jobs, no reaper | `lockDuration` set from measured worst case; `job.extendLock()` per photo; `stalled` handlers record to a new `StalledJob` table; `src/workers/reaper.worker.js` sweeps on an interval | Same suite; `npm run worker:reaper` |
| F-04 concurrent `deleteMany` race | `src/lib/advisoryLock.js` — Postgres advisory lock on `sessionId`, wrapping `processSession()` | Same suite — asserts exactly one holder under three concurrent callers |
| F-02 archived before redaction | New `SessionStatus.REDACTING`. The transaction commits tagging and moves to REDACTING; `promoteIfRedacted()` moves to ARCHIVED **and** creates the handoff only when every photo is terminal. Redaction is now **enqueued**, so a crash leaves durable jobs | Same suite — 5 tests including "a terminal status with no derivative still blocks promotion" and "promotion never moves backwards out of ARCHIVED" |
| threshold constants disagreed | `src/config/faceThresholds.js` — validated at import, ordering invariant enforced, values logged at boot | `.env` and code no longer disagree; boot log states which set is in force |

**Gate 2** — 12/12 interruption tests green. Two stuck sessions and the
unresolved photos are recoverable with `node scripts/recover-stuck-pipeline.js
--apply` (dry run verified; see "Outstanding" below).

## Phase 3 — close the erasure hole

| Finding | Change | Evidence |
|---|---|---|
| orphaned blobs defeat certificates | `src/lib/blobLifecycle.js` — `deleteRowsAndBlobs()` collects paths **inside** the transaction, before the delete, and shreds after commit. Applied at both confirmed manufacturing sites (recognition re-run; consent revocation at finalize) | `tests/integration/erasure-completeness.test.js` — 6 tests, including one asserting the collect-before-delete **ordering** |
| discovery/purge are row-based | `src/lib/storageSweep.js` — walks the **filesystem**. `findSubjectResidue()` reaches files carrying the subject id in the name (the `person-<subjectId>.jpg` cache), which no row-based walk can see | Same suite |
| purge could not reach orphans | `executePurgeJob()` runs a residue sweep and records each file as its own `L-FS` location, so the certificate covers it | `purge.service.js` |
| certificate could attest falsely | `issueCertificate()` **refuses** if a filesystem sweep returns anything, and records `filesystemSweep` in the **signed** payload | `certificate.service.js` |
| package build shipped short | All three media loops collect `missingBlobs`; the build throws 409 naming the items instead of noting a reason in the manifest | `export.service.js` |
| 265 MB backlog | `scripts/storage-reaper.js` — quarantine → grace → shred, never hard-delete on first sight; `--remediate` records the remediation as an audit row | Measured live: 1,431 files, 442 referenced, **1,167 unreferenced (284.6 MB)** |
| integrity has no checker | `scripts/integrity-check.js` — 9 checks, exit code is the answer | Run below |

**Gate 3** — the mechanism is green (6/6 erasure tests). The **data** is not yet
clean; see "Outstanding".

## Phase 4 — the two missing requirements

| Piece | Change | Evidence |
|---|---|---|
| streaming ZIP64 | `src/lib/zipStream.js` replaces `lib/zip.js`. Never holds more than one entry; data descriptors + ZIP64 extras on every entry | Verified against Python `zipfile` (`testzip()` → None) and **70,000 entries**, past the 65,535 classic limit |
| metadata stamping | `src/lib/imageMetadata.js` — signed Ed25519 stamp in EXIF `ImageDescription` + `UserComment` | `tests/integration/metadata-roundtrip.test.js` — 9 tests |
| survives renaming | asserted by rename, copy-under-another-name, and move-into-subdirectory | Same suite |
| survives the archive | extracted with real `Expand-Archive` and re-read | Same suite (verified not to fall back) |
| tamper-evident | a rewritten payload fails with `BAD_SIGNATURE` | Same suite |
| pseudonymous only | `subjectRef` = HMAC under a per-export key; asserted to contain no name, no email, at payload **and** byte level; refs differ across two exports for the same person | Same suite |
| manifest + identity map | `manifest.json` (signed, counts, named exclusions) and `subjects.json` (the one access-controlled mapping) | `projectExport.service.js` |
| project export route | `POST/GET /projects/:id/exports`, `GET .../:id`, `GET .../:id/download` | 167 routes mounted; classified in the RBAC matrix; IDOR-tested |
| consent filtering at build time | evaluated when the bytes are assembled, not when the job was queued; exclusions counted **and named** in the manifest | `projectExport.service.js` |
| unresolved-frame refusal | refuses at request **and** at build, naming the frames | Same |
| async + resumable | BullMQ job + progress; `Range` support with `206`/`416` on download | `src/workers/export.worker.js`, `project.routes.js` |
| ingest no longer strips EXIF | `.withMetadata()` added to the ingest transform | `session.service.js` |
| package retention vs erasure | archives expire on a clock, **and** `revokeExportsContaining()` destroys any archive holding an erased subject, called from the purge path | `purge.service.js`, `projectExport.service.js` |
| the UI | `ProjectExportPanel.jsx` on `ProcessedData.jsx` — build, progress, download, and the unresolved-frame refusal explained in the operator's terms | Admin portal builds clean |

**Gate 4** — the mechanism is proven at unit and integration level. A 5,000-image
end-to-end export has **not** been run; see "Outstanding".

## Phase 5 — performance, then the UI

| Finding | Change | Evidence |
|---|---|---|
| DSAR grid ~26 ms/item | Eleven aggregate queries in several sequential waves → **one batch**. Four source counts folded into one statement; five totals into one grouped scan; index check runs concurrently with the page read | Measured on the same 101-item subject: **1.31–2.87 s → 563–665 ms** at a 355 ms database round-trip |
| ↳ the cache that broke the completeness guarantee | The brief per-subject cache on the index verdict meant a row deleted behind the service's back was served as the truth for the rest of the TTL. A cached verdict is now re-checked against the live index count the totals scan already returns, and thrown away when it has moved | `tests/integration/dsar-item-search.test.js` — "a divergent index is repaired before it is served" caught this and now passes |
| memoryStorage ~500 MB/POST | Session photo upload is disk-backed; `uploadBytes()` reads either shape | `middleware/uploads.js`, `session.service.js` |
| no rate limit on data routes | `mediaReadLimiter`, `uploadLimiter`, `exportLimiter`, keyed on the principal | `middleware/rateLimiter.js`, mounted on all media/upload/export routes |
| no compression | `compression` middleware, filtered to skip already-compressed media and archives | `app.js` |
| upload limits return 500 | One shared multer error mapper: `LIMIT_FILE_SIZE`→413, `LIMIT_FILE_COUNT`→413, filter rejection→415. All five configs standardised; **the text-document route gained the fileFilter and count limit it never had** | `tests/security/upload-abuse.test.js` — 7 tests |
| no magic-byte validation | `sniffKind()` / `requireFileKind()` — a shell script labelled `image/jpeg` is a 415 at the door, not a 500 from inside libvips | Same suite |
| F-08 batch not atomic | Per-file `accepted`/`rejected` arrays; `207` on a partial batch; every entry names its file | Same suite |
| F-09 purge-job ignores parent | `getPurgeJob()` takes the parent scope and 404s a mismatch | `tests/security/idor-matrix.test.js` |
| F-10 `includeDeleted=false` returned deleted | `z.coerce.boolean()` → an explicit `z.enum([...]).transform()` | `dsar.routes.js` |
| PageHeader overflows at 820px | `flex-wrap` added, `shrink-0` dropped, `min-w-0` on the title column | `admin-portal/src/components/PageHeader.test.jsx` — 5 tests on the actual mechanism |
| below the floor renders broken | `UnsupportedViewport.jsx` — an explicit notice below 1024px | Registered in `App.jsx` |
| no CI overflow assertion | `admin-portal/scripts/check-viewport.mjs` — CDP harness asserting zero overflow at 1024 **and** 1280, naming the culprit chain, failing on a blank render so it cannot pass vacuously | `npm run check:viewport` |
| F-11 no 404s | Real 404s in both portals, keeping the authenticated shell | `NotFound.test.jsx` — 5 tests |
| F-06 `/enroll` dead end | Moved inside `RequireAuth`; the hook has a three-state return with a real error arm and a "skip for now" path | `user-portal/src/App.jsx`, `FaceEnrollment.jsx`, `Enroll.jsx` |
| actions live before their data | The two DSAR package buttons disable until the item list exists and something is selected, with the reason in the title | `DsarRequestDetail.jsx` |
| WCAG 2.5.8 pointer targets | Show-password toggle 18×18 → 44×44; three "back to sign in" links given a 44px hit area | `Login.jsx`, `AcceptInvite.jsx`, `ForgotPassword.jsx`, `ResetPassword.jsx` |
| S-05 revocation inert | `markAdminTokensInvalidBefore()` called from `resetPassword`; **admin deprovisioning surface built** (`GET /auth/admin/admins`, `PATCH .../status`, `PATCH .../role`), both revoking live access tokens; subject refresh re-checks status | RBAC matrix classifies all three; `auth-admin.service.js` |

**Gate 5** — `npm run check:viewport` was run against the live stack in headless
Chrome: **54 route×width measurements, 0 overflowing, 0 blank, 0 unmeasured —
GREEN.**

The first run of it printed GREEN over 40 measurements and a one-line
`! dataOwner: 401 — skipping this role`. Seven routes, `/processed-data` among
them — the page the new export panel lives on — were never measured, because the
harness had `owner@prism.local` and the account is `dataowner@prism.local`. Both
fixed: the address, and the skip. A role that cannot sign in now fails the gate
and names the routes it did not measure, because a green tick over unmeasured
pages is worse than no gate.

## Phase 6 — prove it

| Piece | Status |
|---|---|
| Ephemeral test database | `scripts/test-db.js` — create/drop/list/prune/run. `npm run test:ephemeral` |
| Shared-DB residue | `scripts/clean-test-residue.js`. Measured: 20 admin rows, 7 subjects, 1 session, 2 projects removable; **22 audit rows and 1 access event are not** — append-only by design, which is exactly why the ephemeral database matters |
| Route contract | `tests/contract/route-contract.test.js` — 5 tests |
| Predicate grep guard | `tests/contract/no-enumerated-pii-states.test.js` — 2 tests. Bans the query forms **and** the additive reporting form; proven non-vacuous by planting a probe |
| IDOR matrix | `tests/security/idor-matrix.test.js` — 10 tests |
| Secrets and tokens | `tests/security/secrets-and-tokens.test.js` — 13 tests |
| Upload abuse | `tests/security/upload-abuse.test.js` — 7 tests |
| Erasure completeness | `tests/integration/erasure-completeness.test.js` — 6 tests |
| Metadata round-trip | `tests/integration/metadata-roundtrip.test.js` — 9 tests |
| Interruption / chaos | `tests/integration/pipeline-interruption.test.js` — 12 tests |
| Photo state unit | `tests/unit/photoState.test.js` — 13 tests |
| Frontend | vitest + Testing Library configured; **32 tests across 5 files** |
| Responsive regression | `admin-portal/scripts/check-viewport.mjs` — **54 route×width measurements, 0 overflowing, 0 blank, 0 unmeasured: GREEN**. Covers the role nav routes only; per-record screens like `/sessions/:id`, which is where the new video panel lives, take an id and are not in the sweep |
| Integrity checker | `scripts/integrity-check.js` — 9 checks |
| Video pipeline | `tests/integration/video-pipeline.test.js` — 10 tests against the real worker |
| Backup / restore | `scripts/verify-restore.js`, rehearsed with every failure mode provoked |

**One harness bug this run exposed.** `endSession` enqueues a recognition job and
the e2e world also runs the same pass in-process. With the stack up, the
recognition worker takes the session's advisory lock first, the in-process call
returns `{skipped: 'ALREADY_RUNNING'}`, and the suite walked into finalize as
though the work had been done — failing all eleven tests with "Session is
PROCESSING". It passed whenever the workers happened to be stopped, which is why
it had never been seen. `tests/e2e/world.js` now waits for the other runner
instead of assuming the skip was a success.

**The whole backend suite, run end to end file by file on 2026-08-21, with the
queue workers stopped and nothing else touching the database:**

```
25 files · 211 tests · 211 passing · 0 failing
```

Plus **32 frontend tests** across 5 files in the admin portal, the 54-measurement
viewport gate, and preflight at 19/19. 87 of the backend tests are new.

Getting to a single clean run took four attempts, and the reasons are worth
recording because three of them were real:

| Run | Result | Cause |
|---|---|---|
| 1 | 24 files, 201/201 | workers stopped; before the video work |
| 2 | `full-lifecycle` 0/11 | **genuine harness bug** — the advisory-lock race, now fixed |
| 3 | pool timeouts | orphaned runners from killed background tasks, three suites at once |
| 4 | **25 files, 211/211** | one runner, workers stopped |

Nothing is skipped and nothing is marked pending.

Load/soak, observability, backup rehearsal and manual QA are **not** done — see
below.

---

## Outstanding — what is NOT done

Stated plainly rather than folded into a summary.

### Data remediation (mechanism ready, not executed)

These change live data, so they are left as an explicit operator action:

```
node scripts/recover-stuck-pipeline.js --apply   # 1 archived session holding an unredacted frame
node scripts/storage-reaper.js --remediate       # 1,224 orphans / 296.2 MB → quarantine
node scripts/clean-test-residue.js --apply       # 20 test admins and their rows
```

`scripts/integrity-check.js` after the workers were brought back up:

```
9 checks — 4 passed, 5 failed
[  ok  ] handoffs-ingestable              every pending handoff is fully masked
[  ok  ] no-stale-unresolved-photos       1 unresolved photo, oldest 0.3 days
[  ok  ] no-stuck-recognition-jobs        no job RUNNING over an hour
[  ok  ] relational-orphans               zero orphans across every join
[ FAIL ] orphan-blobs                     1,224 unreferenced files, 296.2 MB
[ FAIL ] dangling-references              178 rows point at a file not in storage
[ FAIL ] dsar-index-integrity             89 of 113 indexed items cannot be produced
[ FAIL ] archived-sessions-are-redacted   1 ARCHIVED session holds an unredacted frame
[ FAIL ] collected-links-have-consent     1 collected link has no consent id
```

Up from 1 of 9 at the start of this work. The three that went green did so on
their own once the reaper and redaction workers were running again — which is
the point of Phase 2: the 49-photo backlog and the 25-hour RUNNING job drained
without anyone intervening. What is left is disk and rows, not behaviour.

`--apply` was **not** run: it mutates live data and the sandbox declined it, so
it stays an operator action rather than something done quietly at the end of a
long session.

Two need a human rather than a script. `collected-links-have-consent` reports
**1** photo-subject link with no consent id on a collected (not imported) photo.
That is a frame held with no recorded lawful basis. It predates the guard in
`finalizeSession` that now refuses to write one. Attaching a basis or removing
the link is a decision, not a cleanup.

And `dsar-index-integrity` — 89 of 113 indexed items cannot be produced — is the
same shape of question. The index is claiming more than the storage holds, which
is `totals.all` overstating a completeness figure that a data subject is entitled
to rely on. Every one of those 89 is a dangling reference above; whether the
right answer is to reindex or to record 89 items as already destroyed depends on
which of them were supposed to be erased, and that is a records question.

### Not attempted

- **Load and soak.** No 5,000/day sustained run, no burst test, no 24-hour soak.
  The DSAR grid improvement is measured; nothing else is.

  One concrete thing the test runs did surface: with the full stack up — API plus
  nine workers — running the suite intermittently fails with

  ```
  Timed out fetching a new connection from the connection pool
  (timeout: 20s, limit: 20)
  ```

  **The cause was self-inflicted, and the first version of this note overstated
  it.** Killed background tasks had left orphaned test runners alive, so at one
  point three full suites were hitting the same database at once. That is not a
  production-shaped load and it does not demonstrate a production ceiling. Every
  file that failed this way passes on its own.

  What remains true, and is worth measuring rather than asserting:

  | | |
  |---|---|
  | `runDiscovery` concurrent queries | **9**, in one `Promise.all` |
  | Configured pool | `connection_limit=20`, `pool_timeout=20` |

  A DSAR discovery runs on every request detail view and every purge, and it is
  the widest fan-out in the codebase against a pool shared with the API and every
  worker. Whether that is actually a problem is a question for a load test — the
  numbers above are where to point it, not a finding in their own right.

  Deliberately **not** changed: narrowing the fan-out or raising the limit
  without measuring which is right would be a guess, and guessing at concurrency
  is how the original "26 ms per item" reading happened.

- **Running the suite with the stack up.** One genuine failure came from it: the
  advisory-lock race above, where `endSession` enqueues a recognition job and the
  e2e world also runs the same pass in-process. That is the product behaving
  correctly under contention the harness did not expect, and it is fixed.

  Until the suite runs against an isolated queue as well as an isolated database,
  stop the workers before a full run — and check for orphaned runners from
  earlier interrupted runs, which is what produced the pool timeouts above.
- **Observability.** Worker health checks, queue metrics export, correlation-id
  propagation into workers, graceful shutdown draining — not built. (The
  operator queue-health screen exists and reads live state.)
- **Key custody decisions.** The backup, restore and verify procedure exists and
  has been rehearsed (Phase 7). What is NOT decided is where `MEDIA_KEK` lives in
  production and who holds it — `docs/KEY_CUSTODY.md` §2 is still blank, and it is
  the only item here a script cannot close.
- **Manual QA and interaction testing.** The twelve user-portal pages are no
  longer unverified — they load clean, signed in, with no errors (Phase 9). What
  is still untested is *interaction*: nothing has clicked a button, uploaded a
  file or submitted a form in a browser. Real devices and a screen-reader pass
  are also still outstanding.
- **Video at scale.** Video itself is done — see Phase 8 — but every test uses a
  3-second clip. A long clip, and video under concurrent load, are untested.
- **HF_TOKEN** still belongs to a personal Hugging Face account and sits in a
  developer `.env`. Deployment-phase item.
- **Dead-code removal** (the never-started Phase 3 from the previous plan).

### Open decision

**Settled 2026-08-21: ledgers-only, plus the IDOR matrix.** RLS stays forced on
the append-only audit tables; everything else is defended by the authorisation
layer and proven by `tests/security/idor-matrix.test.js`. That matches what the
`prism_app` least-privilege role design already implied, and it is what ships.

Full subject isolation remains available as a later, self-contained project — a
migration plus a session-variable convention plus a test per table.

---

## Migrations applied

| Migration | Contents |
|---|---|
| `20260820000001_repair_push_drift` | was left FAILED in `_prisma_migrations`; resolved as rolled-back and re-applied |
| `20260821000001_pipeline_honesty_and_blob_lifecycle` | `SessionStatus.REDACTING`, `orphan_blobs`, `stalled_jobs` |
| `20260821000002_project_export` | `project_exports` |

Both new migrations are guarded on existence throughout — this database has
already diverged once from a `db push` against an introspected schema.

## Phase 7 — backup, restore and key custody

Nothing existed here: no backup script, no restore procedure, and no document
saying where `MEDIA_KEK` should live. Losing one file on one laptop would have
destroyed every photo, face crop and recording in the system, permanently, with
no error anywhere.

| Piece | Change | Evidence |
|---|---|---|
| backup | `scripts/backup.js` — rows, the sealed media tree, checksums over ciphertext. **Refuses to run** when a key is unset, because such a backup restores into unopenable bytes and verifies clean at row level | Ran live: 44 tables, 11,093 rows, 1,540 files, 419.3 MB |
| keys are not in it | key **fingerprints** only. A backup carrying both the sealed media and the key that opens it is a plaintext copy of the whole system | `keys.fingerprint.json`; the manifest states it in the artefact itself |
| restore | `scripts/restore.js` — topological insert order derived from the Prisma relation graph, checksums verified **on the way in**, refuses a non-empty target without `--force` | Restored into a throwaway database and an empty media tree |
| verify | `scripts/verify-restore.js` — five checks, three states. A check with nothing to look at reports `--`, never a pass | See the rehearsal below |
| the un-erasure trap | an append-only erasure ledger, carried across backups and never rolled back with them. Restoring a pre-erasure backup resurrects a subject's key material and makes a signed certificate false — and nothing inside the restored database can see it | `erasure-tombstones.jsonl`; caught live, see below |
| custody | `docs/KEY_CUSTODY.md` — what is unrecoverable, where the keys must live, rotation, and the rehearsal checklist | Written. §2 is deliberately blank — it is an organisational decision |

**Rehearsed on 2026-08-21, not just written.** Every failure mode was provoked
rather than assumed:

```
wrong MEDIA_KEK supplied      -> FAIL  WRONG KEY: MEDIA_KEK
a backup file corrupted       -> FAIL  1 of 1540 corrupt or missing
real erasure, then verified   -> ok    all 1 tombstoned subjects remain destroyed
pre-erasure backup restored   -> FAIL  1 of 1 erased subject(s) CAME BACK
                                       de351590-...  erased 2026-08-21T05:44:12Z
```

The first attempt at that last one **wrongly reported clean**. `restore.js`
inserts with `skipDuplicates`, so restoring onto a database that still held the
destroyed row left it untouched and the resurrection never happened. The check
was right; the test was wrong. Two fixes came out of it: the rehearsal restores
into a genuinely empty target, and `restore.js` now reports inserted and skipped
rows separately — "11,093 rows restored" was true of the file and false of the
database.

**Not done:** §2 of the runbook. Where `MEDIA_KEK` lives in production and who
holds it is a decision, not a script.

## Phase 8 — video

The decision was to keep video in v1, fully proven. What that turned out to mean:
**every piece existed and none of it was connected.**

The service layer had `analyzeVideo`, `redactVideos`, `countDeferredVideos` and
`rebuildRedactedVideoForRemaining`. The schema had `VideoFaceTrack.clusterId`
pointing at the same `FaceCluster` a photo face uses, plus `videoTrackCount` and
`repTrackId` on the cluster, and a `VideoSubject` consent link table. `DataItemType`
had a `VIDEO` member whose own comment asserted that the capture path and the
erasure path "landed in the same change". Nothing called any of it, and that
assertion was false — there was no erasure path for video at all.

| Gap | What it cost | Change |
|---|---|---|
| `VideoSubject` links never created | `redactVideos` builds its keep-visible set from them. With the table empty **every face in every clip fell to the blur branch — including the consenting participants the session was recorded for.** A derivative that is technically redacted and completely useless | `finalizeSession` writes them, same consent gate, same dedup, same revocation rule as stills |
| promotion gate counted photos only | A session could archive holding a clip whose bystanders were never blurred, while carefully holding back an unredacted **still** of the same person in the same session | `UNRESOLVED_VIDEO_WHERE` — written in Phase 1 and never wired — now gates promotion |
| nothing called `analyzeVideo` | No clip was ever analysed | The recognition pass analyses every clip and folds its tracks into the **same** clusters as photo faces, so one person is one card across both media |
| DSAR discovery had no video query | A subject tagged in a clip could be purged, certified, and told their data was destroyed with their face still in the footage | Four new location codes — `VLINK`, `TRACK`, `L20`, `L21` — with purge handlers, in a phase order where the link dies before the rebuild reads it |
| the item index had no video | A clip never appeared in a subject's "my data", so the completeness figure understated what was held | `video_subjects` walked, keyed on the link; `sourceLiveCount` updated in the same change so the divergence detector cannot go permanently red |
| cluster merge orphaned tracks | `clusterId` is `onDelete: SetNull`, so merging two people silently detached their tracks — unreachable from any card, PENDING forever, blurring someone out of their own footage | Tracks move to the target before the sources are deleted |
| no way to split a video-only person | `splitFaces` takes face ids, and someone who only appears in a clip has none | `splitTracks` + route, classified in the RBAC matrix |
| no UI at all | Nothing to click | `SessionVideoPanel` (upload, status, blurred playback), video badges and captions on the tagging cards, a clip warning on the review screen before finalize |

Two bugs found by running it rather than reading it:

- **The worker's encoder probe tested the wrong thing.** `ffmpeg -encoders`
  reports what the binary was *compiled* with, and Debian's ffmpeg ships NVENC
  support whether or not there is an NVIDIA card present. The CPU image selected
  `h264_nvenc`, `/health` reported it as configured, and every single `/redact`
  died with `BrokenPipeError`. From the caller's side that is indistinguishable
  from the worker being down, so clips park as DEFERRED and sessions never
  archive. The probe now performs a real one-frame encode.
- **`docker-compose.yml` declared `volumes:` twice** on `audio-worker`. YAML
  keeps the last key, so the model cache the comment explains at length was never
  mounted — and a duplicate key makes the file unparseable to current Docker
  Compose, which had been failing `docker compose` for **every** service in it.

**Evidence:** `tests/integration/video-pipeline.test.js` — 10 tests against the
real worker with real H.264 encoding, covering the gate, analysis, the
keep-visible rule, DSAR discovery, the multi-subject re-redact rule and the item
index. Plus 13 frontend tests across `SessionVideoPanel` and the cluster-card
helpers.

**Not done:** long clips, and video under load. Every test uses a 3-second fixture.

## Phase 9 — does the UI actually work?

Everything above proved the UI *builds*, that its components pass unit tests
against mocked APIs, and that nothing overflows at 1024px. None of that is the
same as "it works", and the honest answer to "are there errors in the UI" was
"nobody has looked" — including me.

Two new checkers close that, both driving real headless Chrome over the real
running stack, signed in as real users:

| Checker | Covers | What it catches |
|---|---|---|
| `admin-portal/scripts/check-ui-health.mjs` | 27 pages × 4 roles | uncaught exceptions, console errors, HTTP ≥400, error states, stuck spinners, near-empty renders |
| `user-portal/scripts/check-ui-health.mjs` | 13 pages, signed out and signed in | the same, and it signs in through the **real one-time-code flow** rather than minting a token |

The user portal had no automated UI coverage of any kind before this. Twelve of
its pages had, on the record, never been opened by anyone.

**Both are now GREEN — but only after finding two real bugs, stacked one behind
the other.**

`/data-lineage` returned **500** on every load:

```
TypeError: Cannot read properties of null (reading 'status')
  handoff.service.js:168   consentStatus: l.consent.status
```

`PhotoSubject.consentId` is nullable *by design* — the schema comment says so,
for an import link where no live consent existed at ingest — and `Photo.session`
is nullable for the same reason. Both were dereferenced directly, so the page
broke the moment the database held a single imported record. It had been failing
silently: the page still rendered its shell, so the viewport sweep passed it 54
times without complaint.

Fixing the API immediately exposed a second bug underneath it, in the page that
had never successfully received data:

```
TypeError: Cannot read properties of null (reading 'slice')
  DataLineage.jsx:213     row.sha256.slice(0, 12)
```

That one crashed the whole table into the ErrorBoundary.

Neither is exotic, and both sit on the page whose stated purpose is to be *the
evidence of what a DSAR erasure walks*. Both are fixed, and the null consent
case is now surfaced as `NO CONSENT RECORD` rather than blanked — it is the same
condition `integrity-check` flags as a record held with no stated lawful basis,
and hiding it on the evidence screen would be the wrong kind of tidy.

**Still not covered by any of this:** interactions. These checkers load a page
and watch it settle; they do not click, type, upload, or submit. Uploading a
clip, tagging a face, building an export and running a purge have been proven at
the API level by 211 backend tests, but the click path through them is what the
manual walkthrough is for.

## Phase 10 — the one-time code in the UI, and the dead registration page

Testing by hand needs the one-time code, and there is no mail server. It used to
be echoed in the login response behind a bare `NODE_ENV === 'production'` string
comparison, which is finding S-02: one typo and every account in the system is
takeable over with nothing but an email address.

It is back, deliberately, behind **two** gates that must both be open —
`IS_HARDENED` false (and `NODE_ENV` is now allowlist-validated at boot, so it
cannot be defeated by a misspelling) **and** `EXPOSE_DEV_OTP` exactly `"on"`.
`preflight.js` FAILS, not warns, if the flag is set in a hardened environment,
so the combination cannot reach production quietly:

```
NODE_ENV=production node scripts/preflight.js
  [ FAIL ] EXPOSE_DEV_OTP  set to "on" in a hardened environment — remove it.
  preflight: RED
```

There are exactly two places a code is ever issued — subject login and subject
registration — and both now put it on screen: the user portal's verify banner,
and an autofill button beside each pending subject in the admin portal's
collection-agent screen.

**Wiring that up surfaced a third dead flow.** The user portal's "Create an
account" page was posting to `POST /api/v1/subjects`, which is gated to
`collectionAgent` and `super_admin` — correctly, since that router also lists and
mutates other people's identity. So every self-registration answered **401** and
the page had never worked. Twelve pages had never been opened; this one had never
been submitted.

The fix is a separate public route, `POST /auth/subject/register`, carrying only
the one anonymous-safe operation:

- `selfRegisterSubjectSchema` deliberately does **not** accept
  `registrationChannel`, `registeredByUserId` or `employeeRef` — an anonymous
  caller must not be able to stamp their own record as agent-assisted, attribute
  it to an admin who never saw them, or assert an employee reference that a
  collection agent exists to witness. The channel is set server-side. Verified by
  sending all three: the stored record came back `SELF` / `null` / `null`.
- `actorId` is `null` in the audit chain, which reads as "the subject did this
  themselves" — true, where naming a system user would not be.
- It shares the login limiters, per-IP and per-email. Separate buckets would let
  an attacker alternate between "send me a code" and "register, which also sends
  a code".
- It creates no session. The record lands `PENDING` and only becomes `ACTIVE`
  when an OTP proves the address.
- Duplicate email still answers **409**, which the page already handled.

`POST /api/v1/subjects` and `GET /api/v1/subjects` still answer 401 to an
anonymous caller; the new route is classified in the RBAC matrix, so it is not
a hole the contract test would have to be told about later.

### The gap that let it ship: nothing ever clicked anything

Phase 9's checkers load pages and watch them settle. A page that renders
perfectly and 401s on submit passes all of them. So there is now a third
checker, `user-portal/scripts/check-signup-flow.mjs`, which drives the journey
the way a person does — 9 steps, all currently green:

```
/register renders a usable form                 ok  3 inputs, submit=true
the submit button enables once filled           ok
submitting registration reaches /verify         ok
the one-time code is visible on the page        ok  code 367700
clicking the code fills the verify boxes        ok  boxes hold "367700"
verifying the code produces a signed-in session ok  landed on /enroll
no uncaught exceptions during the flow          ok
no failed requests during the flow              ok
the form does not reload the page               ok
```

It reads the code out of the **rendered DOM**, not the API response. That is the
distinction that matters: "the server issued a code" and "the person can see the
code" are different claims, and only the second one makes hands-on testing
possible.

Two of those assertions exist because writing this check produced both failures
for real. `the form does not reload the page` is there because a React form that
submits natively still fires the request and still creates the record — it looks
exactly like nothing happening, and the only distinguishing signal is the
reload. And the first run reported "stuck on /register" when the page was
simply slower than a fixed 2.5s wait; it polls now, because a checker that
reports a timing margin as a bug will be ignored the third time it does it.

Each run leaves one real subject at a fresh `@test.invalid` address — it must,
since the thing under test is that a stranger can create an account.
`npm run clean:test-residue` removes them.

## Services

All fourteen were restarted and are answering. The node processes were killed
mid-session to release the Prisma engine DLL for `prisma generate`; two of them
are new.

```
qdrant  face-worker(8001)  image-pii-worker(8002)  audio-worker(8003)
backend api(4000)  user-portal(5173)  admin-portal(5180)
worker: recognition  redaction  purge  item-action  retention
worker: reaper   (new)
worker: export   (new)
```

`.run/services.json` carries the live PIDs; every one was verified running, the
API answers `/health` 200 and both portals answer 200.

## New operational commands

```
npm run worker:reaper        # stalled-job and unresolved-photo sweeper
npm run worker:export        # project export builder
npm run integrity            # 9 integrity checks, exit code is the answer
npm run backup               # rows + sealed media + key fingerprints (never keys)
npm run restore -- --backup <dir> --target-db <url> --target-media <dir>
npm run verify:restore -- --backup <dir>   # 5 checks; abstains rather than inflating
npm run storage:reap         # orphan blob report / quarantine / purge
npm run recover              # stuck-pipeline recovery (dry run by default)
npm run clean:test-residue   # shared-DB test residue (dry run by default)
npm run test:ephemeral       # full suite against a throwaway database
npm run test:contract        # contract layer only
npm --prefix ../admin-portal run test            # frontend unit tests
npm --prefix ../admin-portal run check:viewport  # 1024px overflow gate
npm --prefix ../admin-portal run check:ui        # 27 pages x 4 roles, real errors
npm --prefix ../user-portal  run check:ui        # 13 pages, real OTP sign-in
npm --prefix ../user-portal  run check:signup    # register -> code on screen -> signed in
                                                 # all three need
                                                 # chrome --remote-debugging-port=9222
```
