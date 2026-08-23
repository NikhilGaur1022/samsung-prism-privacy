# Key custody and disaster recovery

The question this document exists to answer: **if the server is gone tomorrow,
what does someone need in order to get PRISM back — and what can nobody get back
at all?**

Not theoretical. Before this was written there was no backup script, no restore
procedure, and no record anywhere of where `MEDIA_KEK` should live. Losing one
file on one machine would have destroyed every photo, face crop and recording in
the system, permanently, with no error message anywhere.

---

## 1. What is unrecoverable

Read this part first, because it is the part that has no remedy.

| Secret | If lost | Blast radius |
|---|---|---|
| `MEDIA_KEK` | **Total, permanent loss of all media.** Every photo, face crop, video and recording. | Everything under `STORAGE_ROOT` becomes noise. No backup helps; the backups are ciphertext too. |
| `FACE_EMBEDDING_KEY` | All enrolment embeddings unreadable | Face recognition stops working; subjects must re-enrol |
| `DSAR_SIGNING_SEED` | Existing deletion certificates can no longer be verified | Past erasures become unprovable. New ones can be signed under a new key |
| `subject_keys.salt` (per person, in the database) | That person's biometrics unrecoverable | **This one is intentional** — it is how erasure works |

There is no recovery path for the first three. Not "hard", not "expensive" —
none. AES-256-GCM with a lost key is exactly as strong as it is advertised to be.

The last row is the same mechanism working *for* you: a per-subject salt is
deleted on erasure, and because the key was derived from it rather than from
something reconstructible, the data is gone even inside backups nobody can go
back and edit. That is what makes DPDP §12(3) erasure provable in this system
instead of a promise.

### Why the keys are not in the backups

`scripts/backup.js` writes key **fingerprints**, never key material. A backup
that carried both the sealed media and the key that opens it would be a
plaintext copy of the entire system sitting in whatever bucket the backups go to
— and backups are, by definition, the least-guarded copy of anything.

The fingerprint is enough to prove on restore that you are holding the right
key. It is not enough to derive it.

---

## 2. Where the keys must live

**Decide this before go-live. It is an organisational decision, not a technical
one, and it is the only item in this document that a script cannot do for you.**

Minimum bar:

- [ ] `MEDIA_KEK`, `FACE_EMBEDDING_KEY` and `DSAR_SIGNING_SEED` are held in a
      secrets manager, not in a `.env` file on the application server
- [ ] A sealed offline copy exists somewhere physically separate — printed or on
      an encrypted USB in a safe. The failure this covers is "the cloud account
      itself is lost or locked", which a secrets manager cannot cover
- [ ] **At least two people** can reach that copy. One person holding the only
      key is one resignation, one accident, one forgotten password away from
      total data loss
- [ ] Named owner recorded below, with a named deputy
- [ ] Recovery is rehearsed at least once, by the deputy rather than the owner —
      an untested procedure is a hope

| Role | Name | Contact | Reviewed |
|---|---|---|---|
| Key owner | *(to be filled in)* | | |
| Deputy | *(to be filled in)* | | |
| Escalation | *(to be filled in)* | | |

Today, in development, all three secrets sit in `backend/.env` on a single
laptop. That is acceptable for development and is **not** acceptable for
production.

### The erasure ledger

`erasure-tombstones.jsonl` — by default beside `STORAGE_ROOT`, overridable with
`ERASURE_LEDGER_PATH` — records every subject ever erased. It matters nearly as
much as the KEK, for a reason that is not obvious; see §5.

It must be:

- backed up **outside** the database, since the whole point is that it survives a
  database rollback
- append-only in practice — never regenerated from a restored database, which
  would silently drop every erasure that happened after that backup

---

## 3. What a backup contains

```
backups/<timestamp>/
  MANIFEST.json              counts, checksums, KEK version, git commit
  keys.fingerprint.json      key fingerprints — NEVER key material
  db/*.jsonl                 one file per table (or dump.pgcustom via pg_dump)
  media/                     the sealed blob tree, copied byte-for-byte
  media.sha256               a checksum per file, over the SEALED bytes
  erasure-tombstones.jsonl   snapshot of the erasure ledger
```

Media is copied without ever being decrypted. The checksums are over ciphertext,
so integrity can be proven by someone who does not hold the key.

```bash
node scripts/backup.js                      # → ./backups/<timestamp>
node scripts/backup.js --out /mnt/backups/prism
node scripts/backup.js --skip-media         # rows only
```

The script **refuses to run** if `MEDIA_KEK`, `FACE_EMBEDDING_KEY` or
`DSAR_SIGNING_SEED` are unset. A backup taken in that state restores into
unopenable ciphertext, verifies clean at row level, and fails only when someone
finally tries to open a photo — which is the worst possible moment to find out.

---

## 4. Restoring

