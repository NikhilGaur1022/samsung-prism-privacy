import { useState } from 'react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import { useMockStore } from '../../lib/mockStore'
import { MY_PROJECTS } from '../../data/dataOwner'
import { CheckCircle2 } from 'lucide-react'

const DATA_TYPES = ['XR Sessions', 'DSLR Photos', 'iPhone Media', 'Voice Samples']

const FIELD_CLASS =
  'mt-1.5 w-full rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

export default function CreateProject() {
  const [, setProjects] = useMockStore('data-owner-projects', MY_PROJECTS)
  const [name, setName] = useState('')
  const [dataType, setDataType] = useState(DATA_TYPES[0])
  const [description, setDescription] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!name.trim()) return

    setProjects((prev) => [
      {
        id: `proj-${Date.now()}`,
        name: name.trim(),
        status: 'pending_approval',
        progress: 0,
        dataType,
        description: description.trim(),
      },
      ...prev,
    ])

    setName('')
    setDescription('')
    setDataType(DATA_TYPES[0])
    setSubmitted(true)
  }

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Create Project"
          subtitle="New projects are submitted to the DPO / Legal Team for approval before collection can start."
        />

        <div className="mt-6 max-w-xl rounded-card bg-surface p-6 shadow-card">
          {submitted && (
            <div className="mb-5 flex items-center gap-2 rounded-lg bg-success-soft px-3 py-2.5 text-sm font-semibold text-success">
              <CheckCircle2 size={16} strokeWidth={2} />
              Project submitted for DPO approval.
            </div>
          )}

          <form onSubmit={handleSubmit}>
            <label className="block text-sm font-semibold text-ink">
              Project name
              <input
                className={FIELD_CLASS}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Wearable Health Signals"
                required
              />
            </label>

            <label className="mt-4 block text-sm font-semibold text-ink">
              Data type
              <select
                className={FIELD_CLASS}
                value={dataType}
                onChange={(e) => setDataType(e.target.value)}
              >
                {DATA_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label className="mt-4 block text-sm font-semibold text-ink">
              Description
              <textarea
                className={`${FIELD_CLASS} min-h-24 resize-y`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What is this project collecting, and why?"
              />
            </label>

            <button
              type="submit"
              className="mt-6 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-dark"
            >
              Submit for approval
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}
