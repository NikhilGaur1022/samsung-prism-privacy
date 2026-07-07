import { Inbox } from 'lucide-react'

export default function EmptyState({ icon: Icon = Inbox, title, message }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <Icon size={22} strokeWidth={1.5} className="text-ink-faint" />
      <p className="text-sm font-semibold text-ink">{title}</p>
      {message && <p className="max-w-xs text-xs font-medium text-ink-faint">{message}</p>}
    </div>
  )
}