```bash
node scripts/restore.js --backup <dir> \
  --target-db "postgresql://..." \
  --target-media /srv/prism/media

node scripts/verify-restore.js --backup <dir>
```

`restore.js` refuses to write into a database that already holds rows, or over a
media tree that is not empty, unless you pass `--force`. Restoring into a live
system merges two histories into a third that matches neither, and it is the
standard way an incident becomes a much larger incident.

Checksums are verified **on the way in**, not afterwards. A corrupt blob that
reaches the live tree is indistinguishable from a blob whose key is wrong, and
those two have very different remedies.

**"Restore complete" is not "system recovered."** Always run `verify-restore.js`.

---

## 5. The trap: a restore can undo an erasure

Erase someone in March. Crash in June. Restore February's backup.

Their salt comes back. Their biometrics are readable again. The signed
certificate you gave them still says the data was destroyed — and now that
statement is false. Every conventional check passes: rows restored, checksums
matched, service healthy. Nothing in the restored database can detect it, because
the restored database is precisely the one that predates the erasure.

That is a reportable breach that looks exactly like a routine recovery.

The defence is the erasure ledger. It accumulates across backups and is never
rolled back with them, so `verify-restore.js` can compare the restored state
against the full history of erasures and name anyone who came back:

```
[ FAIL ] erased-stay-erased    1 of 1 erased subject(s) CAME BACK — re-erase immediately

  Subjects whose erasure this restore undid:
    de351590-aea7-457a-a784-2241dcf2fc66  erased 2026-03-14T09:00:00.000Z
```

**If you see this after a restore, re-run the erasure for every subject named,
before the system takes traffic.** Then record the window during which the data
was recoverable — that window is a reportable fact, whether or not anyone
accessed it.

---

## 6. Rotating `MEDIA_KEK`

Blobs carry the id of the key that sealed them, so rotation is lazy rather than a
flag day.

1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. Move the current value to `MEDIA_KEK_PREVIOUS`
3. Put the new value in `MEDIA_KEK` and increment `MEDIA_KEK_VERSION`
4. Restart. New writes seal under the new key; old blobs still open under the old one
5. Take a fresh backup — the manifest records the new version
6. **Keep `MEDIA_KEK_PREVIOUS` for as long as any backup sealed under it is
   retained.** Dropping it while a v1 backup is still in your retention window
   makes that backup unrestorable

`verify-restore.js` fails loudly on a version mismatch and tells you to set
`MEDIA_KEK_PREVIOUS`, rather than letting you discover it one file at a time.

---

## 7. The rehearsal

Run this before go-live, then quarterly, and have the **deputy** do it — not the
person who wrote the procedure.

- [ ] Take a backup
- [ ] Restore into an empty database and an empty media directory
- [ ] `verify-restore.js` reports GREEN with no `FAIL` lines
- [ ] Open a restored photo and look at it — a decrypt that returns bytes is good
      evidence, an image that renders is proof
- [ ] Confirm a previously erased subject is still erased
- [ ] Time it, and write the number down. "How long until we are serving again"
      is the question that gets asked during an incident, and it should already
      have an answer

### Rehearsal of record — 2026-08-21

Run on the development database. What was actually done, not what was intended:

| Step | Result |
|---|---|
| Backup taken | 44 tables, 11,093 rows, 1,540 media files, 419.3 MB |
| Restored into a throwaway database and empty media tree | all rows and files restored, checksums verified on the way in |
| Keys checked against fingerprints | pass |
| Sealed media integrity | 1,540 files intact |
| **Real photos decrypted from the restored copy** | pass — 5 sampled blobs opened, non-empty |
| Wrong `MEDIA_KEK` deliberately supplied | correctly detected: `WRONG KEY: MEDIA_KEK` |
| A backup file deliberately corrupted | correctly detected: `1 of 1540 corrupt or missing` |
| Real erasure performed, then backed up | tombstone recorded, salt confirmed `NULL` |
| Erasure re-verified | pass — `all 1 tombstoned subjects remain destroyed` |
| Pre-erasure backup restored over the top | resurrection detected and the subject named |

**Found during the rehearsal, and fixed:** the first attempt at the resurrection
test reported a clean restore when it should not have. `restore.js` inserts with
`skipDuplicates`, so restoring onto a database that still held the destroyed row
left it untouched — the resurrection never happened, and the run looked green.
The check was right; the test was wrong. Two changes came out of it: the
rehearsal now restores into a genuinely empty target, and `restore.js` reports
inserted and skipped rows separately, because "11,093 rows restored" was true of
the file and false of the database.

**Not yet rehearsed:** certificate verification after a restore, because this
database has never had a deletion certificate issued. `verify-restore.js` reports
that honestly as "nothing verified" rather than counting it as a pass. It becomes
a live check as soon as one DSAR erasure completes end to end — which is flow 04
of the manual walkthrough.

**Not yet done:** the production custody decisions in §2. Every box there is
still unticked.
