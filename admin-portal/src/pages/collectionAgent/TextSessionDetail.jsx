import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import {
  ArrowLeft,
  FileText,
  Plus,
  QrCode,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserCheck,
  UserPlus,
  Users,
  X,
  Copy,
  Info,
  CheckCircle2,
} from 'lucide-react'
import Sidebar from '../../components/Sidebar'
import PageHeader from '../../components/PageHeader'
import StatusPill from '../../components/StatusPill'
import TextDocumentEditor from '../../components/TextDocumentEditor'
import {
  addParticipant,
  createInvite,
  finalizeSession,
  getInvite,
  getSessionFresh,
  listDocuments,
  getDocument,
  mediaUrl,
  removeParticipant,
  revokeInvite,
  searchProjectSubjects,
  uploadDocument,
  uploadDocumentFile,
} from '../../lib/api'

const VERDICT_LABEL = {
  ELIGIBLE: 'Consent active',
  NO_CONSENT: 'No consent',
  REVOKED: 'Consent revoked',
  SUBJECT_INACTIVE: 'Inactive subject',
}

const FIELD_CLASS =
  'w-full rounded-lg border border-border bg-canvas py-2 pl-9 pr-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand'

function useCountdown(expiresAt) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!expiresAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  if (!expiresAt) return null
  const diff = new Date(expiresAt).getTime() - now
  if (diff <= 0) return 'Expired'
  const mins = Math.floor(diff / 60000)
  const secs = Math.floor((diff % 60000) / 1000)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function TextSessionDetail() {
  const { sessionId } = useParams()
  const navigate = useNavigate()

  const [session, setSession] = useState(null)
  const [documents, setDocuments] = useState([])
  const [selectedDocId, setSelectedDocId] = useState(null)
  const [activeDocDetail, setActiveDocDetail] = useState(null)
  const [rawText, setRawText] = useState('')
  const [redactedText, setRedactedText] = useState('')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Ingest form state
  const [ingestMode, setIngestMode] = useState('paste') // 'paste' | 'file'
  const [pasteTitle, setPasteTitle] = useState('')
  const [pasteContent, setPasteContent] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)

  // Roster & Invites
  const [invite, setInvite] = useState(null)
  const [copied, setCopied] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)

  // Finalize modal state
  const [showFinalizeModal, setShowFinalizeModal] = useState(false)
  const [finalizing, setFinalizing] = useState(false)

  const countdown = useCountdown(invite?.expiresAt)

  // Load session and documents
  const loadData = useCallback(async () => {
    try {
      const [sessRes, docRes] = await Promise.all([
        getSessionFresh(sessionId),
        listDocuments(sessionId),
      ])
      setSession(sessRes)
      setDocuments(docRes.documents || [])
      if (!selectedDocId && docRes.documents?.length > 0) {
        setSelectedDocId(docRes.documents[0].id)
      }
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [sessionId, selectedDocId])

  useEffect(() => {
    loadData()
  }, [loadData])

  // Load active document details and text content
  useEffect(() => {
    if (!selectedDocId) {
      setActiveDocDetail(null)
      setRawText('')
      setRedactedText('')
      return
    }

    let isMounted = true
    getDocument(sessionId, selectedDocId)
      .then(async (doc) => {
        if (!isMounted) return
        setActiveDocDetail(doc)

        // Fetch raw text
        try {
          const res = await fetch(mediaUrl.rawDocument(sessionId, selectedDocId), {
            credentials: 'include',
          })
          if (res.ok && isMounted) {
            setRawText(await res.text())
          }
        } catch {
          // ignore
        }

        // Fetch redacted text if available
        if (doc.status === 'REDACTED') {
          try {
            const res = await fetch(mediaUrl.redactedDocument(sessionId, selectedDocId), {
              credentials: 'include',
            })
            if (res.ok && isMounted) {
              setRedactedText(await res.text())
            }
          } catch {
            // ignore
          }
        } else {
          setRedactedText('')
        }
      })
      .catch((err) => {
        if (isMounted) setError(err)
      })

    return () => {
      isMounted = false
    }
  }, [sessionId, selectedDocId])

  // Handle paste submission
  const handlePasteSubmit = async (e) => {
    e.preventDefault()
    if (!pasteContent.trim()) return

    setUploading(true)
    setError(null)
    try {
      const newDoc = await uploadDocument(sessionId, {
        name: pasteTitle.trim() || 'Untitled Transcript',
        textContent: pasteContent,
      })
      setPasteTitle('')
      setPasteContent('')
      await loadData()
      setSelectedDocId(newDoc.id)
    } catch (err) {
      setError(err)
    } finally {
      setUploading(false)
    }
  }

  // Handle file upload
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    setError(null)
    try {
      const newDoc = await uploadDocumentFile(sessionId, file, file.name)
      if (fileInputRef.current) fileInputRef.current.value = ''
      await loadData()
      setSelectedDocId(newDoc.id)
    } catch (err) {
      setError(err)
    } finally {
      setUploading(false)
    }
  }

  // Invite handlers
  const handleCreateInvite = async () => {
    try {
      const res = await createInvite(sessionId)
      setInvite(res)
    } catch (err) {
      setError(err)
    }
  }

  const handleRevokeInvite = async () => {
    try {
      await revokeInvite(sessionId)
      setInvite(null)
    } catch (err) {
      setError(err)
    }
  }

  // Subject search
  const handleSearch = async (query) => {
    setSearchQuery(query)
    if (!query.trim() || !session?.projectId) {
      setSearchResults([])
      return
    }
    setSearching(true)
    try {
      const res = await searchProjectSubjects(session.projectId, query)
      setSearchResults(res.items || [])
    } catch (err) {
      setError(err)
    } finally {
      setSearching(false)
    }
  }

  const handleAddParticipant = async (subjectId) => {
    try {
      await addParticipant(sessionId, subjectId)
      setSearchQuery('')
      setSearchResults([])
      await loadData()
    } catch (err) {
      setError(err)
    }
  }

  const handleRemoveParticipant = async (subjectId) => {
    try {
      await removeParticipant(sessionId, subjectId)
      await loadData()
    } catch (err) {
      setError(err)
    }
  }

  // Finalize session
  const handleFinalize = async () => {
    setFinalizing(true)
    setError(null)
    try {
      await finalizeSession(sessionId)
      setShowFinalizeModal(false)
      navigate('/sessions')
    } catch (err) {
      setError(err)
    } finally {
      setFinalizing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-svh bg-canvas">
        <Sidebar />
        <main className="flex-1 flex items-center justify-center p-10">
          <RefreshCw className="animate-spin text-ink-muted" size={24} />
        </main>
      </div>
    )
  }

  const isArchived = session?.status === 'ARCHIVED'

  // The subject search is project-wide, so it returns people who are already
  // on this roster; they are filtered out of the add list rather than offered
  // a second Add that would only collide on the participant row.
  const rosterIds = new Set(session?.participants?.map((p) => p.subjectId) ?? [])
  const unredactedDocs = documents.filter((d) => d.status !== 'REDACTED')

  return (
    <div className="flex min-h-svh bg-canvas">
      <Sidebar />

      <main className="flex-1 px-10 py-8 max-w-7xl">
        {/* Navigation Breadcrumb & Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <Link
              to="/sessions"
              className="flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink transition"
            >
              <ArrowLeft size={16} />
              <span>Back to sessions</span>
            </Link>
            <span className="text-ink-faint">/</span>
            <span className="text-xs font-bold text-ink">{session?.code}</span>
          </div>

          <div className="flex items-center gap-3">
            <StatusPill tone={session?.status === 'ARCHIVED' ? 'success' : 'brand'}>
              {session?.status}
            </StatusPill>

            {!isArchived && (
              <button
                type="button"
                onClick={() => setShowFinalizeModal(true)}
                disabled={documents.length === 0}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-700 transition disabled:opacity-50 shadow-sm"
              >
                <ShieldCheck size={16} />
                <span>End & Finalize Session</span>
              </button>
            )}
          </div>
        </div>

        <PageHeader
          title={`${session?.code} — ${session?.project?.name}`}
          subtitle="Collect and annotate text transcripts, tag speaker quotes, and redact unconsented prose & PII."
        />

        {error && (
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-danger-soft px-4 py-3 text-xs font-semibold text-danger">
            <ShieldAlert size={16} />
            <span>{error.message || String(error)}</span>
          </div>
        )}

        <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column: Roster & Invites + Ingest Form */}
          <div className="space-y-6">
            {/* Roster Card */}
            <div className="rounded-xl border border-border bg-surface p-5 shadow-card">
              <div className="flex items-center justify-between border-b border-border pb-3">
                <div className="flex items-center gap-2 font-bold text-xs text-ink uppercase tracking-wider">
                  <Users size={16} className="text-purple-600" />
                  <span>Session Roster ({session?.participants?.length || 0})</span>
                </div>

                {!isArchived && (
                  <button
                    type="button"
                    onClick={invite ? handleRevokeInvite : handleCreateInvite}
                    className="flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline"
                  >
                    <QrCode size={13} />
                    <span>{invite ? 'Close QR' : 'Join QR'}</span>
                  </button>
                )}
              </div>

              {/* QR Invite Display */}
              {invite && !isArchived && (
                <div className="my-4 rounded-xl border border-brand/20 bg-brand-soft/30 p-4 text-center animate-in fade-in">
                  <div className="inline-block rounded-lg bg-white p-2.5 shadow-sm">
                    <QRCodeSVG value={invite.url} size={130} />
                  </div>
                  <p className="mt-2 text-xs font-bold text-ink">Scan to Join Session</p>
                  <p className="text-[11px] text-ink-faint">
                    Expires in <span className="font-mono font-bold text-brand">{countdown}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(invite.url)
                      setCopied(true)
                      setTimeout(() => setCopied(false), 2000)
                    }}
                    className="mt-2.5 inline-flex items-center gap-1 rounded bg-surface border border-border px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-canvas"
                  >
                    <Copy size={12} />
                    <span>{copied ? 'Copied Link!' : 'Copy Join Link'}</span>
                  </button>
                </div>
              )}

              {/* Search / Add Subject */}
              {!isArchived && (
                <div className="mt-3 relative">
                  <Search size={14} className="absolute left-3 top-2.5 text-ink-faint" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => handleSearch(e.target.value)}
                    placeholder="Search subject to add…"
                    className={FIELD_CLASS}
                  />

                  {searchResults.length > 0 && (
                    <div className="absolute left-0 right-0 top-10 z-20 rounded-lg border border-border bg-surface shadow-lg max-h-48 overflow-y-auto divide-y divide-border">
                      {searchResults
                        .filter((sub) => !rosterIds.has(sub.masterUserId))
                        .map((sub) => {
                          // See the photo session's add list: addToRoster re-reads
                          // consent and answers 409, so an ineligible subject gets
                          // the reason instead of a button that only fails.
                          const eligible = sub.verdict === 'ELIGIBLE'
                          return (
                            <div
                              key={sub.masterUserId}
                              className={`flex items-center justify-between p-2.5 text-xs hover:bg-canvas transition ${
                                eligible ? '' : 'opacity-60'
                              }`}
                            >
                              <div>
                                <p className="font-bold text-ink">{sub.fullName}</p>
                                <p className="text-[11px] text-ink-faint">{sub.email}</p>
                              </div>
                              {eligible ? (
                                <button
                                  type="button"
                                  onClick={() => handleAddParticipant(sub.masterUserId)}
                                  className="p-1 rounded bg-brand text-white hover:bg-brand-dark transition"
                                  title="Add to roster"
                                >
                                  <UserPlus size={14} />
                                </button>
                              ) : (
                                <span className="rounded-pill bg-danger-soft px-2 py-1 text-[10px] font-semibold text-danger">
                                  {VERDICT_LABEL[sub.verdict] ?? 'Not eligible'}
                                </span>
                              )}
                            </div>
                          )
                        })}
                    </div>
                  )}
                </div>
              )}

              {/* Participants List */}
              <div className="mt-4 space-y-2 max-h-60 overflow-y-auto">
                {session?.participants?.length === 0 ? (
                  <p className="text-xs text-ink-faint italic text-center py-3">
                    No participants on roster yet.
                  </p>
                ) : (
                  session.participants.map((p) => {
                    const isConsented = p.consentStatus === 'ACTIVE'
                    return (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-2 p-2 rounded-lg bg-canvas border border-border/70 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            {isConsented ? (
                              <UserCheck size={14} className="text-emerald-600 shrink-0" />
                            ) : (
                              <ShieldAlert size={14} className="text-rose-600 shrink-0" />
                            )}
                            <p className="font-semibold text-ink truncate">{p.fullName}</p>
                          </div>
                          <p className="text-[10px] text-ink-faint truncate">{p.email}</p>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <span
                            className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${
                              isConsented
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {isConsented ? 'Consented' : 'Unconsented'}
                          </span>

                          {!isArchived && (
                            <button
                              type="button"
                              onClick={() => handleRemoveParticipant(p.subjectId)}
                              className="p-1 text-ink-faint hover:text-danger rounded"
                              title="Remove from roster"
                            >
                              <X size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>

            {/* Ingest Documents Card */}
            {!isArchived && (
              <div className="rounded-xl border border-border bg-surface p-5 shadow-card">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-2 font-bold text-xs text-ink uppercase tracking-wider">
                    <FileText size={16} className="text-purple-600" />
                    <span>Ingest Text Document</span>
                  </div>

                  <div className="flex items-center gap-1 bg-canvas p-0.5 rounded-md border border-border">
                    <button
                      type="button"
                      onClick={() => setIngestMode('paste')}
                      className={`px-2 py-0.5 text-[11px] font-semibold rounded ${
                        ingestMode === 'paste' ? 'bg-surface text-ink shadow-sm' : 'text-ink-faint'
                      }`}
                    >
                      Paste
                    </button>
                    <button
                      type="button"
                      onClick={() => setIngestMode('file')}
                      className={`px-2 py-0.5 text-[11px] font-semibold rounded ${
                        ingestMode === 'file' ? 'bg-surface text-ink shadow-sm' : 'text-ink-faint'
                      }`}
                    >
                      Upload
                    </button>
                  </div>
                </div>

                {ingestMode === 'paste' ? (
                  <form onSubmit={handlePasteSubmit} className="mt-4 space-y-3">
                    <div>
                      <label className="block text-[11px] font-bold text-ink-faint uppercase tracking-wider mb-1">
                        Document Title
                      </label>
                      <input
                        type="text"
                        value={pasteTitle}
                        onChange={(e) => setPasteTitle(e.target.value)}
                        placeholder="e.g. User Research Interview #1"
                        className="w-full rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-brand"
                      />
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-ink-faint uppercase tracking-wider mb-1">
                        Transcript / Text Content
                      </label>
                      <textarea
                        rows={6}
                        value={pasteContent}
                        onChange={(e) => setPasteContent(e.target.value)}
                        placeholder="Paste document or transcript text here…"
                        className="w-full rounded-lg border border-border bg-canvas p-3 font-mono text-xs text-ink focus:outline-none focus:ring-1 focus:ring-brand leading-relaxed"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={uploading || !pasteContent.trim()}
                      className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-brand py-2 text-xs font-bold text-white hover:bg-brand-dark disabled:opacity-50 transition shadow-sm"
                    >
                      <Plus size={14} />
                      <span>{uploading ? 'Ingesting…' : 'Add Document to Session'}</span>
                    </button>
                  </form>
                ) : (
                  <div className="mt-4 space-y-3">
                    <div
                      onClick={() => fileInputRef.current?.click()}
                      className="cursor-pointer border-2 border-dashed border-border rounded-xl p-6 text-center hover:border-brand/50 hover:bg-brand-soft/10 transition"
                    >
                      <UploadCloud size={28} className="mx-auto text-purple-600 mb-2" />
                      <p className="text-xs font-bold text-ink">Click to upload document</p>
                      <p className="text-[11px] text-ink-faint mt-0.5">Supports .txt, .md files</p>
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".txt,.md,text/plain"
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right Column: Documents List & Active Text Editor */}
          <div className="lg:col-span-2 space-y-6">
            {/* Document Tabs */}
            {documents.length > 0 && (
              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {documents.map((d) => {
                  const isSelected = d.id === selectedDocId
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setSelectedDocId(d.id)}
                      className={`flex items-center gap-2 px-3.5 py-2 rounded-xl border text-xs font-semibold whitespace-nowrap transition ${
                        isSelected
                          ? 'border-brand bg-brand text-white shadow-sm'
                          : 'border-border bg-surface text-ink-muted hover:text-ink hover:bg-canvas'
                      }`}
                    >
                      <FileText size={14} />
                      <span>{d.name}</span>
                      <span
                        className={`text-[9px] font-bold uppercase px-1.5 py-0.2 rounded-full ${
                          isSelected
                            ? 'bg-white/20 text-white'
                            : d.status === 'REDACTED'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-amber-100 text-amber-800'
                        }`}
                      >
                        {d.status === 'REDACTED' ? 'Redacted' : 'Pending'}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* Document Editor Component */}
            {activeDocDetail ? (
              <TextDocumentEditor
                key={activeDocDetail.id}
                sessionId={sessionId}
                document={activeDocDetail}
                rawText={rawText}
                redactedText={redactedText}
                participants={session?.participants || []}
                onDocumentUpdated={() => loadData()}
              />
            ) : (
              <div className="rounded-xl border border-dashed border-border bg-surface p-12 text-center">
                <FileText size={36} className="mx-auto text-ink-faint mb-3" />
                <h4 className="text-sm font-bold text-ink">No Document Selected</h4>
                <p className="text-xs text-ink-faint mt-1 max-w-sm mx-auto">
                  Paste or upload a text transcript on the left panel to begin annotating and redacting.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Finalize Session Confirmation Modal */}
        {showFinalizeModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 backdrop-blur-sm p-4">
            <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl border border-border animate-in fade-in zoom-in-95">
              <div className="flex items-center gap-3 text-emerald-600 mb-3">
                <ShieldCheck size={24} />
                <h3 className="text-base font-bold text-ink">Finalize Text Collection Session</h3>
              </div>

              <p className="text-xs text-ink-muted leading-relaxed">
                Finalizing will seal all documents, archive the session, generate downstream handoff
                records, and create an immutable SHA-256 audit manifest.
              </p>

              {unredactedDocs.length > 0 && (
                <div className="my-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 flex items-start gap-2">
                  <Info size={16} className="shrink-0 text-amber-600 mt-0.5" />
                  <div>
                    <strong>Warning:</strong> {unredactedDocs.length} document(s) have not been redacted yet. You must apply redactions before archiving.
                  </div>
                </div>
              )}

              <div className="mt-4 rounded-xl border border-border bg-canvas p-3 text-xs space-y-1.5 font-medium text-ink-muted">
                <div className="flex justify-between">
                  <span>Total Documents:</span>
                  <span className="font-bold text-ink">{documents.length}</span>
                </div>
                <div className="flex justify-between">
                  <span>Fully Redacted:</span>
                  <span className="font-bold text-emerald-600">
                    {documents.length - unredactedDocs.length}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Roster Participants:</span>
                  <span className="font-bold text-ink">{session?.participants?.length || 0}</span>
                </div>
              </div>

              <div className="mt-6 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowFinalizeModal(false)}
                  className="px-4 py-2 rounded-lg border border-border text-xs font-semibold text-ink hover:bg-canvas transition"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={handleFinalize}
                  disabled={finalizing || unredactedDocs.length > 0}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50 transition shadow-sm"
                >
                  {finalizing ? 'Sealing Session…' : 'Confirm & Finalize'}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
