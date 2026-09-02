// Renders a stored data-type value for a human, without needing the catalogue.
//
// The catalogue is the authority on labels, but the screens that merely LIST a
// notice or a project should not each fetch it to render a chip. This derives a
// readable form from the stored code, which is why the codes are written the way
// they are: FACE_EMBEDDING -> "Face embedding".
//
// A custom entry keeps its own words verbatim — it was typed by a DPO to describe
// something the vocabulary does not cover, and reformatting it would change the
// text of a legal notice.

const OTHER_PREFIX = 'OTHER:'

export function dataTypeLabel(value) {
  if (typeof value !== 'string' || !value) return ''
  if (value.startsWith(OTHER_PREFIX)) return value.slice(OTHER_PREFIX.length)
  const words = value.replace(/_/g, ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function isCustomDataType(value) {
  return typeof value === 'string' && value.startsWith(OTHER_PREFIX)
}

export function formatDataTypes(values, fallback = 'no data types disclosed') {
  if (!Array.isArray(values) || values.length === 0) return fallback
  return values.map(dataTypeLabel).join(', ')
}
