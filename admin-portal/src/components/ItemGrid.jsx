import { Users, Trash2, FileWarning, Image, AudioLines } from 'lucide-react'
import StatusPill from './StatusPill'

// The Data tab's grid.
//
// Everything it renders comes from the item index and is pseudonymous by
// construction — the endpoint returns no name, no email and no `storagePath`
// (matrix §D). There is nothing here to hide client-side, which is the point:
// a screen that has to remember to omit a field is a screen that will one day
// forget.
//
// `shared` is precomputed server-side from `shared_subject_count`. It is shown
// on the row BEFORE the operator ticks anything, because a delete on a shared
// frame will come back as a redaction and finding that out afterwards is how an
// operator loses trust in the tool.
//
// A PHOTO row and an AUDIO row used to be indistinguishable here, which made the
// shared-count warning unreadable: "Shared ×3" means three faces on one frame in
// one case and three voices in one recording in the other, and the erasure that
// comes back is a blur in the first and a mute in the second. Every audio-aware
// string below exists for that reason.

const ORIGIN_LABELS = {
  COLLECTION_SESSION: 'Collected',
  IMPORT: 'Imported',
  ENROLLMENT: 'Enrollment selfie',
}

// ENROLLMENT is the one origin that means two different objects: a selfie on a
// PHOTO row, a voice print on an AUDIO row. Left as one label it would tell an
// operator reviewing an erasure that the thing they are about to destroy is a
// photo when it is the subject's recorded voice.
function originLabel(item) {
  if (item.origin === 'ENROLLMENT' && item.type === 'AUDIO') return 'Enrollment voice clip'
  return ORIGIN_LABELS[item.origin] ?? item.origin
}

const TYPE_META = {
  PHOTO: { label: 'Photo', Icon: Image },
  AUDIO: { label: 'Audio', Icon: AudioLines },
}

// A recording that never completed analysis has no trustworthy muted copy —
// `redactedAvailable` is already false for it server-side
// (isRecordingRedactedAvailable). Naming the status as well tells the operator
// whether they are waiting on a queue or looking at a failure.
const RECORDING_STATUS_LABELS = {
  PENDING_ANALYSIS: 'Awaiting analysis',
  ANALYZED: 'Analysed, not muted',
  REDACTED: 'Muted',
  DEFERRED: 'Deferred — worker unavailable',
}

function shortId(id) {
  return id ? `${id.slice(0, 8)}…` : '—'
}

function formatDuration(seconds) {
  if (seconds == null) return null
  const total = Math.round(seconds)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  return `${mins}:${String(secs).padStart(2, '0')}`
}

