# Deliverable 2 — Role / Permission Matrix (1 user role + 5 admin tiers)

Enforcement contract: **every rule below is enforced server-side in `requireRole` + a service-layer scope assertion.** UI hiding is never the control. Any route reachable by a role it should not be is a P0.

---

## A. Tier definitions and least-privilege justification

| Tier | Enum | Purpose (why it exists) | Blast radius if compromised | Compensating control |
|---|---|---|---|---|
| Data Principal | `Subject` (not `AdminRole`) | see + control own data | own record only | OTP, short JWT, RLS row filter |
| DPO / Legal | `dpo` | approve purposes, own SLA, audit | can approve a bad purpose; **cannot see any personal data** | pseudonymised views; approvals are audited + reversible pre-collection |
| Data Owner | `dataOwner` | define need, run project, consume dataset | own projects' redacted derivatives | no raw media, no subject PII, per-project scope |
| Collection Agent | `collectionAgent` | field capture | assigned + non-archived sessions only | `ProjectAssignment` gate, access dies at ARCHIVE |
| Data Team Admin | `dataAdmin` | execute DSAR, run ingest | high — raw media reachable | only via `dsarRequestId` binding, every object read logged, DPO co-sign on break-glass |
| Platform root | `super_admin` | break-glass, key rotation | total | 2-person rule, all actions `breakGlass=true`, alert to DPO inbox |

---

## B. Endpoint matrix

`✓` allowed · `✗` denied (403) · `⚑` allowed only with an open `DsarRequest` binding + `AccessEvent` · `†` GAP **as of the original plan** — every † row below has since been built; the marks are left in place as a record of what was missing, not as a current statement.

> This table is executable. `backend/tests/security/rbac-matrix.test.js` walks the live Express router stack and checks every mounted route against it, so a route that exists but is not classified here is a test failure rather than a silent hole.

### Governance
| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `POST /projects` † | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ |
| `POST /projects/:id/submit` † | ✗ | ✗ | ✓ own | ✗ | ✗ | ✓ |
| `POST /projects/:id/approve` † | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ |
| `POST /projects/:id/reject` † | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ |
| `GET /projects` | ✗ | ✓ all (meta) | ✓ own | ✓ assigned | ✓ meta | ✓ |
| `POST /projects/:id/assignments` † | ✗ | ✗ | ✓ own | ✗ | ✗ | ✓ |
| `GET /auth/admin/users?role=` | ✗ | ✗ | ✓ (agent picker) | ✗ | ✗ | ✓ |
| `GET/POST /consent-templates` † | read rendered | ✓ CRUD | ✓ read | ✓ read | ✗ | ✓ |
| `GET /data-types` (picker vocabulary — names no principal) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `GET /sessions/:id/videos/:videoId/redacted` (blurred) | ✗ | ✗ | ✓ own | ✓ assigned | ✓ | ✓ |
| `GET /sessions/:id/videos/:videoId/detected` (**unmasked** overlay) | ✗ | ✗ | ✗ | ✓ assigned | ✗ | ✓ |
| `GET /projects/:id/sessions` | ✗ | ✓ | ✓ own | ✗ | ✓ | ✓ |
| `GET /projects/:id/handoffs` | ✗ | ✓ | ✓ own | ✗ | ✓ | ✓ |
| `GET /projects/:id/report` | ✗ | ✓ | ✓ own | ✗ | ✓ | ✓ |
| `GET /dashboard/compliance-report` | ✗ | ✓ all | ◐ own projects | ✗ | ✓ all | ✓ |

Approval is a hard gate: `Session` creation must reject any project whose `status != APPROVED`. Today `Project.status` defaults to `ACTIVE` with no approval concept — that default must become `DRAFT`.

