import { useState, useRef, useEffect, useMemo } from 'react'
import {
  FileText,
  Tag,
  Shield,
  ShieldAlert,
  Sparkles,
  CheckCircle,
  AlertCircle,
  Eye,
  Columns,
  Trash2,
  Lock,
  UserCheck,
  UserX,
  RefreshCw,
  Plus,
  Info,
} from 'lucide-react'
import {
  updateDocumentSpans,
  analyzeDocument,
  redactDocument,
} from '../lib/api'

const PII_COLORS = {
  PHONE_NUMBER: 'bg-amber-100 text-amber-900 border-amber-300',
  EMAIL_ADDRESS: 'bg-blue-100 text-blue-900 border-blue-300',
  PERSON: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  IN_AADHAAR: 'bg-rose-100 text-rose-900 border-rose-300',
  IN_PAN: 'bg-orange-100 text-orange-900 border-orange-300',
  IN_VOTER: 'bg-purple-100 text-purple-900 border-purple-300',
  IN_PASSPORT: 'bg-teal-100 text-teal-900 border-teal-300',
  IN_GSTIN: 'bg-indigo-100 text-indigo-900 border-indigo-300',
  IN_VEHICLE_REGISTRATION: 'bg-yellow-100 text-yellow-900 border-yellow-300',
  UPI_ID: 'bg-cyan-100 text-cyan-900 border-cyan-300',
  IFSC_CODE: 'bg-sky-100 text-sky-900 border-sky-300',
  BANK_ACCOUNT: 'bg-red-100 text-red-900 border-red-300',
  CAMPUS_ID: 'bg-violet-100 text-violet-900 border-violet-300',
  SECRET: 'bg-fuchsia-100 text-fuchsia-900 border-fuchsia-300',
  DATE_TIME: 'bg-stone-100 text-stone-900 border-stone-300',
  LOCATION: 'bg-lime-100 text-lime-900 border-lime-300',
}

const REDACTION_REASONS = [
  'AGENT_MANUAL_REDACTION',
  'UNCONSENTED_SUBJECT',
  'CONFIDENTIAL_BUSINESS_INFO',
  'TRADE_SECRET',
  'UNTAGGED_PROSE',
  'SECURITY_CREDENTIAL',
]

