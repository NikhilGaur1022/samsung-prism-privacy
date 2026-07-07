import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { ArrowRight } from 'lucide-react'
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
      </main>
    </div>
  )
}
