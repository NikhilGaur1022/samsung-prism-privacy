# Breach Response Runbook — Samsung PRISM

Operational runbook for a personal-data breach involving PRISM (consent-management + DSAR platform). Built against the architecture in `docs/01_PRIVACY_DATAFLOW.md` and the role model in `docs/02_ROLE_PERMISSION_MATRIX.md`. Where a step depends on a control that doc 01 marks GAP, that is called out — do not assume the control exists mid-incident.

Status legend carried from doc 01: `BUILT` = works today · `PARTIAL` = exists but incomplete · `GAP` = must be built.

---

## 1. Detection and triage

### 1.1 Detection sources
| Source | What it can surface | Status |
|---|---|---|
| `AuditLog` mutation chain (hash-chained, `payloadHash`/`prevHash`) | tamper-evidence on a given entity — proves *something* changed, not *what* (doc 01 §3.3 known limitation, still true) | BUILT |
| `AccessEvent` table (reads: VIEW/DOWNLOAD/DECRYPT/EXPORT, `breakGlass` flag) | who read what, when, under what justification | **BUILT.** `backend/src/lib/accessLog.js` — `recordAccess` writes the row *before* any decrypt (`backend/src/middleware/logAccess.js` mounts after auth, before the handler that reads the blob) and **throws** on a write failure, so the read itself is refused rather than served unlogged ("no log, no read"). Break-glass reads additionally carry `breakGlass:true`, `dsarRequestId`, and `justification` (`backend/src/middleware/requireBreakGlass.js`). Query it with `listAccessEvents({ actorId, objectType, objectId, dsarRequestId, since })`. |
| `requireRole` 403 / break-glass denials | unauthorized or malformed access attempts | **BUILT.** `recordDenied` (`backend/src/lib/accessLog.js`) writes `AccessEvent{action:'DENIED'}` for every break-glass rejection (wrong role, missing/short justification, DSAR not open, object doesn't belong to the named subject) — best-effort by design (swallows its own write failure so a denial can never itself become a 5xx). A rate-limit-triggered 429 on the OTP routes is a separate, known-inconclusive signal — see Architecture note in `docs/HANDOFF.md` §4 — do not conflate a 429 with a scored `DENIED`. |
| Infra/host alerting (DB connection anomalies, unexpected `fs` writes, Redis auth failures) | intrusion, credential misuse | outside PRISM schema — standard ops monitoring |
| Subject report ("I did not authorize this") | consent/identity mismatch | manual intake via subject portal or DPO inbox |
| Vendor/processor notification (face-worker, image-pii-worker host compromise) | processor-side exposure | manual, contractual |

**`AccessEvent` is now the authoritative source for "who read the raw media, when, and under what justification."** Every VIEW/DOWNLOAD/DECRYPT on the media read paths is logged before decryption, and a log-write failure fails the read itself — there is no code path in the current source that serves media without leaving a row. What is still manual: turning a set of `AccessEvent` rows into an incident narrative, and anything that happened *outside* the application read path (e.g. a direct filesystem or database-level compromise, which would leave no `AccessEvent` at all — that gap is real and should be stated to whoever is running the incident, distinct from the ordinary read path which is now fully covered).

### 1.2 Severity bands

| Band | Definition | Example against doc 01's data model | Initial response SLA |
|---|---|---|---|
| **SEV-1 — Critical** | Confirmed or highly likely exposure of raw, unredacted media (L2/L3/L4) or face embeddings (L5) to an unauthorized party; or KEK/master-key compromise | Vault (L8) breach; database dump exfiltrated while `MEDIA_KEK` is unset (envelope encryption is BUILT in `storage.js` but opt-in — see R6 in DPIA and `docs/DEPLOY.md` §4, and confirm whether the affected environment has it set before assuming plaintext exposure); `MEDIA_KEK` itself leaked | Triage start: **immediate** (page on-call). DPO notified within 1 hour. |
| **SEV-2 — High** | Exposure of redacted derivatives at scale, PII text leak (Aadhaar-pattern etc. per R1 in DPIA), or a break-glass path used without the required `AccessEvent`/justification | image-pii-worker outage causing photos to sit `piiStatus=DEFERRED` indefinitely is now an availability incident, not a PII-leak one — fail-closed behaviour (`PiiUnavailableError`) means a photo can no longer reach an export unmasked; treat a DEFERRED backlog as SEV-3/operational unless a specific photo is confirmed to have left the system unmasked, which would now indicate a bypass of `redactBystanders`/`readRedactedPhoto` worth escalating as its own root-cause finding. Break-glass without a valid `AccessEvent` is now structurally difficult (`requireBreakGlass` blocks the request itself if the log write fails) — this scenario should be rare enough that its occurrence is itself suspicious and worth escalating rather than routine. | Triage start: within 4 hours. DPO notified within same business day. |
| **SEV-3 — Medium** | Access-control failure caught before data left the system (e.g. a 403 pattern indicating probing), or a single-record erroneous disclosure (wrong subject's redacted photo served) | Data Owner briefly able to query raw originals due to a scope bug | Triage start: within 1 business day. |
| **SEV-4 — Low** | Policy/process deviation with no data exposure (e.g. missing justification text on a break-glass request that was otherwise correctly scoped) | Incomplete `justification` field, access itself was in-scope | Logged, reviewed at next audit cycle. |

Severity can only escalate, never be downgraded, without DPO sign-off.

### 1.3 Immediate triage steps (any SEV-1/SEV-2)
1. Identify the affected `objectType` (PHOTO / ENROLLMENT / EXPORT / SUBJECT_PII / EMBEDDING) and the storage locations touched (map against doc 01 §2 L1–L11).
2. Identify whether the exposure is at the encryption boundary (envelope-encrypted blob leaked but key intact — lower severity) or a key/plaintext exposure (higher severity).
3. Freeze the affected pathway: revoke the credential/token/route involved. For admin credential compromise, use the existing lockout + refresh-token-family revocation (`lib/tokens.js`, BUILT per doc 01 §7).
4. Do **not** delete or modify any `AuditLog` row, session data, or affected records — see §5, evidence preservation.
5. Open an incident record and assign an incident owner (DPO or delegate) before any remediation action beyond containment.

---

## 2. Data Protection Board notification (72-hour timeline, DPDP Rules 2025)

| Time from confirmed detection | Action |
|---|---|
| T+0 | Incident confirmed as reportable (any SEV-1, and any SEV-2 involving personal data leaving fiduciary control). Incident owner assigned. |
| T+0 to T+24h | Initial internal assessment: scope, data categories, principal count (estimated if exact count unavailable), containment status. |
| T+24h to T+48h | Draft DPB notification prepared and reviewed by DPO + Legal. |
| **T+72h (hard deadline)** | Notification submitted to the Data Protection Board, per DPDP Rules 2025. This deadline is not extendable by internal investigation status — submit with best-available information and supplement later if required. |
| Post-submission | Supplementary reports as the investigation resolves open items (root cause, final principal count, remediation completed). |

**What the DPB notification must contain** (assemble even if some fields are provisional at T+72h):
- Nature of the breach and categories of personal data involved (map to doc 01 §2 locations — e.g. "L2 raw originals" is more precise than "photos")
- Approximate number of data principals and records affected
- Likely consequences of the breach
- Measures taken or proposed to address the breach and mitigate adverse effects
- Contact point (DPO name and details) for further information
- Chronology: when the breach occurred, when it was detected, and detection method

**Today's implementation status:** `BreachRecord` table and DPB notification job are listed **GAP** in doc 01 §7 and §8 (row §8(5), row "Rules 2025"). Until built, this section is a manual procedure — someone must compile and file the notification by hand; there is no automated tracking of the 72-hour clock.

---

## 3. Data-principal notification

### 3.1 When required
Notify affected data principals **without delay** when the breach is likely to result in a risk to their rights and freedoms — this is the DPDP §8(5) standard doc 01 references directly ("notify Data Protection Board + each affected Principal without delay," doc 01 §7 row "Breach affecting principals"). In practice under this data model:

- **Always notify** for SEV-1 (raw media, embeddings, or key exposure) — biometric data is inherently high-risk.
- **Notify** for SEV-2 where PII text or identifiable redacted media reached an unauthorized party.
- **Case-by-case, DPO decision** for SEV-3 — notify if the affected principal(s) can be identified and the exposure was to an unauthorized party rather than an internal scope error caught before disclosure.
- **Do not** notify for SEV-4 (no data left the system).

### 3.2 Notification template (plain language)

```
Subject: Important notice about your data held by [Fiduciary name]

Dear [Data Principal name],

We are writing to inform you of a data security incident that affected
information you provided to us as part of [Project name / purpose].

What happened:
[Plain description — e.g. "A technical fault allowed a photo of you taken
during [session/date] to be accessed by someone outside our authorized
team."]

What information was involved:
[Name the specific category using plain terms, not internal schema names —
e.g. "a photograph of your face" rather than "L2 original," "your face
enrollment images" rather than "L4."]

What we are doing about it:
[Containment + remediation summary in plain terms.]

What you can do:
- You can review what data we hold about you and revoke your consent at
  any time through your account: [link to subject portal /me/consents]
- You can request a copy of your data, a correction, or full deletion:
  [link to DSAR request /me/dsar]
- If you have questions, contact our Data Protection Officer:
  [DPO name, email, phone]

We take this seriously and have reported this incident to the Data
Protection Board as required by law.

[Fiduciary name]
[Date]
```

**Delivery mechanism:** doc 01 §1 Phase F notes DPO approval and notification happen "via secure inbox." The `BreachRecord` + notification job that would automate this send is listed GAP (doc 01 §8) — today, notification is a manual send by the DPO through whatever subject-contact channel is available (the OTP-registered phone/email on the subject's `Subject` record).

---

## 4. Containment

### 4.1 General containment checklist
1. Identify and close the specific access path (route, credential, misconfigured scope) that enabled the exposure.
2. Revoke affected credentials: admin lockout + refresh-token family revocation (BUILT, `lib/tokens.js`).
3. If a break-glass (`⚑`) path was used improperly, revoke the signed URL immediately — these are already 5-minute TTL, single-use, `dsarRequestId`-bound by design (doc 02 §C), so exposure window from a single-use token is inherently short; the risk is repeated/systemic misuse, not one token.
4. If exposure involves encrypted blobs where the encryption itself may be compromised (key exposure, not just blob exposure), proceed to the key-rotation drill below.

### 4.2 Key-rotation drill (KEK compromise or suspected compromise)

Per doc 01 §3.2 and §7 ("Key compromise" row), the envelope scheme is designed for exactly this:

1. **Generate a new master KEK.** Never reuse or derive the new KEK from the compromised one.
2. **Assign a new `keyId`.** The blob header format (`magic(4) || version(1) || keyId(8) || nonce(12) || tag(16) || ciphertext`) carries the key identifier per-blob, so old and new keys coexist without a synchronous migration.
3. **Rotation is non-breaking by design:** because `keyId` is embedded per blob, existing ciphertext under the old KEK remains readable (the old KEK/DEKs stay available for decrypt) while all *new* writes use the new KEK-derived DEKs immediately.
4. **Lazy re-encrypt on read:** as each blob is subsequently read under normal operation, re-encrypt it under the new KEK-derived DEK and update its `keyId`. This avoids a bulk-decrypt/re-encrypt operation across the entire vault, which would itself be a high-risk bulk-plaintext-exposure event during incident response.
5. **Force-rotate high-value data out of band:** for SEV-1 confirmed key compromise, do not wait for lazy re-encryption on biometric data (L4/L5, subject-keyed). Since crypto-shredding operates at the per-subject-DEK level (doc 01 §3.2), consider whether affected subjects' data should be proactively re-keyed rather than left to lazy rotation.
6. **Retire the old KEK** only after confirming no blob still references its `keyId` unrotated, or after an explicit acceptable-risk decision documented by the DPO if full rotation is impractical in the incident timeframe.
7. **Rotate `AUDIT_HMAC_SECRET` separately if compromised** — this is a distinct secret from `MEDIA_KEK` and does not follow the same blob-header rotation mechanism; a compromise here requires re-establishing trust in the audit chain going forward (see §5) since it cannot be retroactively re-signed.

**Caveat:** this drill assumes `MEDIA_KEK` is actually set in the affected environment. The envelope-encryption scheme itself is **BUILT** for L2/L4/L6/L7/L8 (`backend/src/lib/storage.js` — every read/write goes through it; this corrects an earlier revision of this runbook, which described the scheme as GAP for those locations). But encryption is opt-in, keyed off `MEDIA_KEK` being present, and is off in some environments (confirmed off in the dev environment as of `docs/HANDOFF.md` §6.3). **Check whether `MEDIA_KEK` was set in the affected environment before running this drill** — if it was unset at the time of compromise, those blobs were plaintext on disk regardless of key rotation, and containment must instead focus on filesystem/storage-layer access revocation, not key rotation. If it *was* set, proceed with steps 1–7 above, and additionally run `node scripts/migrate-media-encrypt.js --dry-run` afterward to confirm no blob remains sealed under the compromised `keyId` beyond what lazy rotation has not yet touched.

### 4.2a Scoping an exposure with the item index

`subject_data_items` is the fastest honest answer to "what did we hold about this
person at the time of the incident", and it changes the containment story in two
specific ways. Both matter during a live response:

1. **It is a projection, not a location.** It holds ids, hashes, counts and a
   `storage_path` pointer — no media, no name, no email. A dump of this table is
   not itself a personal-data exposure of the same class as a media leak, and it
   is safe to copy into an incident workspace where a photo corpus is not.
2. **It is the only surface that reports what was *destroyed*.** Deleted items are
   tombstoned (`deleted_at` set), never removed, so it can answer "was this frame
   already erased before the incident window" — which is often the difference
   between notifying a principal and not.

To scope an exposure by subject, count live and tombstoned items per origin:

```sql
SELECT origin, (deleted_at IS NULL) AS live, count(*)
FROM subject_data_items WHERE subject_id = $1 GROUP BY 1, 2;
```

**Treat a divergence warning as part of the incident.** The item listing endpoint
logs `alert: ITEM_INDEX_DIVERGED` (self-repairing) or `ITEM_INDEX_INCOMPLETE`
(not repairable) when the index disagrees with `photo_subjects`. If those appear
in the window, the index **understates** the holding and a scoping figure taken
from it is a floor, not a total. Fall back to `runDiscovery()` per subject, which
walks the source tables directly.

**Imported items need a separate line in the incident record.** Anything with
`origin = 'IMPORT'` carries no capture-time consent (`meta.lawfulBasis =
'IMPORT_UNVERIFIED'`, DPIA R11) and no face blurring (`meta.faceDetection =
'NOT_RUN'`, DPIA R12). Both facts change the notification assessment: the second
means an exposed imported frame may reveal a bystander who is not the subject of
the request at all, and that bystander is also an affected principal.

### 4.3 Service-level containment
| Component | Containment action |
|---|---|
| face-worker (:8001) | Isolate host, rotate shared-secret/mTLS cert if that hop is compromised |
| image-pii-worker (:8002) | Same; also check whether outage during the incident window caused unmasked PII to ship (see DPIA R1) |
| Postgres | Rotate DB credentials; verify `sslmode=require` is actually enforced (target per doc 01 §3.1) |
| Redis | Rotate AUTH; note Redis 5.0.14 is below BullMQ's 6.2 floor (doc 01 §9 item 12) — upgrade is an open item independent of this incident but worth flagging if the incident touches the queue layer |

---

## 5. Evidence preservation

**The audit chain and `AccessEvent` table must not be modified, deleted, or "cleaned up" during incident response, under any circumstance, by anyone including super_admin.**

- `AuditLog` is hash-chained (`payloadHash` + `prevHash`) specifically so tampering is detectable (doc 01 §3.3). Any edit to a historical row breaks the chain and is itself evidence of tampering — but only if someone later verifies the chain (`GET /audit/verify`, doc 02 — currently marked `†` GAP, route does not exist). Until that verification route ships, chain integrity checking is a manual/scripted task, not a one-call API check — plan for that during response.
- `AccessEvent` is **BUILT** (`backend/src/lib/accessLog.js`) — this corrects an earlier revision of this runbook, which described the table as not existing yet. It is immutable in production by two independent mechanisms: RLS is enabled and forced on `access_events` (`GRANT INSERT` only, no UPDATE/DELETE policy — doc 01 §5), *and* `backend/scripts/sql/provision-app-role.sql` explicitly revokes `UPDATE, DELETE, TRUNCATE` on it from the application role as a second, independent guarantee. **Both of those depend on the application actually connecting as the least-privilege `prism_app` role rather than Supabase's `postgres` owner role**, which holds `BYPASSRLS` and makes RLS inert regardless of how the policies are written — see `docs/DEPLOY.md` §3. Confirm which role the affected environment was connected as before treating "the log can't have been tampered with" as settled; if it was connected as the owner role, that assumption does not hold and must be stated as a caveat in the incident record. Preserve the invariant regardless: do not grant temporary write access to "fix" a record during an incident.
- **Known limitation to plan around:** `AuditLog.payloadHash` never stores payload plaintext (doc 01 §3.3) — it proves an entry wasn't silently altered, but does not by itself reconstruct *what* the mutation was. Do not expect the audit chain alone to answer "what exactly changed" — cross-reference with application logs, database WAL/point-in-time state if available, and `AccessEvent` reads once that table exists.
- Snapshot (do not restore-over) the current database state and relevant filesystem paths (`sessions/<sid>/...`, `vault/<projectId>/...`) before any remediation that would alter them, so a forensic copy exists independent of production.
- Preserve `PurgeJob` and `DsarRequest` state as-is if the incident intersects an in-flight erasure or export — do not let containment actions race with or mask a legitimate DSAR execution.
- Chain of custody: log who accessed preserved evidence, when, and why — apply the same discipline internally that `AccessEvent` is meant to apply to production reads.

---

## 6. Post-incident review checklist

- [ ] Root cause identified and documented (which control failed: encryption boundary, access control, process gap, third-party/processor failure)
- [ ] Map root cause to a specific doc 01 §2 location (L1–L11) or doc 02 role/endpoint — vague causes ("a bug") are not acceptable close-out language
- [ ] Confirm whether the failure traces to a documented GAP (doc 01 §9 gap list) — if so, this incident is evidence for prioritizing that gap, not a novel finding
- [ ] Full scope confirmed: exact (not estimated) count of affected data principals and records
- [ ] DPB notification filed within 72h — confirm timestamp against T+0 detection time
- [ ] Data-principal notifications sent where required (§3.1 criteria) — confirm delivery, not just send
- [ ] Key rotation completed (if applicable) — confirm no blob remains under a compromised `keyId` beyond an explicitly accepted residual
- [ ] Audit chain integrity verified post-incident (manual chain walk if `/audit/verify` still doesn't exist)
- [ ] `AccessEvent` / access logs reviewed for the full incident window — this is now always possible for anything that went through the application's media-read paths (fail-closed logging, `backend/src/lib/accessLog.js`); explicitly note in the incident record if any part of the exposure occurred *outside* those paths (direct filesystem/DB access, a compromised backup, an infra-level breach) where `AccessEvent` would have no row to show
- [ ] Affected credentials/tokens confirmed revoked and not merely disabled-pending
- [ ] DPIA (`docs/DPIA.md`) risk register reviewed — update likelihood/impact/mitigation/residual columns for any risk this incident touched
- [ ] Remediation items opened as tracked work with owners, not just noted in the incident report
- [ ] Lessons-learned session held with DPO, incident owner, and engineering lead; findings distributed to admin tiers with a legitimate need to know (not broadcast — apply the same least-privilege logic as doc 02 to the post-mortem itself)
- [ ] This runbook updated if the response process itself revealed a gap (e.g., a detection source assumed to exist did not)

---

**Sign-off on closure:**

| Role | Name | Date |
|---|---|---|
| DPO | _____________________ | __________ |
| Incident Owner | _____________________ | __________ |
