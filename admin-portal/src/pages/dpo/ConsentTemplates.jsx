import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import ListPanel from '../../components/ListPanel'
import StatusPill from '../../components/StatusPill'
import { useMockQuery } from '../../lib/useMockQuery'
import { fetchMock } from '../../lib/mockApi'
import { CONSENT_TEMPLATES } from '../../data/dpo'

export default function ConsentTemplates() {
  const { data, loading, error } = useMockQuery(() => fetchMock(CONSENT_TEMPLATES), [])

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8">
        <PageHeader
          title="Consent Templates"
          subtitle="Master consent language reused across data collection projects."
        />

        <div className="mt-6">
          <ListPanel
            title="Templates"
            rows={data ?? []}
            loading={loading}
            error={error}
            emptyTitle="No templates yet"
            emptyMessage="Consent templates created by the Data Team will show up here."
            renderRow={(t) => (
              <div className="flex items-center justify-between gap-4 py-4 first:pt-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{t.name}</p>
                  <p className="mt-0.5 truncate text-xs font-medium text-ink-faint">
                    {t.locale} · updated {t.updated} · used by {t.linkedProjects} project
                    {t.linkedProjects === 1 ? '' : 's'}
                  </p>
                </div>
                <StatusPill tone="brand">{t.version}</StatusPill>
              </div>
            )}
          />
        </div>
      </main>
    </div>
  )
}
