import { Component } from 'react'
import { AlertTriangle } from 'lucide-react'

// There was no error boundary anywhere in this codebase until now, which is why
// a render crash presented as a blank white page with nothing in the UI and
// everything in the console. That cost a full debugging session on
// /requests/new: the symptom looked like a failed fetch and was a thrown render.
//
// React only recovers from a render error if a class component catches it —
// hooks cannot. So this stays a class.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Console, not an API call. An error reporter that itself needs the network
    // is one more thing that can fail while the page is already broken — and
    // this portal renders personal data, so a crash payload is the last thing
    // that should be posted anywhere without a decision behind it.
    console.error('Render crash caught by ErrorBoundary', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="flex min-h-svh items-center justify-center bg-canvas px-6">
        <div className="max-w-md rounded-card bg-surface p-8 text-center shadow-card">
          <AlertTriangle size={26} strokeWidth={1.5} className="mx-auto text-danger" />
          <h1 className="mt-3 text-lg font-extrabold text-ink">This screen failed to render</h1>
          <p className="mt-2 text-sm font-medium text-ink-muted">
            Nothing was changed and no data was sent. Reloading usually clears it; if it does not,
            the message below is what to report.
          </p>
          <p className="mt-4 break-words rounded-lg bg-canvas px-3 py-2 text-left font-mono text-xs text-ink-faint">
            {String(this.state.error?.message ?? this.state.error)}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-lg bg-brand px-4 py-2 text-sm font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