### Collection
| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `POST /sessions` | ✗ | ✗ | ✗ | ✓ assigned+approved | ✗ | ✓ |
| `GET /sessions/:id` | ✗ | ✗ | ✗ | ✓ own | ✗ | ⚑ |
| `POST /sessions/:id/invites` | ✗ | ✗ | ✗ | ✓ own | ✗ | ✓ |
| `POST /join/:token` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `POST /consent` | ✓ self | ✗ | ✗ | ✓ witness | ✗ | ✗ |
| `POST /sessions/:id/photos` | ✗ | ✗ | ✗ | ✓ own ACTIVE | ✗ | ✗ |
| `GET /sessions/:id/photos/:pid/raw` | ✓ own | ✗ | ✗ | ✓ own, pre-ARCHIVE | ⚑ | ⚑ |
| `GET /sessions/:id/photos` (frame index) | ✗ | ✗ | ✓ own project | ✓ own | ✓ | ✓ |
| `GET /sessions/:id/photos/:pid/redacted` | ✓ own | ✗ | ✓ own project | ✓ own | ✓ | ✓ |
| `GET /sessions/:id/photos/:pid/redacted/thumb` | ✓ own | ✗ | ✓ own project | ✓ own | ✓ | ✓ |
| `GET /sessions/:id/photos/:pid/file/thumb` | ✗ | ✗ | ✗ | ✓ own, pre-ARCHIVE | ✗ | ⚑ |
| `GET /sessions/:id/faces` (crops) | ✗ | ✗ | ✗ | ✓ TAGGING only | ✗ | ⚑ |

The `/thumb` rows are grid-sized renditions of the row directly above each of
them, and they carry the identical floor on purpose: the same object at a
smaller size is the same personal data, and a variant that were easier to reach
would be a hole rather than an optimisation. `redacted/thumb` is cached on disk
and sealed like any other object; `file/thumb` is built per request and never
persisted, because a stored miniature of an unmasked frame would outlive the
agent's basis for the original.

| `POST /sessions/:id/recordings` | ✗ | ✗ | ✗ | ✓ own ACTIVE | ✗ | ✗ |
| `POST /sessions/:id/recordings/:recordingId/analyze` | ✗ | ✗ | ✗ | ✓ own | ✗ | ✗ |
| `PUT /sessions/:id/recordings/:recordingId/segments` | ✗ | ✗ | ✗ | ✓ own | ✗ | ✗ |
| `POST /sessions/:id/recordings/:recordingId/redact` | ✗ | ✗ | ✗ | ✓ own | ✗ | ✗ |
| `GET /sessions/:id/recordings` | ✗ | ✗ | ✓ own project | ✓ own | ✓ | ✓ |
| `GET /sessions/:id/recordings/:recordingId` | ✗ | ✗ | ✓ own project | ✓ own | ✓ | ✓ |
| `GET /sessions/:id/recordings/:recordingId/raw` | ✓ own | ✗ | ✗ | ✓ own, pre-ARCHIVE | ⚑ | ⚑ |
| `GET /sessions/:id/recordings/:recordingId/redacted` | ✓ own | ✗ | ✓ own project | ✓ own | ✓ | ✓ |
| `POST /sessions/:id/finalize` | ✗ | ✗ | ✗ | ✓ own | ✗ | ✓ |

#### Audio (behind `AUDIO_CAPTURE_ENABLED`)

Capture is the owning agent's act. Reads are wider — §D gives a `dataOwner` the redacted derivatives of their own project and a `dataAdmin` the lineage — and every one of them is re-scoped inside `recording.service.js` through `loadSessionForMedia()`, so a wider role floor here is not a wider reach for any individual caller.

Audio shipped once without an erasure path: a recording was absent from `DataItemType`, so `runDiscovery()` never named it and an erasure signed a certificate while the voice data survived. **No capture route for a new modality may be mounted before its `DataItemType` value, its discovery locations and its purge handlers exist in the same change.**

| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `POST /sessions/:id/recordings` | ✗ | ✗ | ✗ | ✓ own ACTIVE | ✗ | ✓ |
| `POST /sessions/:id/recordings/:rid/analyze` | ✗ | ✗ | ✗ | ✓ own | ✗ | ✓ |
| `POST /sessions/:id/recordings/:rid/redact` | ✗ | ✗ | ✗ | ✓ own | ✗ | ✓ |
| `GET /sessions/:id/recordings` | ✗ | ✗ | ✓ own project | ✓ own | ✓ | ✓ |
| `GET /sessions/:id/recordings/:rid` | ✗ | ✗ | ✓ own project | ✓ own | ✓ | ✓ |
| `GET /sessions/:id/recordings/:rid/redacted` | ✗ | ✗ | ✓ own project | ✓ own | ✓ | ✓ |

#### Voice enrollment (behind `AUDIO_CAPTURE_ENABLED`)

A voice print is §2 sensitive personal data on the same footing as a face embedding, so it carries the same rules: capture is gated on `Subject.biometricMatch`, withdrawing that consent destroys every clip and vector through `deleteAllVoiceEnrollments()`, and erasure names them explicitly as **L16** (clip) and **L17** (embedding) rather than folding them into the face codes — a purge handler dispatches on the location code and then deletes from one specific table, so an L5 row carrying a voice id would report SKIPPED while the voice print survived.

