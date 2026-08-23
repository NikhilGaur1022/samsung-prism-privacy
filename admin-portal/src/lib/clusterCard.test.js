import { describe, it, expect, vi } from 'vitest'

vi.mock('./api', () => ({
  mediaUrl: {
    faceCrop: (s, id) => `/api/v1/sessions/${s}/faces/${id}/crop`,
    videoTrackCrop: (s, id) => `/api/v1/sessions/${s}/video-tracks/${id}/crop`,
  },
}))

const { cardImage, seenIn } = await import('./clusterCard')

// A person who only ever walked through the video has no face crop.
//
// Video tracks join the SAME FaceCluster a photo face does, so one tag covers
// every appearance of a person in the session. That also means a cluster can now
// have repFaceId === null, which the card used to pass straight into the crop
// URL — `/faces/null/crop`, a broken image, and a person the agent cannot
// identify well enough to tag. An untagged person stays blurred out of their own
// footage, so the silent failure costs them the thing they consented for.

describe('cardImage', () => {
  it('uses the track crop when there is no still of this person', () => {
    const url = cardImage('s1', { repFaceId: null, repTrackId: 't1' })
    expect(url).toBe('/api/v1/sessions/s1/video-tracks/t1/crop')
    expect(url).not.toContain('null')
  })

  it('never builds a URL containing null', () => {
    expect(cardImage('s1', { repFaceId: null, repTrackId: null })).toBe('')
    expect(cardImage('s1', {})).toBe('')
    expect(cardImage('s1', null)).toBe('')
  })

  it('prefers the track crop when the cluster chose a track as its representative', () => {
    // repTrackId set with no repFaceId is the clustering saying the sharpest
    // view of this person is a video frame.
    expect(cardImage('s1', { repFaceId: null, repTrackId: 't9' })).toContain('/video-tracks/t9/')
  })

  it('uses the face crop when a still representative exists', () => {
    expect(cardImage('s1', { repFaceId: 'f1', repTrackId: 't1' })).toBe(
      '/api/v1/sessions/s1/faces/f1/crop',
    )
  })
})

describe('seenIn', () => {
  it('names both media, because one tag governs both', () => {
    expect(seenIn({ faceCount: 3, videoTrackCount: 1 })).toBe('Seen in 3 photos and 1 clip')
  })

  it('reports a video-only person as clips, not as zero photos', () => {
    // "Seen in 0 photos" is what the old photo-only string produced here, which
    // reads as "there is nothing to look at" on a card that has a face on it.
    expect(seenIn({ faceCount: 0, videoTrackCount: 2 })).toBe('Seen in 2 clips')
  })

  it('still reads correctly for a photo-only person', () => {
    expect(seenIn({ faceCount: 1, videoTrackCount: 0 })).toBe('Seen in 1 photo')
  })

  it('says something rather than nothing when a cluster is empty', () => {
    expect(seenIn({ faceCount: 0, videoTrackCount: 0 })).toBe('No appearances')
    expect(seenIn({})).toBe('No appearances')
    expect(seenIn(null)).toBe('No appearances')
  })
})
