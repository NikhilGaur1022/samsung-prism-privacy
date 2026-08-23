import { mediaUrl } from './api'

// How a person's card is drawn when they may appear in stills, in clips, or in
// only one of the two.
//
// Extracted from Tagging.jsx so it can be tested directly: the failure it guards
// against is silent. A cluster holding ONLY video tracks has repFaceId === null,
// and the card used to pass that straight into the crop URL — producing
// `/faces/null/crop`, a broken image, and a card the agent cannot identify
// anyone from. Nothing throws; the person just becomes untaggable, and an
// untagged person stays blurred out of their own footage.

/** The best available card image, from whichever medium has one. */
export function cardImage(sessionId, cluster) {
  if (!cluster) return ''
  // A track crop is cut from the sharpest of several frames rather than from
  // whichever single frame the shutter caught, so when it is the cluster's
  // chosen representative it is preferred over a still.
  if (cluster.repTrackId && !cluster.repFaceId) {
    return mediaUrl.videoTrackCrop(sessionId, cluster.repTrackId)
  }
  if (cluster.repFaceId) return mediaUrl.faceCrop(sessionId, cluster.repFaceId)
  if (cluster.repTrackId) return mediaUrl.videoTrackCrop(sessionId, cluster.repTrackId)
  return ''
}

/**
 * "Seen in 3 photos and 1 clip".
 *
 * Both media are named because tagging covers both: one decision on this card
 * governs every appearance of this person in the session. An agent shown only
 * the photo count is tagging someone for footage they were never told about.
 */
export function seenIn(cluster) {
  const faces = cluster?.faceCount ?? 0
  const clips = cluster?.videoTrackCount ?? 0
  const parts = []
  if (faces > 0) parts.push(`${faces} photo${faces === 1 ? '' : 's'}`)
  if (clips > 0) parts.push(`${clips} clip${clips === 1 ? '' : 's'}`)
  if (parts.length === 0) return 'No appearances'
  return `Seen in ${parts.join(' and ')}`
}
