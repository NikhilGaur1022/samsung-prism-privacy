import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { listDsar, searchDsarSubjects } from '../../lib/api'
import { COARSE_TABS, STATUS_TONE } from '../../lib/lifecycle'

// The DSAR dashboard.
//
// `GET /dsar` returns `{ items, nextCursor, counts }` — it is no longer a bare
// array, and the tab badges come from `counts` rather than from the length of
// the page, so "12 open" means twelve open requests and not twelve rows that
// happened to fit on this page.
//
// Rows link to /dsar/:requestId, the workspace. The old link went to
// /purge-export, which is the erasure console: it answers "run the purge", not
// "what is this request and what has happened to it".

const TYPE_OPTIONS = ['ACCESS', 'CORRECT', 'ERASE', 'WITHDRAWAL_ERASURE', 'GRIEVANCE', 'NOMINATION']

const FIELD_CLASS =
  'rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-semibold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

function Counters({ request }) {
  const c = request.counters ?? {}
  const parts = [
    c.itemsFound != null && `${c.itemsFound} found`,
    c.itemsRedacted ? `${c.itemsRedacted} redacted` : null,
    c.itemsDeleted ? `${c.itemsDeleted} deleted` : null,
    c.itemsExported ? `${c.itemsExported} exported` : null,
  ].filter(Boolean)
  if (parts.length === 0) return null
  return <span className="text-xs font-medium text-ink-faint"> · {parts.join(' · ')}</span>
}

export default function DsarQueue() {
  const navigate = useNavigate()
  const [coarse, setCoarse] = useState('OPEN')
  const [type, setType] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  const [term, setTerm] = useState('')
  const [results, setResults] = useState(null)
  const [searchError, setSearchError] = useState(null)

  const reload = useCallback(() => {
    setData(null)
    setError(null)
    const params = { coarse }
    if (type) params.type = type
    listDsar(params).then(setData).catch(setError)
  }, [coarse, type])

  useEffect(() => {
    reload()
  }, [reload])

  // Deliberately submit-on-enter rather than search-as-you-type: every returned
  // principal costs an AccessEvent, and a keystroke-per-query box would write a
  // read-log entry for people the handler never meant to look at.
  const runSearch = async (e) => {
    e.preventDefault()
    setSearchError(null)
    setResults(null)
    if (term.trim().length < 2) return
    try {
      setResults(await searchDsarSubjects({ q: term.trim(), limit: 10 }))
    } catch (err) {
      setSearchError(err)
    }
  }

  const counts = data?.counts ?? {}

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="DSAR Dashboard"
          subtitle="Every data subject request, what state it is in, and what has been done to the data."
          action={
            <select className={FIELD_CLASS} value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          }
        />

        <form onSubmit={runSearch} className="mt-6 flex gap-2">
          <div className="relative max-w-md flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Find a person — name, email or employee reference"
              className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            />
          </div>
          <button
            type="submit"
            className="rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Search
          </button>
        </form>
        <p className="mt-1 text-xs font-medium text-ink-faint">
          Exact and prefix matches only — never fuzzy. A wrong match would show one person another
          person&apos;s data. Every result is written to the access log.
        </p>

        {searchError && (
          <div className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm font-semibold text-danger">
            {searchError.message}
          </div>
        )}

        {results && (
          <div className="mt-4">
            <ListPanel
              title={`People matching “${term.trim()}”`}
              rows={results.items}
              emptyTitle="No exact or prefix match"
              emptyMessage="Identity search does not guess. Try the full name, email or employee reference."
              renderRow={(s) => (
                <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{s.fullName}</p>
                    <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                      {s.email}
                      {s.employeeRef && ` · ${s.employeeRef}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <StatusPill tone={s.status === 'ERASED' ? 'danger' : 'neutral'}>
                      {s.status}
                    </StatusPill>
                    <span className="text-xs font-semibold text-ink-muted">{s.itemCount} items</span>
                  </div>
                </div>
              )}
            />
          </div>
        )}

        <div className="mt-6 flex gap-1 border-b border-border">
          {COARSE_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setCoarse(tab.key)}
              className={`-mb-px border-b-2 px-4 py-2 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                coarse === tab.key
                  ? 'border-brand text-brand'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {tab.label}
              {counts[tab.key] != null && (
                <span className="ml-2 rounded-pill bg-canvas px-2 py-0.5 text-xs font-semibold text-ink-muted">
                  {counts[tab.key]}
                </span>
              )}
            </button>
          ))}
        </div>

        {error && (
          <div className="mt-5 rounded-lg bg-danger-soft px-3 py-2.5 text-sm font-semibold text-danger">
            {error.message}
          </div>
        )}

        <div className="mt-6">
          <ListPanel
            title="Requests"
            rows={data?.items ?? []}
            loading={!data && !error}
            emptyTitle="Nothing in this tab"
            renderRow={(r) => (
              <Link
                to={`/dsar/${r.id}`}
                className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <div className="min-w-0">
                  {/* The server decides which of the two it sends: a dpo gets
                      `subjectRef` (a pseudonym) and no `subjectId` at all, per
                      matrix §D. Rendering whichever arrived means this row
                      cannot leak an identity the API withheld — and cannot
                      manufacture a pseudonym the API did not issue. */}
                  <p className="truncate text-sm font-semibold text-ink">
                    {r.subjectRef ?? (r.subjectId ? `${r.subjectId.slice(0, 8)}…` : '—')} — {r.type}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    SLA due {new Date(r.sla.dueAt).toLocaleDateString()}
                    {r.sla.breached && ' · breached'}
                    {r.assignedAdminId
                      ? ` · assigned ${r.assignedAdminId.slice(0, 8)}`
                      : ' · unassigned'}
                    <Counters request={r} />
                  </p>
                </div>
                <StatusPill tone={r.sla.breached ? 'danger' : STATUS_TONE[r.status]}>
                  {r.sla.breached ? 'SLA breached' : r.status}
                </StatusPill>
              </Link>
            )}
          />
        </div>

        {data?.nextCursor && (
          <div className="mt-4 flex justify-center">
            <button
              type="button"
              onClick={() => {
                const params = { coarse, cursor: data.nextCursor }
                if (type) params.type = type
                listDsar(params)
                  .then((next) =>
                    setData((prev) => ({
                      ...next,
                      items: [...(prev?.items ?? []), ...next.items],
                    })),
                  )
                  .catch(setError)
              }}
              className="rounded-lg border border-border px-4 py-2 text-sm font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              Load more
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => navigate('/import')}
          className="mt-8 text-sm font-semibold text-brand underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          Import a person&apos;s existing data →
        </button>
      </main>
    </div>
  )
}