`POST .../analyze` no longer accepts `voice_snippets`. Speaker identity comes from these enrollments, loaded into a per-recording Qdrant gallery inside the service. An agent cannot hand-feed reference audio at analyze time, and therefore cannot decide who gets kept unmuted.

**There is no agent-facing playback route, and none may be added.** A selfie can be shown back so an agent can confirm they captured the right face; an enrollment clip tells them nothing the duration does not, and a route for it would make every enrolled subject's recorded voice listenable by any agent holding the role. The principal can play back their own — that is §11 — and nobody else can.

| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `POST /subjects/:id/voice-enrollments` (agent) | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |
| `GET /subjects/:id/voice-enrollments` (metadata only) | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |
| `DELETE /subjects/:id/voice-enrollments/:eid` | ✗ | ✗ | ✗ | ✓ | ✗ | ✓ |
| `POST /me/voice-enrollments` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/voice-enrollments` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/voice-enrollments/status` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/voice-enrollments/:eid/audio` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `DELETE /me/voice-enrollments/:eid` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| **voice embedding bytes** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ — no route exists, none may be added |

### Image provenance (DPO)
| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `POST /provenance/lookup` | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ |

> **A documented exception to §A, taken deliberately.** §A says dpo "cannot see
> any personal data". This endpoint returns names and email addresses: given an
> image that has left the platform, it reads the signed export stamp back out and
> re-derives the export-scoped subject refs to say who is in the frame.
>
> The exception is scoped to the one question the role cannot otherwise answer —
> *this file turned up on a training share, whose data is it and do I have to
> notify them* — and it is bounded three ways: the candidate set is only the
> subjects still linked to that one photo, never a search; each identity resolved
> writes its own `AccessEvent` (`SUBJECT_PII` / `SEARCH` /
> `PROVENANCE_LOOKUP_IDENTIFIED`) against the administrator; and the lookup itself
> writes one more against the photo. Using the tool is as answerable as the reads
> it investigates.
>
> A ref that matches nobody is reported, not dropped: it means the person was
> erased *after* the export, so the copy in hand is data that outlived a deletion
> the principal was told was complete.
>
> **dpo is still absent from `/sessions/:id/photos` and every other session media
> read.** Tracing an image does not grant browsing the session it came from; the
> provenance page renders the session record inline instead.

### Subject / biometrics

> **§11 is a summary right, not a viewer.** `GET /me/photos` returns counts,
> purposes and consent state grouped by project — no photo ids, no session codes,
> no capture locations, no bytes. `GET /me/photos/:pid/redacted` used to serve the
> frame itself to any holder of a subject session; it was removed rather than
> narrowed, because a portal endpoint that streams material on a cookie is a
> standing read over the dataset with no review step and nothing to revoke.
> Material reaches a principal through an **ACCESS request**: data-admin review,
> DPO approval, redacted derivatives with a manifest, single-use download token.
> `rbac-matrix.test.js` fails if the route is ever remounted.

| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `GET /me` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/photos` | ✓ self — **summary only** (counts, purpose, consent) | ✗ | ✗ | ✗ | ✗ | ✗ |
| **photo bytes to a subject** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ — no route exists, none may be added |
| `GET /me/consents` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `POST /me/consents/:id/revoke` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `POST /me/enrollment` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `POST /subjects/:id/enrollment` (agent) | ✗ | ✗ | ✗ | ✓ in-session | ✗ | ✗ |
| `GET /subjects/:id` (PII) | ✓ self | ✗ | ✗ | ✓ in-session | ⚑ | ⚑ |
| **embedding bytes** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ — no route exists, none may be added |

### Handoff / dataset
| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `GET /handoffs` | ✗ | ◐ counts † | ◐ own † | ✗ | ✓ | ✓ |
| `POST /handoffs/:id/ingest` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `GET /handoffs/lineage` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `POST /exports` † | ✗ | ✗ | ✓ own project | ✗ | ✓ | ✓ |

