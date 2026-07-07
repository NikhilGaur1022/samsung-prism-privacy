export default function StatCard({ label, value }) {
  return (
    <div className="rounded-card bg-surface p-5 shadow-card">
      <p className="text-2xl font-extrabold text-ink">{value}</p>
      <p className="mt-1 text-sm font-medium text-ink-muted">{label}</p>
    </div>
  )
}
