import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Plus, X } from 'lucide-react'

import { listDataTypes } from '../lib/api'

// Picks data categories from the shared vocabulary, with an escape hatch.
//
// This replaced a comma-separated text box. Two things were wrong with that, and
// only one of them was cosmetic:
//
//   - `assertPurposeLimitation` checks that a project's data types are a SUBSET of
//     its consent notice's, by exact string comparison. Two people typing "face"
//     and "Face" produced an undisclosed-data-type refusal naming a category that
//     is, on screen, the same word.
//   - A §5 notice's data categories are what the principal reads before deciding.
//     Free text is how a notice ends up saying "hands, face, misc".
//
// The vocabulary is fetched, not bundled: the DPO's notice and the owner's project
// must offer identical options or a lawful project becomes unapprovable, and the
// only way to guarantee that is one list, served.

const OTHER_PREFIX = 'OTHER:'

export default function DataTypePicker({ value, onChange, disabled, describedBy }) {
  const [catalog, setCatalog] = useState(null)
  const [error, setError] = useState(null)
  const [customDraft, setCustomDraft] = useState('')
  const [showCustom, setShowCustom] = useState(false)

  const selected = useMemo(() => new Set(value ?? []), [value])

  useEffect(() => {
    let live = true
    listDataTypes()
      .then((data) => live && setCatalog(data))
      .catch((err) => live && setError(err.message))
    return () => {
      live = false
    }
  }, [])

  // Custom entries are kept separate because they are not in the catalogue and so
  // cannot be rendered from it — but they must still be visible and removable, or
  // an "Other" value saved yesterday becomes invisible and un-deletable today.
  const customValues = useMemo(
    () => (value ?? []).filter((v) => v.startsWith(OTHER_PREFIX)),
    [value],
  )

  // Anything stored that is neither a catalogue code nor an OTHER: entry. Only
  // reachable for rows written before the vocabulary existed; shown rather than
  // dropped so a DPO can see what a legacy notice actually claims.
  const unknownValues = useMemo(() => {
    if (!catalog) return []
    const codes = new Set(catalog.dataTypes.map((d) => d.code))
    return (value ?? []).filter((v) => !codes.has(v) && !v.startsWith(OTHER_PREFIX))
  }, [value, catalog])

  const toggle = (code) => {
    if (disabled) return
    const next = new Set(selected)
    if (next.has(code)) next.delete(code)
    else next.add(code)
    onChange([...next])
  }

  const addCustom = () => {
    const text = customDraft.trim().replace(/\s+/g, ' ')
    if (!text) return
    const entry = `${OTHER_PREFIX}${text}`
    if (!selected.has(entry)) onChange([...(value ?? []), entry])
    setCustomDraft('')
    setShowCustom(false)
  }

  const removeValue = (entry) => onChange((value ?? []).filter((v) => v !== entry))

  if (error) {
    return (
      <p className="rounded-lg bg-danger-soft p-3 text-sm font-medium text-danger">
        Could not load the data-type list: {error}
      </p>
    )
  }

  if (!catalog) {
    return (
      <p className="flex items-center gap-2 text-sm font-medium text-ink-faint">
        <Loader2 size={15} strokeWidth={2.5} className="animate-spin" />
        Loading data types…
      </p>
    )
  }

  const maxCustom = catalog.maxCustomLength ?? 64

  return (
    <div className="flex flex-col gap-4" aria-describedby={describedBy}>
      {catalog.groups.map((group) => (
        <fieldset key={group.group} className="min-w-0">
          <legend className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">
            {group.group}
          </legend>
          <div className="flex flex-wrap gap-2">
            {group.items.map((item) => {
              const on = selected.has(item.code)
              return (
                <button
                  key={item.code}
                  type="button"
                  onClick={() => toggle(item.code)}
                  disabled={disabled}
                  aria-pressed={on}
                  title={item.note ?? item.label}
                  className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${
                    on
                      ? 'border-brand bg-brand text-white'
                      : 'border-line bg-surface text-ink hover:border-brand'
                  }`}
                >
                  {on && <Check size={12} strokeWidth={3} />}
                  {item.label}
                  {/* Biometric categories are the ones a DPDP notice has to be
                      most explicit about, so they are marked in the picker
                      rather than only in the reviewer's head. */}
                  {item.sensitive && (
                    <span
                      aria-label="sensitive"
                      title="Biometric or identity data"
                      className={on ? 'text-white/70' : 'text-warning'}
                    >
                      ●
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </fieldset>
      ))}

      <fieldset className="min-w-0">
        <legend className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-faint">
          Other
        </legend>

        {(customValues.length > 0 || unknownValues.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-2">
            {[...customValues, ...unknownValues].map((entry) => (
              <span
                key={entry}
                className="flex items-center gap-1.5 rounded-full border border-warning bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning"
              >
                {entry.startsWith(OTHER_PREFIX) ? entry.slice(OTHER_PREFIX.length) : entry}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => removeValue(entry)}
                    aria-label={`Remove ${entry}`}
                    className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning"
                  >
                    <X size={12} strokeWidth={3} />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {showCustom ? (
          <div className="flex flex-wrap items-center gap-2">
            <input
              autoFocus
              value={customDraft}
              maxLength={maxCustom}
              onChange={(e) => setCustomDraft(e.target.value)}
              // Enter must not submit the surrounding form — the DPO is adding a
              // chip, not saving the notice.
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCustom()
                } else if (e.key === 'Escape') {
                  setShowCustom(false)
                  setCustomDraft('')
                }
              }}
              placeholder="Describe the data type"
              className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            />
            <button
              type="button"
              onClick={addCustom}
              disabled={!customDraft.trim()}
              className="rounded-lg bg-ink px-3 py-2 text-xs font-bold text-white disabled:opacity-50"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setShowCustom(false)
                setCustomDraft('')
              }}
              className="rounded-lg px-2 py-2 text-xs font-bold text-ink-faint"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowCustom(true)}
            disabled={disabled}
            className="flex items-center gap-1.5 rounded-full border border-dashed border-line px-3 py-1.5 text-xs font-semibold text-ink-faint hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
          >
            <Plus size={12} strokeWidth={3} />
            Other — describe it
          </button>
        )}
      </fieldset>

      <p className="text-xs font-medium text-ink-faint">
        {selected.size === 0 ? (
          <span className="text-danger">Select at least one data type.</span>
        ) : (
          `${selected.size} selected.`
        )}{' '}
        A project can only be approved if its data types are a subset of the notice&apos;s.
      </p>
    </div>
  )
}