export default function ItemGrid({ items, selected, onToggle, onToggleAll, allOnPageSelected }) {
  return (
    <div className="overflow-x-auto rounded-card bg-surface shadow-card">
      <table className="w-full min-w-[980px] text-left">
        <thead>
          <tr className="border-b border-border text-xs font-semibold text-ink-muted">
            <th className="w-10 px-4 py-3">
              <input
                type="checkbox"
                aria-label="Select every item on this page"
                checked={allOnPageSelected}
                onChange={onToggleAll}
                className="size-4 accent-brand"
              />
            </th>
            <th className="px-3 py-3">Type</th>
            <th className="px-3 py-3">Item</th>
            <th className="px-3 py-3">Origin</th>
            <th className="px-3 py-3">Captured</th>
            <th className="px-3 py-3">Project / session</th>
            <th className="px-3 py-3">Lawful basis</th>
            <th className="px-3 py-3">Flags</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((item) => {
            const isSelected = selected.has(item.itemId)
            const isAudio = item.type === 'AUDIO'
            const { label: typeLabel, Icon: TypeIcon } = TYPE_META[item.type] ?? {
              label: item.type ?? '—',
              Icon: null,
            }
            const duration = formatDuration(item.durationSec)
            const audible = formatDuration(item.audibleSeconds)

            return (
              <tr
                key={item.itemId}
                className={`text-sm font-medium ${
                  item.deletedAt ? 'text-ink-faint' : 'text-ink'
                } ${isSelected ? 'bg-brand-soft/40' : ''}`}
              >
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label={`Select item ${item.itemId}`}
                    checked={isSelected}
                    // A tombstoned item has nothing left to act on. Leaving it
                    // selectable would let an operator submit a batch that comes
                    // back entirely SKIPPED and read as a failure.
                    disabled={Boolean(item.deletedAt)}
                    onChange={() => onToggle(item.itemId)}
                    className="size-4 accent-brand disabled:opacity-30"
                  />
                </td>
                <td className="px-3 py-3">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    {TypeIcon && <TypeIcon size={14} className="shrink-0 text-ink-muted" />}
                    {typeLabel}
                  </span>
                  {isAudio && duration && (
                    <div
                      className="mt-0.5 text-xs font-normal text-ink-faint"
                      title={
                        audible
                          ? `${audible} of this recording is this person speaking, across ${item.segmentCount ?? 0} utterance(s)`
                          : undefined
                      }
                    >
                      {duration}
                      {audible ? ` · ${audible} audible` : ''}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3 font-mono text-xs">{shortId(item.itemId)}</td>
                <td className="px-3 py-3">{originLabel(item)}</td>
                <td className="px-3 py-3">
                  {item.capturedAt ? new Date(item.capturedAt).toLocaleDateString() : 'Unknown'}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-ink-faint">
                  {shortId(item.projectId)} / {shortId(item.sessionId)}
                </td>
                <td className="px-3 py-3">
                  {item.lawfulBasis === 'IMPORT_UNVERIFIED' || item.lawfulBasis === 'UNVERIFIED' ? (
                    <StatusPill tone="warning">Unverified</StatusPill>
                  ) : item.lawfulBasis ? (
                    <StatusPill tone="success">Consent</StatusPill>
                  ) : (
                    <span className="text-xs text-ink-faint">—</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.shared && (
                      <span
                        title={
                          isAudio
                            ? `${item.sharedSubjectCount} identified speakers are on this recording — a delete becomes a mute of this speaker only`
                            : `${item.sharedSubjectCount} people appear on this frame — a delete becomes a redaction`
                        }
                        className="inline-flex items-center gap-1 rounded-pill bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning"
                      >
                        <Users size={12} />{' '}
                        {isAudio ? `Speakers ×${item.sharedSubjectCount}` : `Shared ×${item.sharedSubjectCount}`}
                      </span>
                    )}
                    {item.deletedAt && (
                      <span className="inline-flex items-center gap-1 rounded-pill bg-canvas px-2 py-0.5 text-xs font-semibold text-ink-faint">
                        <Trash2 size={12} /> Deleted
                      </span>
                    )}
                    {/*
                      Enrollment rows are excluded, not forgotten. A selfie and a
                      voice clip have `redactedAvailable: false` permanently and
                      correctly — the whole object IS the biometric, so there is
                      nothing left to keep once it is removed and no derivative
                      was ever going to exist. Flagging them here put a
                      "something is missing" badge on the one kind of row where
                      nothing is, next to recordings where the same badge means a
                      real gap.
                    */}
                    {!item.redactedAvailable && !item.deletedAt && item.origin !== 'ENROLLMENT' && (
                      <span
                        title={
                          isAudio
                            ? `${RECORDING_STATUS_LABELS[item.recordingStatus] ?? item.recordingStatus ?? 'Unknown status'} — no confirmed muted derivative, so it cannot be served or packaged`
                            : 'No confirmed redacted derivative — it cannot be served or packaged'
                        }
                        className="inline-flex items-center gap-1 rounded-pill bg-canvas px-2 py-0.5 text-xs font-semibold text-ink-faint"
                      >
                        <FileWarning size={12} /> {isAudio ? 'No muted copy' : 'No redacted copy'}
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
