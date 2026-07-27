import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronRight, FileText } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import { getMyDsarRequest, listMyDsarRequests } from '../lib/api'

const STATUS_TONE = {
  RECEIVED: 'neutral',
  TRIAGE: 'neutral',
  DISCOVERY: 'brand',
  EXECUTING: 'brand',
  REVIEW: 'warning',
  CLOSED: 'success',
  REJECTED: 'danger',
}

function SlaCountdown({ sla }) {
  if (sla.breached) {
    return <p className="text-xs font-bold text-danger">Overdue — statutory deadline was {new Date(sla.dueAt).toLocaleDateString()}</p>
  }
  return (
    <p className="text-xs font-semibold text-ink-muted">
      {sla.daysRemaining} day{sla.daysRemaining === 1 ? '' : 's'} remaining · due {new Date(sla.dueAt).toLocaleDateString()}
    </p>
  )
}

function RequestList() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    listMyDsarRequests().then((res) => setItems(res.items)).catch(setError)
  }, [])

  return (
    <div>
      <TopBar title="My Requests" />
      <div className="px-4 md:px-8 pb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">My Requests</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">Status of every rights request you have raised.</p>

        {error && <p className="mt-4 text-sm font-semibold text-danger">{error.message}</p>}

        {!items ? (
          <p className="mt-5 text-sm font-medium text-ink-muted">Loading…</p>
        ) : items.length === 0 ? (
          <div className="mt-5">
            <p className="text-sm font-medium text-ink-muted">You haven't raised any requests yet.</p>
            <Link
              to="/requests/new"
              className="mt-4 inline-block rounded-card bg-brand px-4 py-3 text-sm font-bold text-white shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              Raise a request
            </Link>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {items.map((r) => (
              <Link key={r.id} to={`/requests/${r.id}`} className="block rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                <Card className="flex items-center gap-3">
                  <IconChip icon={FileText} tone="brand" size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink">{r.type}</p>
                    <SlaCountdown sla={r.sla} />
                  </div>
                  <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Badge>
                  <ChevronRight size={16} className="text-ink-faint" />
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function RequestDetail({ id }) {
  const [request, setRequest] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getMyDsarRequest(id).then(setRequest).catch(setError)
  }, [id])

  if (error) {
    return (
      <div>
        <TopBar back />
        <div className="px-4 md:px-8">
          <p className="text-sm font-semibold text-danger">{error.message}</p>
        </div>
      </div>
    )
  }

  if (!request) {
    return (
      <div>
        <TopBar back />
        <div className="px-4 md:px-8">
          <p className="text-sm font-medium text-ink-muted">Loading…</p>
        </div>
      </div>
    )
  }

  const closed = request.status === 'CLOSED'
  const rejected = request.status === 'REJECTED'

  return (
    <div>
      <TopBar back />
      <div className="px-4 md:px-8 pb-6">
        <Badge tone={STATUS_TONE[request.status] ?? 'neutral'}>{request.status}</Badge>
        <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-ink">{request.type} request</h1>
        {request.description && (
          <p className="mt-2 text-sm font-medium leading-relaxed text-ink-muted">{request.description}</p>
        )}

        <Card className="mt-5">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">SLA</p>
          <SlaCountdown sla={request.sla} />
          {request.sla.internalBreached && (
            <p className="mt-1 text-xs font-medium text-ink-faint">Internal review target has also been missed.</p>
          )}
          <p className="mt-2 text-[11px] font-medium text-ink-faint">
            Raised {new Date(request.createdAt).toLocaleString()}
          </p>
          {closed && request.closedAt && (
            <p className="text-[11px] font-medium text-ink-faint">
              Closed {new Date(request.closedAt).toLocaleString()}
            </p>
          )}
        </Card>

        {rejected && request.rejectionReason && (
          <Card className="mt-3 bg-danger-soft">
            <p className="text-xs font-bold uppercase tracking-wide text-danger">Rejected</p>
            <p className="mt-1 text-sm font-medium text-danger">{request.rejectionReason}</p>
          </Card>
        )}

        {closed && request.resolutionNote && (
          <Card className="mt-3">
            <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Resolution note</p>
            <p className="mt-1 text-sm font-medium text-ink-muted">{request.resolutionNote}</p>
          </Card>
        )}

        {request.evidence?.length > 0 && (
          <>
            <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">Evidence on file</p>
            <div className="mt-3 space-y-2">
              {request.evidence.map((e) => (
                <Card key={e.id} className="flex items-center justify-between py-2.5">
                  <span className="text-xs font-semibold text-ink">{e.label}</span>
                  <span className="text-[11px] font-medium text-ink-faint">
                    {new Date(e.createdAt).toLocaleDateString()}
                  </span>
                </Card>
              ))}
            </div>
          </>
        )}

        {closed && (
          <Link
            to="/inbox"
            className="mt-6 block w-full rounded-card bg-brand py-3.5 text-center text-sm font-bold text-white shadow-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
          >
            View outcome in Secure Inbox
          </Link>
        )}
      </div>
    </div>
  )
}

export default function RequestStatus() {
  const { requestId } = useParams()
  return requestId ? <RequestDetail id={requestId} /> : <RequestList />
}
