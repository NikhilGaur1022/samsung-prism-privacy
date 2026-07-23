import { useEffect, useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import EmptyState from '../../components/EmptyState'
import { ArrowRight, Loader2, Share2 } from 'lucide-react'
import { getLineage } from '../../lib/api'
import { LINEAGE_NODES, LINEAGE_EDGES } from '../../data/dataAdmin'

const KIND_TONE = {
  source: 'border-transparent bg-brand-soft text-brand',
  store: 'border-border bg-canvas text-ink',
  derived: 'border-border bg-canvas text-ink',
  output: 'border-transparent bg-success-soft text-success',
}

function buildLayers(nodes, edges) {
  const incoming = new Map(nodes.map((n) => [n.id, 0]))
  edges.forEach(([, to]) => incoming.set(to, (incoming.get(to) ?? 0) + 1))

  const depth = new Map()
  const parentsOf = (id) => edges.filter(([, to]) => to === id).map(([from]) => from)

  const resolve = (id) => {
    if (depth.has(id)) return depth.get(id)
    const parents = parentsOf(id)
    const d = parents.length === 0 ? 0 : Math.max(...parents.map(resolve)) + 1
    depth.set(id, d)
    return d
  }
  nodes.forEach((n) => resolve(n.id))

  const layers = []
  nodes.forEach((n) => {
    const d = depth.get(n.id)
    layers[d] = layers[d] || []
    layers[d].push(n)
  })
  return layers
}

// One row per photo_subjects entry: photo → subject → consent → project. That
// chain is exactly what a DSAR erasure walks, so rendering it is the evidence.
function LineageRows() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getLineage().then(setData).catch(setError)
  }, [])

  if (error) return <p className="mt-4 text-sm font-semibold text-danger">{error.message}</p>
  if (!data) return <Loader2 size={18} className="mt-4 animate-spin text-ink-faint" />

  if (data.items.length === 0) {
    return (
      <div className="mt-4 rounded-card bg-surface p-6 shadow-card">
        <EmptyState
          icon={Share2}
          title="No photo lineage yet"
          message="Links appear once a collection session is finalized."
        />
      </div>
    )
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-card bg-surface p-4 shadow-card">
      <table className="min-w-full text-left text-xs">
        <thead className="text-ink-faint">
          <tr>
            <th className="py-2 pr-4 font-bold uppercase tracking-wide">Photo</th>
            <th className="py-2 pr-4 font-bold uppercase tracking-wide">Session</th>
            <th className="py-2 pr-4 font-bold uppercase tracking-wide">Subject</th>
            <th className="py-2 pr-4 font-bold uppercase tracking-wide">Consent</th>
            <th className="py-2 pr-4 font-bold uppercase tracking-wide">Project</th>
            <th className="py-2 font-bold uppercase tracking-wide">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {data.items.map((row) => (
            <tr key={row.id}>
              <td className="py-2 pr-4 font-mono text-ink-muted">{row.sha256.slice(0, 12)}</td>
              <td className="py-2 pr-4 text-ink-muted">{row.sessionCode}</td>
              <td className="py-2 pr-4 font-semibold text-ink">{row.subjectName}</td>
              <td className="py-2 pr-4 font-mono text-ink-muted">{row.consentId.slice(0, 8)}</td>
              <td className="py-2 pr-4 text-ink-muted">{row.projectName}</td>
              <td className="py-2">
                <StatusPill tone={row.consentStatus === 'ACTIVE' ? 'success' : 'danger'}>
                  {row.consentStatus}
                </StatusPill>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function DataLineage() {
  const layers = buildLayers(LINEAGE_NODES, LINEAGE_EDGES)

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Data Lineage"
          subtitle="Where a subject's data flows from intake through to export or purge."
        />

        <div className="mt-6 overflow-x-auto rounded-card bg-surface p-6 shadow-card">
          <div className="flex min-w-max items-center gap-6">
            {layers.map((layer, i) => (
              <div key={i} className="flex items-center gap-6">
                <div className="flex flex-col gap-3">
                  {layer.map((node) => (
                    <div
                      key={node.id}
                      className={`rounded-lg border px-4 py-2.5 text-sm font-semibold ${KIND_TONE[node.kind]}`}
                    >
                      {node.label}
                    </div>
                  ))}
                </div>
                {i < layers.length - 1 && (
                  <ArrowRight size={18} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
                )}
              </div>
            ))}
          </div>
        </div>

        <h2 className="mt-8 text-base font-bold text-ink">Photo → subject → consent</h2>
        <p className="text-xs font-medium text-ink-faint">
          Every link written at session finalize. Erasing a consent erases these rows and the
          photos they point at.
        </p>
        <LineageRows />
      </main>
    </div>
  )
}
