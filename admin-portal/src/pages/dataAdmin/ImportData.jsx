import { useRef, useState } from 'react'
import { Search, Upload, ShieldAlert } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import EmptyState from '../../components/EmptyState'
import {
  closeImportBatch,
  createImportBatch,
  listProjects,
  searchDsarSubjects,
  uploadImportItems,
} from '../../lib/api'

// Admin-initiated import of a person's existing data (PLAN §G1).
//
// The screen is built around one honesty requirement: an imported photograph has
// no capture-time consent and was identified by an operator's assertion rather
// than by a face match. Both facts are recorded on every item, and this page
// says so before the first file is chosen — an import UI that felt like an
// ordinary upload would be inviting the operator to create unverified records
// without noticing.

const MAX_PER_REQUEST = 20

export default function ImportData() {
  const fileRef = useRef(null)

  const [term, setTerm] = useState('')
  const [results, setResults] = useState(null)
  const [subject, setSubject] = useState(null)

  const [projects, setProjects] = useState(null)
  const [projectId, setProjectId] = useState('')
  const [note, setNote] = useState('')

  const [batch, setBatch] = useState(null)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const runSearch = async (e) => {
    e.preventDefault()
    setError(null)
    setResults(null)
    if (term.trim().length < 2) return
    try {
      setResults(await searchDsarSubjects({ q: term.trim(), limit: 10 }))
    } catch (err) {
      setError(err)
    }
  }

  const pick = async (s) => {
    setSubject(s)
    setResults(null)
    setError(null)
    if (!projects) listProjects().then((r) => setProjects(r.items ?? r)).catch(() => setProjects([]))
  }

  const openBatch = async () => {
    setBusy(true)
    setError(null)
    try {
      setBatch(
        await createImportBatch({
          subjectId: subject.subjectId,
          projectId: projectId || undefined,
          note: note || undefined,
        }),
      )
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  // Chunked at the server's own per-request ceiling rather than at whatever the
  // operator dragged in. Sending 200 files in one request would be refused by
  // multer after the whole body had already been uploaded.
  const upload = async (fileList) => {
    const files = [...fileList]
    if (files.length === 0) return
    setBusy(true)
    setError(null)
    setProgress({ done: 0, total: files.length, ingested: 0, duplicates: 0 })

    try {
      for (let i = 0; i < files.length; i += MAX_PER_REQUEST) {
        const chunk = files.slice(i, i + MAX_PER_REQUEST)
        const result = await uploadImportItems(batch.id, chunk)
        setProgress((p) => ({
          ...p,
          done: p.done + chunk.length,
          ingested: p.ingested + (result.ingested ?? 0),
          duplicates: p.duplicates + (result.duplicates ?? 0),
        }))
      }
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const finish = async () => {
    setBusy(true)
    setError(null)
    try {
      const closed = await closeImportBatch(batch.id, note || undefined)
      setBatch(closed)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Import a person's data"
          subtitle="Bring a named person's existing photographs into the system so a DSAR can find them."
        />

        <div className="mt-5 flex items-start gap-2.5 rounded-card bg-warning-soft px-4 py-3 text-sm font-medium text-warning">
          <ShieldAlert size={17} className="mt-0.5 shrink-0" />
          <p>
            Imported data has no capture-time consent and no face match behind it. Unless you name a
            project with a live consent, every item is recorded as{' '}
            <strong>lawful basis unverified</strong>, identified by your assertion, and it will be
            surfaced that way in discovery and in any DSAR response. That is deliberate — the gap is
            shown, never hidden.
          </p>
        </div>

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        {/* --- 1. who --- */}
        <section className="mt-6 rounded-card bg-surface p-6 shadow-card">
          <h2 className="text-base font-bold text-ink">1 · Who is this data about?</h2>

          {subject ? (
            <div className="mt-3 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{subject.fullName}</p>
                <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                  {subject.email} · {subject.itemCount} items already held
                </p>
              </div>
              {!batch && (
                <button
                  type="button"
                  onClick={() => setSubject(null)}
                  className="text-xs font-bold text-brand underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Change
                </button>
              )}
            </div>
          ) : (
            <>
              <form onSubmit={runSearch} className="mt-3 flex gap-2">
                <div className="relative max-w-md flex-1">
                  <Search
                    size={15}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
                  />
                  <input
                    value={term}
                    onChange={(e) => setTerm(e.target.value)}
                    placeholder="Name, email or employee reference"
                    className="w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3 text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  />
                </div>
                <button
                  type="submit"
                  className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Search
                </button>
              </form>

              {results &&
                (results.items.length === 0 ? (
                  <EmptyState
                    title="No exact or prefix match"
                    message="Identity search never guesses — a wrong match here would import one person's photographs onto another person's record."
                  />
                ) : (
                  <ul className="mt-4 divide-y divide-border">
                    {results.items.map((s) => (
                      <li key={s.subjectId}>
                        <button
                          type="button"
                          disabled={s.status === 'ERASED'}
                          onClick={() => pick(s)}
                          className="flex w-full items-center justify-between gap-4 py-3 text-left disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-ink">{s.fullName}</p>
                            <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                              {s.email}
                            </p>
                          </div>
                          {s.status === 'ERASED' ? (
                            <StatusPill tone="danger">Erased — cannot import</StatusPill>
                          ) : (
                            <span className="text-xs font-semibold text-ink-muted">
                              {s.itemCount} items
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                ))}
            </>
          )}
        </section>

        {/* --- 2. basis --- */}
        {subject && !batch && (
          <section className="mt-4 rounded-card bg-surface p-6 shadow-card">
            <h2 className="text-base font-bold text-ink">2 · Under what basis?</h2>

            <label className="mt-3 block max-w-md">
              <span className="text-xs font-semibold text-ink-muted">
                Project (optional — only a live consent counts)
              </span>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <option value="">No project — record as unverified</option>
                {(projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="mt-3 block max-w-md">
              <span className="text-xs font-semibold text-ink-muted">
                Where did this data come from?
              </span>
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. handed over on a USB drive by the participant on 2026-07-30"
                className="mt-1 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              />
            </label>

            <button
              type="button"
              disabled={busy}
              onClick={openBatch}
              className="mt-4 rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              Open import batch
            </button>
          </section>
        )}

        {/* --- 3. files --- */}
        {batch && (
          <section className="mt-4 rounded-card bg-surface p-6 shadow-card">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-bold text-ink">3 · Photographs</h2>
              <StatusPill tone={batch.status === 'OPEN' ? 'warning' : 'success'}>
                Batch {batch.status}
              </StatusPill>
            </div>

            {batch.status === 'OPEN' ? (
              <>
                <label
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    upload(e.dataTransfer.files)
                  }}
                  className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-border py-10 text-center"
                >
                  <Upload size={20} strokeWidth={1.5} className="text-ink-faint" />
                  <span className="text-sm font-semibold text-ink">
                    Drop images here, or click to choose
                  </span>
                  <span className="text-xs font-medium text-ink-faint">
                    Sent {MAX_PER_REQUEST} at a time. JPEG, PNG, WebP or HEIC, 25 MB each.
                  </span>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    accept="image/*"
                    disabled={busy}
                    onChange={(e) => upload(e.target.files)}
                    className="hidden"
                  />
                </label>

                {progress && (
                  <div className="mt-4">
                    <div className="h-1.5 w-full overflow-hidden rounded-pill bg-canvas">
                      <div
                        className="h-full bg-brand transition-all"
                        style={{ width: `${(progress.done / progress.total) * 100}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs font-medium text-ink-muted">
                      {progress.done} of {progress.total} sent · {progress.ingested} imported
                      {progress.duplicates > 0 &&
                        ` · ${progress.duplicates} already held for this person`}
                    </p>
                  </div>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={finish}
                  className="mt-5 rounded-lg border border-border px-4 py-2 text-sm font-bold text-ink disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  Close batch
                </button>
              </>
            ) : (
              <p className="mt-3 text-sm font-medium text-ink-muted">
                {batch.itemsDone} item(s) imported, {batch.itemsFailed} failed. They are indexed and
                will appear in this person&apos;s DSAR item list and in the discovery walk.
              </p>
            )}
          </section>
        )}
      </main>
    </div>
  )
}
