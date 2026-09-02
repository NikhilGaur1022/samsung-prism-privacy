// The controlled vocabulary for "what personal data does this collection touch".
//
// It exists because both `ConsentTemplate.dataTypes` and `Project.dataTypes` were
// free text, and `assertPurposeLimitation` compares them with an exact string
// match: a template disclosing "Face" and a project declaring "face" is an
// undisclosed data type, and the project is refused with a message naming a
// category that looks, to the person reading it, identical to one on the notice.
// The reverse is worse — two spellings that happen to agree let a project through
// on a notice that never described what it collects.
//
// A DPDP §5 notice is also the document the principal actually reads. "hands,
// face, misc" is not a lawful description of processing, and free text is how you
// get there. Choosing from a list is the fix for both problems at once.
//
// FACE, VOICE and TEXT are first and keep those exact codes: they are what every
// existing template and project in this deployment already stores, and renaming
// them would invalidate live consent records to make a list tidier.

/**
 * @typedef {object} DataTypeEntry
 * @property {string} code      stored value — stable, never renamed once shipped
 * @property {string} label     what a DPO and a principal see
 * @property {string} group     heading it sits under in the picker
 * @property {string} [note]    why it is its own category, where that is not obvious
 * @property {boolean} [sensitive] biometric or identity data
 */

/** @type {readonly DataTypeEntry[]} */
export const DATA_TYPE_CATALOG = Object.freeze([
  // --- The four modalities this platform actually captures --------------------
  {
    code: 'FACE',
    label: 'Face',
    group: 'Biometric',
    note: 'A face as it appears in a photograph or video frame.',
    sensitive: true,
  },
  {
    code: 'VOICE',
    label: 'Voice',
    group: 'Biometric',
    note: 'Recorded speech, whatever is said in it.',
    sensitive: true,
  },
  {
    code: 'TEXT',
    label: 'Written text',
    group: 'Documents and scene text',
    note: 'Text supplied as a document rather than read out of an image.',
  },
  {
    code: 'FACE_EMBEDDING',
    label: 'Face embedding',
    group: 'Biometric',
    // Its own category rather than part of FACE: an embedding outlives the image
    // it came from and is matchable across projects, so a notice covering "face"
    // does not obviously cover retaining a template of it.
    note: 'The numeric face template derived from an image. Retained separately from the image.',
    sensitive: true,
  },
  {
    code: 'VOICE_EMBEDDING',
    label: 'Voice embedding',
    group: 'Biometric',
    note: 'The numeric speaker template derived from a recording.',
    sensitive: true,
  },
  { code: 'GAIT', label: 'Gait / walking pattern', group: 'Biometric', sensitive: true },
  { code: 'FINGERPRINT', label: 'Fingerprint', group: 'Biometric', sensitive: true },
  { code: 'IRIS', label: 'Iris', group: 'Biometric', sensitive: true },

  // --- Body and appearance ----------------------------------------------------
  {
    code: 'HANDS',
    label: 'Hands',
    group: 'Body and appearance',
    note: 'Hand shape or gesture, where the hands are the subject of the capture.',
  },
  { code: 'FULL_BODY', label: 'Full body', group: 'Body and appearance' },
  { code: 'CLOTHING', label: 'Clothing and accessories', group: 'Body and appearance' },

  // --- Direct identifiers -----------------------------------------------------
  { code: 'NAME', label: 'Name', group: 'Direct identifiers' },
  { code: 'EMAIL', label: 'Email address', group: 'Direct identifiers' },
  { code: 'PHONE', label: 'Phone number', group: 'Direct identifiers' },
  { code: 'POSTAL_ADDRESS', label: 'Postal address', group: 'Direct identifiers' },
  { code: 'DATE_OF_BIRTH', label: 'Date of birth', group: 'Direct identifiers' },
  {
    code: 'GOVERNMENT_ID',
    label: 'Government ID number',
    group: 'Direct identifiers',
    note: 'Aadhaar, PAN, passport or driving licence numbers.',
    sensitive: true,
  },

  // --- Documents and text found in a scene ------------------------------------
  {
    code: 'ID_DOCUMENT',
    label: 'Identity document (image)',
    group: 'Documents and scene text',
    note: 'A card or document visible in a frame, as opposed to a number typed in.',
    sensitive: true,
  },
  {
    code: 'PRINTED_TEXT',
    label: 'Printed text in frame',
    group: 'Documents and scene text',
    note: 'Incidental text the capture picks up — signage, labels, screens.',
  },
  { code: 'LICENCE_PLATE', label: 'Vehicle licence plate', group: 'Documents and scene text' },
  { code: 'SIGNATURE', label: 'Handwritten signature', group: 'Documents and scene text' },

  // --- Context captured alongside the media -----------------------------------
  { code: 'LOCATION', label: 'Location', group: 'Context' },
  { code: 'TIMESTAMP', label: 'Date and time of capture', group: 'Context' },
  { code: 'DEVICE_METADATA', label: 'Device and capture metadata', group: 'Context' },
])

export const DATA_TYPE_CODES = Object.freeze(DATA_TYPE_CATALOG.map((d) => d.code))

const CODE_SET = new Set(DATA_TYPE_CODES)

// Anything the catalogue does not cover is stored under this prefix.
//
// Prefixed rather than stored bare so the two cases stay distinguishable forever:
// a reviewer reading a stored row can tell a vocabulary term from something an
// operator typed, and the picker can round-trip it back into the "Other" box
// instead of silently dropping it. It also keeps the subset check honest — two
// custom entries still have to match each other exactly, which is the same rule
// as before, but now it is the ONLY place that rule applies.
export const OTHER_PREFIX = 'OTHER:'

export const MAX_CUSTOM_LENGTH = 64

/** True for a catalogue code or a well-formed custom entry. */
export function isValidDataType(value) {
  if (typeof value !== 'string') return false
  if (CODE_SET.has(value)) return true
  if (!value.startsWith(OTHER_PREFIX)) return false
  const custom = value.slice(OTHER_PREFIX.length).trim()
  return custom.length > 0 && custom.length <= MAX_CUSTOM_LENGTH
}

/**
 * Normalises one entry, or returns null if it cannot be salvaged.
 *
 * Case and surrounding space are forgiven on catalogue codes because they are the
 * difference that used to break the subset check silently. Nothing else is
 * guessed: an unrecognised word is NOT quietly promoted to a custom entry, since
 * that would turn a typo into a new data category on a legal notice.
 */
export function normaliseDataType(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null

  const upper = trimmed.toUpperCase()
  if (CODE_SET.has(upper)) return upper

  if (upper.startsWith(OTHER_PREFIX)) {
    const custom = trimmed.slice(OTHER_PREFIX.length).trim().replace(/\s+/g, ' ')
    if (!custom || custom.length > MAX_CUSTOM_LENGTH) return null
    return `${OTHER_PREFIX}${custom}`
  }
  return null
}

/** Human-readable form for a notice, a report or an error message. */
export function labelForDataType(value) {
  if (typeof value !== 'string') return ''
  if (value.startsWith(OTHER_PREFIX)) return value.slice(OTHER_PREFIX.length)
  return DATA_TYPE_CATALOG.find((d) => d.code === value)?.label ?? value
}

/** The catalogue grouped for a picker, in declaration order. */
export function groupedCatalog() {
  const groups = []
  for (const entry of DATA_TYPE_CATALOG) {
    let group = groups.find((g) => g.group === entry.group)
    if (!group) {
      group = { group: entry.group, items: [] }
      groups.push(group)
    }
    group.items.push(entry)
  }
  return groups
}
