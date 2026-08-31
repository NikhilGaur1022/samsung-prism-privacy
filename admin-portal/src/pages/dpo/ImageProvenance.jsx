import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Upload, ShieldCheck, ShieldAlert, ShieldX, ArrowRight } from 'lucide-react'

import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import { lookupImageProvenance, getMe } from '../../lib/api'

// "Where did this picture come from?" — asked of a file, not of the database.
//
// Every JPEG the export pipeline has ever written carries a signed EXIF + XMP
// stamp naming its project, session, export job and the people on it (as
// export-scoped pseudonyms). lib/imageMetadata.js has written it since the
// pipeline landed and exports readStamp() with a docstring promising "the
// verification endpoint" — which did not exist. Nothing could ask an image what
// it was. This page is the asking.
//
// It names people, which the stamp deliberately does not. That is why it is
// dpo/super_admin only and why every resolution is written to the access ledger
// against the administrator who ran it.

const SIGNATURE_TONE = {
  VALID: 'success',
  BAD_SIGNATURE: 'danger',
  KEY_ID_MISMATCH: 'warning',
}

const SIGNATURE_LABEL = {
  VALID: 'Signature valid',
  BAD_SIGNATURE: 'Signature does not verify — the stamp was altered',
  KEY_ID_MISMATCH: 'Signed under a rotated key — cannot be checked here',
  MALFORMED: 'Stamp is malformed',
  UNREADABLE_PAYLOAD: 'Stamp payload could not be decoded',
}

function Field({ label, children }) {
  if (children === null || children === undefined || children === '') return null
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">{label}</p>
      <p className="mt-0.5 break-words text-sm font-semibold text-ink">{children}</p>
    </div>
  )
}