### DSAR (all †)
| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `POST /me/dsar` | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/dsar/:id` | ✓ own | ✗ | ✗ | ✗ | ✗ | ✗ |
| `POST /me/dsar/:id/package-token` | ✓ own | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/dsar/:id/timeline` (own milestones) | ✓ own | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/dsar/:id/erasure-package` (review manifest) | ✓ own | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/dsar/:id/erasure-package/photos/:photoId` | ✓ own | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/dsar/:id/erasure-package.zip` | ✓ own | ✗ | ✗ | ✗ | ✗ | ✗ |
| `POST /me/dsar/:id/confirm-erasure` (the authorisation) | ✓ own | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /dsar/evidence` (vault) | ✗ | ✓ all | ◐ assigned | ✗ | ✓ all | ✓ |
| `GET /dsar/:id/media` (break-glass targets) | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| `GET /dsar/subjects/search` (identity lookup) | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `GET /dsar/:id/items` (item index, paged) | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| `POST /dsar/:id/items/actions` (redact / delete / mark-export) | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `GET /dsar/:id/items/actions` (batch progress) | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| `POST /dsar/:id/package` (selective §11 build) | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `GET /dsar/:id/timeline` (merged history) | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| `POST /dsar/:id/close` (explicit close) | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| `GET /dsar` (queue) | ✗ | ✓ all | ◐ assigned | ✗ | ✓ all | ✓ |
| `POST /dsar/:id/assign` | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ |
| `POST /dsar/:id/discovery` | ✗ | ✗ | ✓ assigned | ✗ | ✓ | ✓ |
| `POST /dsar/:id/evidence` | ✗ | ✗ | ✓ assigned | ✗ | ✓ | ✓ |
| `POST /dsar/:id/execute` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `POST /dsar/:id/approve` | ✗ | ✓ | ✓ own | ✗ | ✗ | ✓ |
| `GET /dsar/:id/certificate` | ✓ own | ✓ | ◐ | ✗ | ✓ | ✓ |
| `GET /sla` | ✗ | ✓ | ◐ own | ✗ | ✓ | ✓ |

### Import (admin-initiated inbound edge)
`dataAdmin`/`super` only, throughout. Asserting "this photograph is of this named person" without a capture event and without a face match is a data-administration act: a `dpo` approves purposes and a `dataOwner` runs a project, and neither of those is the authority to write a person's data into the system on their behalf. The read endpoints share the floor because a batch names its subject.

| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `POST /imports` (open a batch) | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `POST /imports/:batchId/items` (≤20 files/req) | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `POST /imports/:batchId/close` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `GET /imports` / `GET /imports/:batchId` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |

An import into an `ERASED` subject is a **409**, never a soft warning: it would re-create the data a signed deletion certificate says was destroyed.

### Audit
| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `GET /audit` † | ✓ own entries | ✓ all | ◐ own projects | ✗ | ✓ all | ✓ |
| `GET /audit/verify` † (chain check) | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| `GET /access-events` † | ✓ own | ✓ | ✗ | ✗ | ✓ | ✓ |
| **write audit** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ — service-only, `GRANT INSERT` via RLS |

---

## C. Break-glass protocol (`⚑`)

Raw media reaching a `dataAdmin` requires **all four**:
1. an open `DsarRequest` with `status IN (DISCOVERY, EXECUTING)` naming that `subjectId`;
2. request body carries `dsarRequestId` + free-text `justification` (min 20 chars);
3. an `AccessEvent{breakGlass:true}` written **before** the blob is decrypted — if the log write fails the read fails;
4. a notification lands in the DPO inbox within the same request.

Access token for the object is scoped: signed URL, 5-minute TTL, single-use, bound to `dsarRequestId`. `super_admin` follows the identical protocol minus the DSAR requirement, plus a second-approver check.

---

## D. Data minimisation per portal view

