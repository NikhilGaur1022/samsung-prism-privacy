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
| `GET /sessions/:id/photos/:pid/redacted` | ✓ own | ✗ | ✓ own project | ✓ own | ✓ | ✓ |
| `GET /sessions/:id/faces` (crops) | ✗ | ✗ | ✗ | ✓ TAGGING only | ✗ | ⚑ |
| `POST /sessions/:id/finalize` | ✗ | ✗ | ✗ | ✓ own | ✗ | ✓ |

### Subject / biometrics
| Endpoint | Subject | dpo | dataOwner | collectionAgent | dataAdmin | super |
|---|---|---|---|---|---|---|
| `GET /me` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/photos` | ✓ self | ✗ | ✗ | ✗ | ✗ | ✗ |
| `GET /me/photos/:pid/redacted` | ✓ self, others blurred | ✗ | ✗ | ✗ | ✗ | ✗ |
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
| `GET /dsar/evidence` (vault) | ✗ | ✓ all | ◐ assigned | ✗ | ✓ all | ✓ |
| `GET /dsar/:id/media` (break-glass targets) | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ |
| `GET /dsar` (queue) | ✗ | ✓ all | ◐ assigned | ✗ | ✓ all | ✓ |
| `POST /dsar/:id/assign` | ✗ | ✓ | ✗ | ✗ | ✗ | ✓ |
| `POST /dsar/:id/discovery` | ✗ | ✗ | ✓ assigned | ✗ | ✓ | ✓ |
| `POST /dsar/:id/evidence` | ✗ | ✗ | ✓ assigned | ✗ | ✓ | ✓ |
| `POST /dsar/:id/execute` | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ |
| `POST /dsar/:id/approve` | ✗ | ✓ | ✓ own | ✗ | ✗ | ✓ |
| `GET /dsar/:id/certificate` | ✓ own | ✓ | ◐ | ✗ | ✓ | ✓ |
| `GET /sla` | ✗ | ✓ | ◐ own | ✗ | ✓ | ✓ |

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
| Subject portal | own everything | any other subject |

Enforce via Prisma `select` allowlists in each service — never `include` a whole relation on a governance route.
