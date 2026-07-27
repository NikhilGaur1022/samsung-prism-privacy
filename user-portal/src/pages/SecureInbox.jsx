import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Award, Download, Inbox } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import { createDsarPackageToken, downloadMyDsarPackage, getMyDsarCertificate, listMyDsarRequests } from '../lib/api'

// The token is single-use and short-lived: it is requested and consumed in
// the same click, never stored in state beyond the local function scope,
// never shown to the principal, and never placed in a re-clickable link.
function PackageDownload({ requestId }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(false)

  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      const { token } = await createDsarPackageToken(requestId)
      const { blob, filename } = await downloadMyDsarPackage(requestId, token)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      setDone(true)
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={download}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-pill bg-brand px-3 py-2 text-xs font-bold text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
      >
        <Download size={14} strokeWidth={2} />
        {busy ? 'Preparing download…' : 'Download my data'}
      </button>
      {error && (
        <p className="mt-2 text-[11px] font-semibold text-danger">
          {error.status === 404
            ? 'Your package has not been built yet — this request is still being processed.'
            : error.status === 410
              ? 'This package has expired or was already used and can no longer be downloaded.'
              : error.message}
        </p>
      )}
      {done && !error && <p className="mt-2 text-[11px] font-semibold text-success">Downloaded.</p>}
    </div>
  )
}

function CertificateStatus({ requestId }) {
  const [state, setState] = useState('loading')

  useEffect(() => {
    getMyDsarCertificate(requestId)
      .then(() => setState('available'))
      .catch((err) => setState(err.status === 404 ? 'none' : 'error'))
  }, [requestId])

  if (state === 'loading') return <p className="mt-2 text-xs font-medium text-ink-faint">Checking for a certificate…</p>
  if (state === 'error') return <p className="mt-2 text-xs font-semibold text-danger">Could not check for a certificate.</p>
  if (state === 'none') return null

  return (
    <Link
      to={`/requests/${requestId}/certificate`}
      className="mt-3 flex items-center gap-2 rounded-pill bg-brand-soft px-3 py-2 text-xs font-bold text-brand w-fit focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      <Award size={14} strokeWidth={2} />
      View deletion certificate
    </Link>
  )
}

// The principal's own copy of outcomes: closed requests, any certificate issued
// for an erasure, and a package download for a closed access request. Nothing
// here is guessed — a request that closed without an EXPORT_PACKAGE evidence
// entry simply has no download offered.
export default function SecureInbox() {
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    listMyDsarRequests()
      .then((res) => setItems(res.items.filter((r) => r.status === 'CLOSED' || r.status === 'REJECTED')))
      .catch(setError)
  }, [])

  return (
    <div>
      <TopBar title="Secure Inbox" />
      <div className="px-4 md:px-8 pb-6">
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Secure Inbox</h1>
        <p className="mt-1 text-sm font-medium text-ink-muted">
          Outcomes of your closed requests, including any certificates and package downloads.
        </p>

        {error && <p className="mt-4 text-sm font-semibold text-danger">{error.message}</p>}

        {!items ? (
          <p className="mt-5 text-sm font-medium text-ink-muted">Loading…</p>
        ) : items.length === 0 ? (
          <div className="mt-8 flex flex-col items-center text-center">
            <IconChip icon={Inbox} tone="neutral" size="lg" />
            <p className="mt-3 text-sm font-medium text-ink-muted">Nothing here yet — closed requests will show up as they resolve.</p>
          </div>
        ) : (
          <div className="mt-5 space-y-3">
            {items.map((r) => (
              <Card key={r.id}>
                <div className="flex items-center gap-3">
                  <IconChip icon={Inbox} tone={r.status === 'CLOSED' ? 'success' : 'danger'} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-ink">{r.type} request</p>
                    <p className="text-xs font-medium text-ink-muted">
                      {r.status === 'CLOSED' ? 'Closed' : 'Rejected'}{' '}
                      {r.closedAt && new Date(r.closedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Badge tone={r.status === 'CLOSED' ? 'success' : 'danger'}>{r.status}</Badge>
                </div>

                {r.status === 'CLOSED' && r.resolutionNote && (
                  <p className="mt-2 text-xs font-medium text-ink-muted">{r.resolutionNote}</p>
                )}
                {r.status === 'REJECTED' && r.rejectionReason && (
                  <p className="mt-2 text-xs font-medium text-danger">{r.rejectionReason}</p>
                )}

                {r.status === 'CLOSED' && ['ERASE', 'WITHDRAWAL_ERASURE'].includes(r.type) && (
                  <CertificateStatus requestId={r.id} />
                )}

                {r.status === 'CLOSED' && r.type === 'ACCESS' && (
                  <PackageDownload requestId={r.id} />
                )}

                <Link
                  to={`/requests/${r.id}`}
                  className="mt-3 inline-block text-xs font-semibold text-brand focus-visible:outline-none"
                >
                  View full request →
                </Link>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