| Portal screen | Fields it may query | Fields it must never select |
|---|---|---|
| DPO — Project Approvals | project meta, purpose, retention, requested data types, owner name | any subject row |
| DPO — SLA Monitoring | request id, type, timestamps, status, assignee | subject identity → show `SUB-<first8 of hash>` |
| Data Owner — Collection Progress | counts, session codes, timestamps | subject names, photos |
| Data Owner — Processed Data | redacted derivative + non-identifying tags | `PhotoSubject.subjectId` → return opaque per-project pseudonym |
| Agent — Tagging | face crops + subject display name for assigned session | any other session, any project not assigned |
| Data Admin — Lineage | ids, paths, timestamps, consent status | blob content unless `⚑` |
| Data Admin — DSAR subject search | name, email, employeeRef, item count — **exact + prefix match only, never fuzzy** | any subject the term did not match exactly or by prefix; a wrong match is a breach, not a bad result |
| DSAR request workspace — Data tab | item ids, type, origin, project/session id, capturedAt, content hash, shared-subject count, lawful basis | subject identity → `SUB-<first8 of hash>`; `storage_path`; any other principal's id on a shared frame |
| DSAR request workspace — bulk action bar | exact selected count, how many of those are shared frames that will be **redacted instead of deleted** | any "delete all" that does not state the count; any client-side shared-frame check — the downgrade is decided server-side from `shared_subject_count` |
| DSAR request workspace — Timeline tab | `at`, actor **admin id**, kind, summary, ref id, hash | subject identity; `AuditLog` payloads (hash-only by design — never invent content for an entry) |
| DSAR dashboard — queue | pseudonym, coarse + fine status, SLA, assignee, item counters | subject name/email on any tier below `dataAdmin` |
| Data Admin — Import | subject name/email of the **one** subject being imported into, batch counters, lawful-basis verdict per item | any other subject; any suggestion that an `IMPORT_UNVERIFIED` item has consent — the gap is shown, never hidden |
| Subject portal — request timeline | coarse status, milestone kind, time, own resolution note | internal actor identities, `AccessEvent` rows, evidence hashes, another handler's reasoning |
| Subject portal | own everything | any other subject |

Enforce via Prisma `select` allowlists in each service — never `include` a whole relation on a governance route.

---

## E. Portal page table (front-end derivation of §B)

§B is the enforcement. This section records the **navigation** derived from it, which is a different question: not "may this role call this endpoint" but "should this role be shown this screen at all".

The table lives in `admin-portal/src/roles.js` as `PAGES` — the page is the row, the roles are the column — and `App.jsx` generates one route per page carrying every role that page admits. It replaced a per-role `nav` array that emitted `allow={[role.key]}`, which made a page two roles legitimately share reachable by exactly one of them, and made `super_admin` — which had no `nav` array of its own — reach nothing.

**The subset rule.** `PAGES` must stay a subset of §B. A page is listed for a role only if **every endpoint that page calls on mount** admits that role. Where a page calls a narrower endpoint from a *button* rather than on mount, the page hides that button itself and states why in place of it.

| Page | dpo | dataOwner | collectionAgent | dataAdmin | super | Narrowest endpoint on mount |
|---|---|---|---|---|---|---|
| `/project-approvals` | ✓ | ✗ | ✗ | ✗ | ✓ | `POST /projects/:id/approve` |
| `/consent-templates` | ✓ | ✗ | ✗ | ✗ | ✓ | `POST /consent-templates` |
| `/my-projects` | ✗ | ✓ | ✗ | ✗ | ✓ | `POST /projects/:id/assignments` |
| `/create-project` | ✗ | ✓ | ✗ | ✗ | ✓ | `GET /consent-templates` (excludes dataAdmin) |
| `/data-requirements` | ✗ | ✓ | ✗ | ✗ | ✓ | `PATCH /projects/:id` |
| `/collection-progress` | ✗ | ✓ | ✗ | ✗ | ✓ | `GET /dashboard/summary` |
| `/processed-data` | ✗ | ✓ | ✗ | ✗ | ✓ | `GET /projects/:id/sessions` |
| `/project-reports` | ✓ | ✓ | ✗ | ✗ | ✓ | `GET /projects/:id/report` |
| `/assignments` | ✗ | ✗ | ✓ | ✗ | ✓ | `GET /projects` (assigned) |
| `/new-session` | ✗ | ✗ | ✓ | ✗ | ✓ | `POST /sessions` |
| `/sessions` | ✗ | ✗ | ✓ | ✗ | ✓ | `GET /sessions` |
| `/subject-verification` | ✗ | ✗ | ✓ | ✗ | ✓ | `POST /subjects/:id/enrollments` |
| `/consent-check` | ✗ | ✗ | ✓ | ✗ | ✓ | `GET /projects/:id/subjects` — names, so §D keeps dpo/dataOwner out |
| `/dsar-queue` | ✓ | ✓ | ✗ | ✓ | ✓ | `GET /dsar` |
| `/import` | ✗ | ✗ | ✗ | ✓ | ✓ | `POST /imports` |
| `/discovery-workspace` | ✗ | ✗ | ✗ | ✓ | ✓ | `POST /handoffs` |
| `/data-lineage` | ✗ | ✗ | ✗ | ✓ | ✓ | `GET /handoffs/lineage` |
| `/collection-sessions` | ✗ | ✗ | ✗ | ✓ | ✓ | `GET /projects/:id/sessions` |
| `/purge-export` | ✗ | ✗ | ✗ | ✓ | ✓ | `POST /dsar/:id/execute` |
| `/evidence-vault` | ✗ | ✓ | ✗ | ✓ | ✓ | `POST /dsar/:id/evidence` |
| `/sla-monitoring` | ✓ | ✗ | ✗ | ✓ | ✓ | `GET /dsar/sla` — excludes dataOwner |
| `/compliance-reports` | ✓ | ✗ | ✗ | ✓ | ✓ | `GET /audit/verify` — excludes dataOwner |
| `/audit-logs` | ✓ | ✓ | ✗ | ✓ | ✓ | `GET /audit` |