export default function TextDocumentEditor({
  sessionId,
  document: initialDoc,
  rawText = '',
  redactedText: initialRedactedText = '',
  participants = [],
  onDocumentUpdated,
}) {
  const [doc, setDoc] = useState(initialDoc)
  const [spans, setSpans] = useState(initialDoc.spans || [])
  const [piiEntities, setPiiEntities] = useState([])
  const [redactedText, setRedactedText] = useState(initialRedactedText)
  const [viewMode, setViewMode] = useState('editor') // 'editor' | 'redacted' | 'diff'
  const [analyzing, setAnalyzing] = useState(false)
  const [redacting, setRedacting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [successMsg, setSuccessMsg] = useState(null)

  // Selection state
  const [selection, setSelection] = useState(null) // { start: number, end: number, text: string }
  const [selectedSubjectId, setSelectedSubjectId] = useState('')
  const [selectedAction, setSelectedAction] = useState('KEEP_NON_PII')
  const [manualReason, setManualReason] = useState('AGENT_MANUAL_REDACTION')

  const textRef = useRef(null)

  useEffect(() => {
    setDoc(initialDoc)
    setSpans(initialDoc.spans || [])
    setRedactedText(initialRedactedText)
  }, [initialDoc, initialRedactedText])

  // Handle text selection inside the document text container
  const handleMouseUp = () => {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      return
    }

    const range = sel.getRangeAt(0)
    const container = textRef.current
    if (!container || !container.contains(range.commonAncestorContainer)) {
      return
    }

    // Compute absolute character offset in rawText
    const preSelectionRange = range.cloneRange()
    preSelectionRange.selectNodeContents(container)
    preSelectionRange.setEnd(range.startContainer, range.startOffset)
    const start = preSelectionRange.toString().length
    const end = start + range.toString().length
    const text = rawText.slice(start, end)

    if (start < end && text.trim().length > 0) {
      setSelection({ start, end, text })
      // Default to first active participant if available
      const firstActive = participants.find((p) => p.consentStatus === 'ACTIVE')
      if (firstActive && !selectedSubjectId) {
        setSelectedSubjectId(firstActive.subjectId)
      }
    }
  }

  // Add or update a span based on the active selection
  const handleApplySpan = () => {
    if (!selection) return

    const { start, end, text } = selection
    const chosenParticipant = participants.find((p) => p.subjectId === selectedSubjectId)

    let action = selectedAction
    let reason = 'UNTAGGED_TEXT'
    let subjectId = null
    let consentId = null

    if (action === 'KEEP_NON_PII' || action === 'REDACT_ALL') {
      if (chosenParticipant) {
        subjectId = chosenParticipant.subjectId
        consentId = chosenParticipant.consentId
        const isConsented = chosenParticipant.consentStatus === 'ACTIVE'
        if (isConsented) {
          action = 'KEEP_NON_PII'
          reason = 'CONSENTED_SUBJECT'
        } else {
          action = 'REDACT_ALL'
          reason = 'UNCONSENTED_SUBJECT'
        }
      } else {
        action = 'REDACT_ALL'
        reason = 'UNTAGGED_TEXT'
      }
    } else if (action === 'MANUAL_REDACT') {
      reason = manualReason
    } else if (action === 'MANUAL_UNREDACT') {
      reason = 'AGENT_MANUAL_UNREDACT'
    }

    const newSpan = {
      startChar: start,
      endChar: end,
      action,
      reason,
      subjectId,
      consentId,
      textSnippet: text.slice(0, 120),
    }

    // Filter out spans that are completely subsumed or overlapping
    const updatedSpans = spans
      .filter((s) => s.endChar <= start || s.startChar >= end)
      .concat(newSpan)
      .sort((a, b) => a.startChar - b.startChar)

    setSpans(updatedSpans)
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  // Remove a specific span
  const handleRemoveSpan = (index) => {
    const updated = spans.filter((_, i) => i !== index)
    setSpans(updated)
  }

  // Save spans to backend
  const handleSaveSpans = async () => {
    setSaving(true)
    setError(null)
    setSuccessMsg(null)
    try {
      const res = await updateDocumentSpans(sessionId, doc.id, spans)
      setSpans(res.spans)
      setSuccessMsg('Spans saved successfully')
      setTimeout(() => setSuccessMsg(null), 3000)
    } catch (err) {
      setError(err.message || 'Failed to save spans')
    } finally {
      setSaving(false)
    }
  }

  // Run Presidio PII analysis
  const handleAnalyze = async () => {
    setAnalyzing(true)
    setError(null)
    setSuccessMsg(null)
    try {
      const result = await analyzeDocument(sessionId, doc.id)
      setPiiEntities(result.entities || [])
      setSuccessMsg(`Detected ${result.entities?.length || 0} PII entities`)
      setTimeout(() => setSuccessMsg(null), 4000)
    } catch (err) {
      setError(err.message || 'Failed to analyze text')
    } finally {
      setAnalyzing(false)
    }
  }

  // Execute consent-driven redaction
  const handleRedact = async () => {
    setRedacting(true)
    setError(null)
    setSuccessMsg(null)
    try {
      // 1. Save spans first to ensure sync
      await updateDocumentSpans(sessionId, doc.id, spans)
      // 2. Trigger redact endpoint
      const result = await redactDocument(sessionId, doc.id)
      setRedactedText(result.redactedText)
      setDoc(result.document)
      setSuccessMsg(`Redaction completed! ${result.redactedIntervals?.length || 0} segments masked.`)
      setViewMode('redacted')
      if (onDocumentUpdated) onDocumentUpdated(result.document)
    } catch (err) {
      setError(err.message || 'Failed to execute redaction')
    } finally {
      setRedacting(false)
    }
  }

  // Segment the raw text with spans and PII markers for highlighted display
  const renderedTokens = useMemo(() => {
    if (!rawText) return []

    // Build cut points from spans and PII matches
    const cuts = new Set([0, rawText.length])
    spans.forEach((s) => {
      cuts.add(s.startChar)
      cuts.add(s.endChar)
    })
    piiEntities.forEach((p) => {
      cuts.add(p.start)
      cuts.add(p.end)
    })

    const sortedCuts = Array.from(cuts).sort((a, b) => a - b)
    const tokens = []

    for (let i = 0; i < sortedCuts.length - 1; i++) {
      const start = sortedCuts[i]
      const end = sortedCuts[i + 1]
      const chunk = rawText.slice(start, end)
      if (!chunk) continue

      // Find matching span
      const span = spans.find((s) => s.startChar <= start && s.endChar >= end)
      // Find matching PII
      const pii = piiEntities.find((p) => p.start <= start && p.end >= end)

      tokens.push({
        start,
        end,
        text: chunk,
        span,
        pii,
      })
    }

    return tokens
  }, [rawText, spans, piiEntities])

  return (
    <div className="rounded-xl border border-border bg-surface shadow-card overflow-hidden">
      {/* Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-canvas/40 px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-purple-500/10 text-purple-600 border border-purple-500/20">
            <FileText size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-ink">{doc.name}</h3>
              <span
                className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                  doc.status === 'REDACTED'
                    ? 'bg-emerald-100 text-emerald-800'
                    : doc.status === 'TAGGED'
                    ? 'bg-blue-100 text-blue-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {doc.status}
              </span>
            </div>
            <p className="text-xs text-ink-faint">
              {rawText.length.toLocaleString()} characters · {spans.length} tagged spans ·{' '}
              {piiEntities.length} PII entities found
            </p>
          </div>
        </div>

        {/* View Mode Switcher */}
        <div className="flex items-center gap-2 bg-canvas p-1 rounded-lg border border-border">
          <button
            type="button"
            onClick={() => setViewMode('editor')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition ${
              viewMode === 'editor'
                ? 'bg-surface text-ink shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Tag size={14} />
            <span>Annotate & Tag</span>
          </button>

          <button
            type="button"
            onClick={() => setViewMode('redacted')}
            disabled={!redactedText}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition disabled:opacity-40 ${
              viewMode === 'redacted'
                ? 'bg-surface text-ink shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Eye size={14} />
            <span>Redacted Output</span>
          </button>

          <button
            type="button"
            onClick={() => setViewMode('diff')}
            disabled={!redactedText}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition disabled:opacity-40 ${
              viewMode === 'diff'
                ? 'bg-surface text-ink shadow-sm'
                : 'text-ink-muted hover:text-ink'
            }`}
          >
            <Columns size={14} />
            <span>Side-by-Side</span>
          </button>
        </div>
      </div>

      {/* Alerts */}
      {error && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg bg-danger-soft px-3.5 py-2.5 text-xs font-semibold text-danger">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}
      {successMsg && (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3.5 py-2.5 text-xs font-semibold text-emerald-800">
          <CheckCircle size={16} />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Main Content Area */}
      <div className="p-6">
        {viewMode === 'editor' && (
          <div className="space-y-6">
            {/* Action Bar / Tool Palette */}
            <div className="flex flex-wrap items-center justify-between gap-3 bg-canvas p-4 rounded-xl border border-border">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleAnalyze}
                  disabled={analyzing}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-purple-600 text-white text-xs font-semibold hover:bg-purple-700 disabled:opacity-60 transition shadow-sm"
                >
                  <Sparkles size={14} className={analyzing ? 'animate-spin' : ''} />
                  <span>{analyzing ? 'Scanning PII…' : 'Auto-Detect PII'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleSaveSpans}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-surface border border-border text-ink text-xs font-semibold hover:bg-canvas disabled:opacity-60 transition"
                >
                  <RefreshCw size={14} className={saving ? 'animate-spin' : ''} />
                  <span>{saving ? 'Saving…' : 'Save Tags'}</span>
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleRedact}
                  disabled={redacting || spans.length === 0}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-brand text-white text-xs font-bold hover:bg-brand-dark disabled:opacity-60 transition shadow-sm"
                >
                  <Shield size={14} className={redacting ? 'animate-pulse' : ''} />
                  <span>{redacting ? 'Redacting Document…' : 'Apply Redaction'}</span>
                </button>
              </div>
            </div>

            {/* Selection Tagging Drawer / Box */}
            {selection && (
              <div className="rounded-xl border border-brand bg-brand-soft/30 p-4 animate-in fade-in slide-in-from-top-2">
                <div className="flex items-center justify-between gap-4 border-b border-brand/20 pb-3">
                  <div className="flex items-center gap-2 text-brand font-bold text-xs">
                    <Tag size={15} />
                    <span>Tag Selected Text Range [{selection.start} - {selection.end}]</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelection(null)}
                    className="text-xs text-ink-faint hover:text-ink font-semibold"
                  >
                    Cancel
                  </button>
                </div>

                <div className="mt-3 p-2.5 rounded bg-surface border border-border text-xs text-ink-muted italic max-h-20 overflow-y-auto">
                  "{selection.text}"
                </div>

                <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                  {/* Tag Type */}
                  <div>
                    <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-faint mb-1">
                      Action / Category
                    </label>
                    <select
                      value={selectedAction}
                      onChange={(e) => setSelectedAction(e.target.value)}
                      className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-brand"
                    >
                      <option value="KEEP_NON_PII">Assign to Roster Subject</option>
                      <option value="MANUAL_REDACT">Manual Redact (Override)</option>
                      <option value="MANUAL_UNREDACT">Manual Keep (Do Not Redact)</option>
                    </select>
                  </div>

                  {/* Assign to Subject if KEEP_NON_PII */}
                  {selectedAction === 'KEEP_NON_PII' && (
                    <div>
                      <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-faint mb-1">
                        Select Participant
                      </label>
                      <select
                        value={selectedSubjectId}
                        onChange={(e) => setSelectedSubjectId(e.target.value)}
                        className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-brand"
                      >
                        <option value="">-- No Subject (Untagged) --</option>
                        {participants.map((p) => (
                          <option key={p.subjectId} value={p.subjectId}>
                            {p.fullName} ({p.consentStatus})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Reason Picker if MANUAL_REDACT */}
                  {selectedAction === 'MANUAL_REDACT' && (
                    <div>
                      <label className="block text-[11px] font-bold uppercase tracking-wider text-ink-faint mb-1">
                        Redaction Reason
                      </label>
                      <select
                        value={manualReason}
                        onChange={(e) => setManualReason(e.target.value)}
                        className="w-full rounded-lg border border-border bg-surface px-3 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-brand"
                      >
                        {REDACTION_REASONS.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Submit Button */}
                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={handleApplySpan}
                      className="w-full flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-brand text-white text-xs font-bold hover:bg-brand-dark transition shadow-sm"
                    >
                      <Plus size={14} />
                      <span>Apply Tag to Selection</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Instruction Tip */}
            <div className="flex items-center gap-2 text-xs text-ink-faint bg-canvas px-3.5 py-2 rounded-lg border border-border">
              <Info size={14} className="text-brand shrink-0" />
              <span>
                <strong>Highlight text with your cursor</strong> to assign a quote to a participant or manually redact/unredact. Untagged text and unconsented subjects are automatically 100% redacted.
              </span>
            </div>

            {/* Interactive Document Reader */}
            <div className="rounded-xl border border-border bg-canvas p-6 font-mono text-sm leading-relaxed text-ink select-text min-h-[300px] max-h-[500px] overflow-y-auto">
              <div ref={textRef} onMouseUp={handleMouseUp} className="whitespace-pre-wrap select-text">
                {renderedTokens.map((tok, idx) => {
                  const span = tok.span
                  const pii = tok.pii

                  // Base style logic
                  let bgClass = ''
                  let titleTip = `Offset: [${tok.start} - ${tok.end}]`

                  if (span) {
                    const participant = participants.find((p) => p.subjectId === span.subjectId)
                    if (span.action === 'KEEP_NON_PII') {
                      bgClass = 'bg-emerald-100/70 text-emerald-950 border-b-2 border-emerald-500'
                      titleTip += ` | Tagged: ${participant?.fullName || 'Consented'} (KEEP NON-PII)`
                    } else if (span.action === 'REDACT_ALL') {
                      bgClass = 'bg-rose-100/80 text-rose-950 border-b-2 border-rose-500'
                      titleTip += ` | Tagged: ${participant?.fullName || 'Unconsented'} (REDACT ALL)`
                    } else if (span.action === 'MANUAL_REDACT') {
                      bgClass = 'bg-purple-100/80 text-purple-950 border-b-2 border-purple-500'
                      titleTip += ` | Manual Redaction: ${span.reason}`
                    } else if (span.action === 'MANUAL_UNREDACT') {
                      bgClass = 'bg-blue-100/70 text-blue-950 border-b-2 border-blue-500'
                      titleTip += ` | Manual Keep`
                    }
                  } else {
                    bgClass = 'bg-stone-200/40 text-stone-700 border-b border-dashed border-stone-400'
                    titleTip += ' | Untagged (Will be redacted)'
                  }

                  if (pii) {
                    const piiStyle = PII_COLORS[pii.entity_type] || 'bg-amber-100 text-amber-900 border-amber-300'
                    return (
                      <mark
                        key={idx}
                        title={`${titleTip} | PII: ${pii.entity_type} (${Math.round(pii.score * 100)}% conf)`}
                        className={`px-1 py-0.5 rounded border ${piiStyle} font-semibold`}
                      >
                        {tok.text}
                      </mark>
                    )
                  }

                  return (
                    <span key={idx} title={titleTip} className={`${bgClass} px-0.5 transition hover:opacity-80`}>
                      {tok.text}
                    </span>
                  )
                })}
              </div>
            </div>

            {/* Tagged Spans Table / List */}
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-faint mb-3">
                Tagged Spans ({spans.length})
              </h4>

              {spans.length === 0 ? (
                <div className="p-6 text-center rounded-xl border border-dashed border-border bg-canvas text-xs text-ink-faint">
                  No spans tagged yet. Highlight text in the document above to create tags.
                </div>
              ) : (
                <div className="rounded-xl border border-border overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-canvas border-b border-border text-ink-faint uppercase tracking-wider">
                      <tr>
                        <th className="py-2.5 px-4 font-semibold">Range</th>
                        <th className="py-2.5 px-4 font-semibold">Assigned Subject / Reason</th>
                        <th className="py-2.5 px-4 font-semibold">Action</th>
                        <th className="py-2.5 px-4 font-semibold">Snippet</th>
                        <th className="py-2.5 px-4 font-semibold text-right">Delete</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {spans.map((s, idx) => {
                        const participant = participants.find((p) => p.subjectId === s.subjectId)
                        const isConsented = participant?.consentStatus === 'ACTIVE'
                        return (
                          <tr key={idx} className="hover:bg-canvas/50 transition">
                            <td className="py-2.5 px-4 font-mono font-medium text-ink-muted">
                              [{s.startChar} - {s.endChar}]
                            </td>
                            <td className="py-2.5 px-4">
                              {participant ? (
                                <div className="flex items-center gap-1.5">
                                  {isConsented ? (
                                    <UserCheck size={14} className="text-emerald-600" />
                                  ) : (
                                    <UserX size={14} className="text-rose-600" />
                                  )}
                                  <span className="font-semibold text-ink">{participant.fullName}</span>
                                </div>
                              ) : (
                                <span className="font-semibold text-ink-muted">{s.reason}</span>
                              )}
                            </td>
                            <td className="py-2.5 px-4">
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold text-[10px] ${
                                  s.action === 'KEEP_NON_PII'
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : s.action === 'REDACT_ALL'
                                    ? 'bg-rose-100 text-rose-800'
                                    : 'bg-purple-100 text-purple-800'
                                }`}
                              >
                                {s.action}
                              </span>
                            </td>
                            <td className="py-2.5 px-4 max-w-xs truncate text-ink-muted italic">
                              "{s.textSnippet || rawText.slice(s.startChar, s.endChar)}"
                            </td>
                            <td className="py-2.5 px-4 text-right">
                              <button
                                type="button"
                                onClick={() => handleRemoveSpan(idx)}
                                className="p-1 rounded text-ink-faint hover:text-danger hover:bg-danger-soft transition"
                                title="Remove tag"
                              >
                                <Trash2 size={14} />
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {viewMode === 'redacted' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between bg-canvas p-3 rounded-lg border border-border">
              <div className="flex items-center gap-2 text-xs font-semibold text-ink">
                <Shield size={16} className="text-emerald-600" />
                <span>Privacy-Redacted Output (Ready for Storage & DSAR)</span>
              </div>
              <button
                type="button"
                onClick={handleRedact}
                disabled={redacting}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface border border-border text-xs font-semibold text-ink hover:bg-canvas transition"
              >
                <RefreshCw size={13} className={redacting ? 'animate-spin' : ''} />
                <span>Re-apply Redaction</span>
              </button>
            </div>

            <div className="rounded-xl border border-border bg-surface p-6 font-mono text-sm leading-relaxed text-ink whitespace-pre-wrap min-h-[350px] max-h-[600px] overflow-y-auto">
              {redactedText || 'No redacted text generated yet. Click "Apply Redaction" in the editor.'}
            </div>
          </div>
        )}

        {viewMode === 'diff' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-faint mb-2">
                Original Text (Protected Source)
              </h4>
              <div className="rounded-xl border border-border bg-canvas p-4 font-mono text-xs leading-relaxed text-ink whitespace-pre-wrap min-h-[350px] max-h-[500px] overflow-y-auto">
                {rawText}
              </div>
            </div>

            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-faint mb-2">
                Redacted Derivative (Lawful Package)
              </h4>
              <div className="rounded-xl border border-border bg-canvas p-4 font-mono text-xs leading-relaxed text-ink whitespace-pre-wrap min-h-[350px] max-h-[500px] overflow-y-auto">
                {redactedText}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