function Panel({ title, action, children }) {
  return (
    <section className="rounded-card bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-faint">{title}</h2>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

const when = (d) => (d ? new Date(d).toLocaleString() : null)

export default function ImageProvenance() {
  const [file, setFile] = useState(null)
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [role, setRole] = useState(null)
  const inputRef = useRef(null)

  // Whether to offer the session link at all. matrix §A says dpo "cannot see any
  // personal data", so session.routes.js' mediaReaders guard excludes the role
  // and /sessions/:id/photos would 403 for exactly the person this page is for.
  // Rendering a link that 403s is worse than rendering none, so the session
  // record is shown inline and the link appears only for a role that can use it.
  useEffect(() => {
    getMe().then((me) => setRole(me?.role ?? null)).catch(() => setRole(null))
  }, [])
  const canOpenSessions = ['dataOwner', 'dataAdmin', 'super_admin'].includes(role)

  const choose = useCallback((next) => {
    if (!next) return
    setFile(next)
    setResult(null)
    setError(null)
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old)
      return URL.createObjectURL(next)
    })
  }, [])

  async function run() {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      setResult(await lookupImageProvenance(file))
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const sig = result?.stamp?.signature

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Image Provenance"
          subtitle="Upload an image that has left the platform to find the project, session and people it came from."
        />

        {/* Said before the upload, not after. Someone about to drop a file here
            should know the lookup is recorded before they run it, not discover
            it in the ledger afterwards. */}
        <p className="mt-4 max-w-3xl rounded-card bg-warning-soft px-4 py-3 text-xs font-semibold text-warning">
          Resolving an image to named people is recorded in the access ledger against your account,
          once for the image and once for each person identified. The stamp itself carries no names —
          only export-scoped pseudonyms — and this page undoes that on purpose.
        </p>

        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)] lg:items-start">
          {/* --- the drop target --- */}
          <div>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                choose(e.dataTransfer.files?.[0])
              }}
              onClick={() => inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed p-6 text-center transition ${
                dragging ? 'border-brand bg-brand-soft' : 'border-ink-faint/30 bg-surface'
              }`}
            >
              {preview ? (
                <img src={preview} alt="" className="max-h-56 w-full rounded-card object-contain" />
              ) : (
                <>
                  <Upload size={24} strokeWidth={1.75} className="text-ink-faint" />
                  <p className="mt-2 text-sm font-semibold text-ink">Drop an image, or click to choose</p>
                  <p className="mt-1 text-xs font-medium text-ink-faint">JPEG, WebP or AVIF · up to 20 MB</p>
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => choose(e.target.files?.[0])}
              />
            </div>

            {file && (
              <p className="mt-2 truncate text-xs font-medium text-ink-muted">
                {file.name} · {(file.size / 1024).toFixed(0)} KB
              </p>
            )}

            <button
              onClick={run}
              disabled={!file || busy}
              className="mt-3 w-full rounded-card bg-brand py-2.5 text-sm font-bold text-white shadow-card disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              {busy ? 'Reading…' : 'Trace this image'}
            </button>

            {error && (
              <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
                {error.message}
              </div>
            )}
          </div>

          {/* --- the answer --- */}
          <div className="space-y-6">
            {!result && !busy && (
              <div className="rounded-card bg-surface p-8 text-center shadow-card">
                <p className="text-sm font-medium text-ink-muted">
                  The result appears here: which project and session the image came from, which export
                  took it out and on whose authority, and who is in it.
                </p>
              </div>
            )}

            {result && !result.identified && (
              <Panel title="Not identified">
                <div className="flex items-start gap-3">
                  <ShieldX size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-faint" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">This image could not be traced</p>
                    <p className="mt-1 text-sm font-medium text-ink-muted">{result.note}</p>
                    <p className="mt-2 font-mono text-[11px] text-ink-faint">sha256 {result.uploadedHash}</p>
                  </div>
                </div>
              </Panel>
            )}

            {result?.identified && (
              <>
                <Panel
                  title="Verdict"
                  action={
                    <StatusPill tone={result.method === 'STAMP' ? SIGNATURE_TONE[sig] ?? 'warning' : 'brand'}>
                      {result.method === 'STAMP' ? SIGNATURE_LABEL[sig] ?? sig : 'Matched by content hash'}
                    </StatusPill>
                  }
                >
                  <div className="flex items-start gap-3">
                    {sig === 'VALID' ? (
                      <ShieldCheck size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-success" />
                    ) : (
                      <ShieldAlert size={20} strokeWidth={1.75} className="mt-0.5 shrink-0 text-warning" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink">
                        {result.method === 'STAMP'
                          ? 'This image carries a PRISM export stamp.'
                          : 'This image has no stamp, but its bytes match an image held here exactly.'}
                      </p>
                      {result.note && (
                        <p className="mt-1 text-sm font-medium text-ink-muted">{result.note}</p>
                      )}
                      <div className="mt-3 grid gap-4 sm:grid-cols-2">
                        <Field label="Carrier">{result.stamp?.carrier?.toUpperCase()}</Field>
                        <Field label="Stamped at">{when(result.stamp?.stampedAt)}</Field>
                        <Field label="Redaction">{result.stamp?.redaction}</Field>
                        <Field label="Signing key">{result.stamp?.keyId}</Field>
                      </div>
                      {result.sourceIntegrity?.checked && (
                        <p
                          className={`mt-3 text-xs font-semibold ${
                            result.sourceIntegrity.matches ? 'text-success' : 'text-warning'
                          }`}
                        >
                          {result.sourceIntegrity.matches
                            ? 'The source held here still hashes to what the stamp claims — it has not changed since export.'
                            : 'The source held here no longer hashes to what the stamp claims. The stored image changed after this copy was exported.'}
                        </p>
                      )}
                      <p className="mt-2 font-mono text-[11px] text-ink-faint">
                        uploaded sha256 {result.uploadedHash}
                      </p>
                    </div>
                  </div>
                </Panel>

                <Panel
                  title="Project"
                  action={
                    result.project?.id && result.project?.present !== false ? (
                      <Link
                        to="/project-reports"
                        className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
                      >
                        Project reports <ArrowRight size={13} strokeWidth={2} />
                      </Link>
                    ) : null
                  }
                >
                  {result.project?.present === false ? (
                    <p className="text-sm font-medium text-ink-muted">
                      The project row is gone — closed and purged. Id {result.project.id}
                    </p>
                  ) : result.project ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Name">{result.project.name}</Field>
                      <Field label="Status">{result.project.status}</Field>
                      <Field label="Purpose">{result.project.purpose}</Field>
                      <Field label="Retention">{result.project.retention}</Field>
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-ink-muted">No project on the stamp.</p>
                  )}
                </Panel>

                <Panel
                  title="Collection session"
                  action={
                    canOpenSessions && result.session?.id && result.session?.present !== false ? (
                      <Link
                        to={`/sessions/${result.session.id}/photos`}
                        className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline"
                      >
                        Open session <ArrowRight size={13} strokeWidth={2} />
                      </Link>
                    ) : null
                  }
                >
                  {result.session?.present === false ? (
                    <p className="text-sm font-medium text-ink-muted">
                      The session row is gone. Id {result.session.id}
                    </p>
                  ) : result.session ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Code">{result.session.code}</Field>
                      <Field label="Status">{result.session.status}</Field>
                      <Field label="Location">{result.session.location}</Field>
                      <Field label="Captured by">{result.session.agent?.email}</Field>
                      <Field label="Started">{when(result.session.createdAt)}</Field>
                      <Field label="Archived">{when(result.session.archivedAt)}</Field>
                      <Field label="Photos in session">{result.session._count?.photos}</Field>
                      <Field label="Participants">{result.session._count?.participants}</Field>
                    </div>
                  ) : (
                    <p className="text-sm font-medium text-ink-muted">No session on the stamp.</p>
                  )}
                </Panel>

                {result.export && (
                  <Panel title="Export that took it out">
                    {result.export.present === false ? (
                      <p className="text-sm font-medium text-ink-muted">
                        The export job record is gone. Id {result.export.id}
                      </p>
                    ) : (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Requested by">{result.export.requestedBy?.email}</Field>
                        <Field label="Role">{result.export.requestedBy?.role}</Field>
                        <Field label="Status">{result.export.status}</Field>
                        <Field label="Scope">{result.export.scope}</Field>
                        <Field label="Built">{when(result.export.finishedAt ?? result.export.createdAt)}</Field>
                        <Field label="Expires">{when(result.export.expiresAt)}</Field>
                        <Field label="Photos in export">{result.export.photosTotal}</Field>
                        <Field label="Downloads">
                          {result.export.downloadCount != null
                            ? `${result.export.downloadCount}${
                                result.export.lastDownloadedAt
                                  ? ` · last ${when(result.export.lastDownloadedAt)}`
                                  : ''
                              }`
                            : null}
                        </Field>
                      </div>
                    )}
                  </Panel>
                )}

                <Panel title={`People in this image (${result.subjects?.identified?.length ?? 0})`}>
                  {result.subjects?.note && (
                    <p className="mb-3 text-sm font-medium text-ink-muted">{result.subjects.note}</p>
                  )}

                  {(result.subjects?.identified ?? []).map((person) => (
                    <div
                      key={person.ref}
                      className="flex flex-wrap items-center justify-between gap-3 border-b border-canvas py-3 first:pt-0 last:border-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-ink">{person.fullName}</p>
                        <p className="truncate text-xs font-medium text-ink-faint">
                          {person.email} · ref {person.ref.slice(0, 12)}…
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusPill tone={person.subjectStatus === 'ACTIVE' ? 'neutral' : 'warning'}>
                          {person.subjectStatus}
                        </StatusPill>
                        <StatusPill
                          tone={
                            person.consent?.status === 'ACTIVE'
                              ? 'success'
                              : person.consent?.status === 'REVOKED'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          {person.consent?.status === 'REVOKED' && person.consent.revokedAt
                            ? `Withdrawn ${new Date(person.consent.revokedAt).toLocaleDateString()}`
                            : (person.consent?.status ?? 'No consent record')}
                        </StatusPill>
                      </div>
                    </div>
                  ))}

                  {/* The single most important thing this page can say. A ref that
                      matches nobody means the person was erased AFTER the export —
                      so the copy in someone's hand is data that outlived a deletion
                      the principal was told was complete. Reporting it as an empty
                      list would hide exactly the finding worth acting on. */}
                  {(result.subjects?.unmatchedRefs ?? []).length > 0 && (
                    <div className="mt-4 rounded-card bg-danger-soft px-4 py-3">
                      <p className="text-sm font-bold text-danger">
                        {result.subjects.unmatchedRefs.length} person
                        {result.subjects.unmatchedRefs.length === 1 ? '' : 's'} on this image no longer
                        exist{result.subjects.unmatchedRefs.length === 1 ? 's' : ''} in the platform
                      </p>
                      <p className="mt-1 text-xs font-semibold text-danger">
                        Their link was erased after this export was built. This copy is personal data
                        that survived a deletion the principal was told was complete — assess it against
                        the breach and erasure-completeness obligations.
                      </p>
                      <p className="mt-2 font-mono text-[11px] text-danger">
                        {result.subjects.unmatchedRefs.join('  ')}
                      </p>
                    </div>
                  )}

                  {(result.subjects?.identified ?? []).length === 0 &&
                    (result.subjects?.unmatchedRefs ?? []).length === 0 &&
                    !result.subjects?.note && (
                      <p className="text-sm font-medium text-ink-muted">
                        The stamp names no one — this frame carried no subject refs.
                      </p>
                    )}
                </Panel>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