**No new page for voice.** The agent-facing voice enrollment UI is a section of the existing enrollment panel on `/subject-verification`, not a route of its own, so the table above is unchanged: the voice routes admit `collectionAgent` and `super_admin` exactly as the selfie routes do, and the narrowest endpoint on mount is still `POST /subjects/:id/enrollments`. The voice list is fetched when the panel is opened rather than when the page mounts, and it treats a `503` from the `AUDIO_CAPTURE_ENABLED` gate as "not offered in this deployment" — the section collapses to one line instead of rendering an error, because the kill switch being off is not a fault. The panel offers **no playback control**, matching the absence of an agent-facing playback route in §B.

Two widenings against the original per-role navs, both justified by §B: `/project-reports` gains `dpo`, and `/audit-logs` gains `dataOwner`. One retirement: **`/request-oversight` is gone.** It was a dpo-only DSAR list that `/dsar-queue` supersedes in every respect — the queue already renders the SLA line, the breach-tone pill, the assignment and the item counters, and it honours §D identically by rendering whichever of `subjectRef` / `subjectId` the server chose to send. Its one unique capability, an *Overdue only* filter, moved to the queue.

### Pages that gate their own controls

| Page | Shown to | Withheld from | What is withheld |
|---|---|---|---|
| `/dsar-queue` | dpo, dataOwner, dataAdmin, super | dpo, dataOwner | identity search (`GET /dsar/subjects/search`) and the import shortcut |
| `/dsar/:requestId` | dpo, dataOwner, dataAdmin, super | dataOwner | Data / Timeline / Actions tabs — the three endpoints behind them are dpo/dataAdmin/super |
| `/dsar/:requestId` | " | dpo, dataOwner | item actions and package build (`POST /dsar/:id/items/actions`, `/package`) |
| `/dsar/:requestId` | " | dpo | Run discovery (`POST /dsar/:id/discovery` is dataOwner/dataAdmin/super) |
| `/dsar/:requestId` | " | dpo, dataOwner | Execute (`POST /dsar/:id/execute` is dataAdmin/super) |

The DSAR workspace closes through two endpoints rather than one: `POST /close` for dpo/dataAdmin/super, `POST /approve` for dpo/dataOwner/super. The service implements `approve` as the same `REVIEW → CLOSED` transition, so a dataOwner signs a request off through it.

**A refusal is stated, never silent.** `RequireRole` used to `<Navigate to="/dashboard">` on a role mismatch, which is indistinguishable from a broken link. It now renders a refusal naming the signed-in role, the path, and the roles the path is reserved for — so a genuine permission bug is reportable by the person who hit it.

### Subject portal

The user portal has no roles, but it has the same failure mode: thirteen signed-in routes sat under a bare layout with **no auth gate at all**, and the nav exposed four of them, leaving the whole §11–§13 rights surface reachable only by typing the URL. `RequireAuth` now wraps the layout, and `NAV_SECTIONS` is built around the rights (Overview / Consent / Your rights / Account) with a five-entry primary bar on mobile.

Voice enrollment is managed from a card on the Consent Hub, alongside the face card, and it renders **nothing at all** when the audio kill switch is off — advertising a feature whose every button answers 503 is worse than not offering it. Playback of a subject's own clip lives only here, which is the one place §B permits it.

One consent flag governs both modalities: `Subject.biometricMatch` is the only biometric-specific consent that exists, so agreeing on either card enables the other and withdrawing on either erases both. Both cards say so in those words. Saying it is not a nicety — someone who ticks the voice box without being told they have also switched face matching on has not consented to face matching. The two cards also re-read each other whenever the flag moves, so the one that did not make the change cannot keep displaying clips or photos the server has already erased.
