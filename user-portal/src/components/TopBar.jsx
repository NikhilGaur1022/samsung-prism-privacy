import { Menu, ArrowLeft, User, MoreVertical } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export default function TopBar({ back = false, title }) {
  const navigate = useNavigate()
  return (
    <header className="flex items-center justify-between px-4 py-4 md:px-8 md:py-6">
      {back ? (
        <button
          onClick={() => navigate(-1)}
          className="flex h-9 w-9 items-center justify-center rounded-full text-ink hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          aria-label="Go back"
        >
          <ArrowLeft size={20} strokeWidth={1.75} />
        </button>
      ) : (
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full text-ink hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand md:hidden"
          aria-label="Menu"
        >
          <Menu size={22} strokeWidth={1.75} />
        </button>
      )}
      {title && <span className="hidden md:block text-sm font-semibold text-ink-muted">{title}</span>}
      <div className="flex items-center gap-1">
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full bg-canvas text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          aria-label="Account"
        >
          <User size={18} strokeWidth={1.75} />
        </button>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full text-ink-muted hover:bg-black/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          aria-label="More options"
        >
          <MoreVertical size={20} strokeWidth={1.75} />
        </button>
      </div>
    </header>
  )
}
