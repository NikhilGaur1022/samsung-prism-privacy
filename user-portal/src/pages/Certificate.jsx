import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CircleCheck, CircleAlert, ShieldCheck } from 'lucide-react'
import TopBar from '../components/TopBar'
import Card from '../components/Card'
import Badge from '../components/Badge'
import IconChip from '../components/IconChip'
import { getMyDsarCertificate } from '../lib/api'

// Renders the DPDP erasure certificate exactly as the server verified it. A
// green tick appears only when verification.valid === true — a hash mismatch
// or a signature made under a different key must read as untrusted, not as a
// rendering inconvenience.
export default function Certificate() {
  const { requestId } = useParams()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getMyDsarCertificate(requestId).then(setData).catch(setError)
  }, [requestId])

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

  if (!data) {
    return (
      <div>
        <TopBar back />
        <div className="px-4 md:px-8">
          <p className="text-sm font-medium text-ink-muted">Loading…</p>
        </div>
      </div>
    )
  }

  const { certificate, verification } = data
  const payload = certificate.payload ?? {}
  const isValid = verification.valid === true

  return (
    <div>
      <TopBar back />
      <div className="px-4 md:px-8 pb-6">
        <div className="flex flex-col items-center text-center">
          <IconChip
            icon={isValid ? CircleCheck : CircleAlert}
            tone={isValid ? 'success' : 'danger'}
            size="lg"
          />
          <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-ink">Deletion Certificate</h1>
          <Badge tone={isValid ? 'success' : 'danger'} className="mt-2">
            {isValid ? 'Verified' : 'Not verified'}
          </Badge>
        </div>

        {!isValid && (
          <Card className="mt-5 bg-danger-soft">
            <p className="text-xs font-bold uppercase tracking-wide text-danger">Verification failed</p>
            <ul className="mt-2 space-y-1 text-xs font-medium text-danger">
              <li>Payload hash matches: {verification.hashMatches ? 'yes' : 'no'}</li>
              <li>Signature valid: {verification.signatureValid ? 'yes' : 'no'}</li>
            </ul>
            {verification.note && <p className="mt-2 text-xs font-semibold text-danger">{verification.note}</p>}
          </Card>
        )}

        {isValid && verification.note && (
          <Card className="mt-5 bg-warning-soft">
            <p className="text-xs font-medium text-warning">{verification.note}</p>
          </Card>
        )}

        <Card className="mt-5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} strokeWidth={1.75} className="text-brand" />
            <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">
              {payload.certificateType ?? 'DPDP_ERASURE'}
            </p>
          </div>
          <dl className="mt-3 space-y-2 text-xs">
            <Row label="Subject reference" value={payload.subjectPseudonym} mono />
            <Row label="Request type" value={payload.dsarType} />
            <Row label="Requested" value={payload.requestedAt && new Date(payload.requestedAt).toLocaleString()} />
            <Row label="Completed" value={payload.completedAt && new Date(payload.completedAt).toLocaleString()} />
            <Row label="Key destroyed" value={payload.keyDestroyedAt && new Date(payload.keyDestroyedAt).toLocaleString()} />
            <Row label="Locations purged" value={payload.locationsCount} />
            <Row label="Issuer" value={payload.issuer} />
          </dl>
        </Card>

        {payload.residualNote && (
          <Card className="mt-3">
            <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Residual data note</p>
            <p className="mt-1.5 text-xs font-medium leading-relaxed text-ink-muted">{payload.residualNote}</p>
          </Card>
        )}

        {Array.isArray(payload.locations) && payload.locations.length > 0 && (
          <>
            <p className="mt-6 text-xs font-bold uppercase tracking-wide text-ink-faint">
              Locations ({payload.locations.length})
            </p>
            <div className="mt-3 space-y-2">
              {payload.locations.map((loc, i) => (
                <Card key={i} className="flex items-center justify-between py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-semibold text-ink">{loc.locationCode}</p>
                    <p className="truncate text-[11px] font-medium text-ink-faint">{loc.objectType}</p>
                  </div>
                  <Badge tone={loc.status === 'DONE' ? 'success' : 'neutral'}>{loc.status}</Badge>
                </Card>
              ))}
            </div>
          </>
        )}

        <Card className="mt-5">
          <p className="text-xs font-bold uppercase tracking-wide text-ink-faint">Cryptographic details</p>
          <dl className="mt-2 space-y-2 text-[11px]">
            <Row label="Payload hash" value={certificate.payloadHash} mono />
            <Row label="Signing key" value={verification.signingKeyId} mono />
            <Row label="Current key" value={verification.currentKeyId} mono />
            <Row label="Algorithm" value={certificate.algorithm} />
          </dl>
        </Card>
      </div>
    </div>
  )
}

function Row({ label, value, mono }) {
  if (value === undefined || value === null || value === '') return null
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 font-semibold text-ink-faint">{label}</dt>
      <dd className={`text-right text-ink ${mono ? 'break-all font-mono' : 'font-medium'}`}>{String(value)}</dd>
    </div>
  )
}
