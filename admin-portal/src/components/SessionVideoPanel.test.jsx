import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

import SessionVideoPanel from './SessionVideoPanel'

// The two rules this panel exists to hold to, and one shape it must not confuse.
//
// There was no video UI in either portal until 2026-08-21. The backend routes
// and the Python worker had both existed for some time, and the worker's own
// README said "between them, a human tags the clusters in the admin portal" —
// but that human had nowhere to do it, so no clip was ever uploaded and the
// entire video path was unreachable from the product.

const listVideos = vi.fn()

vi.mock('../lib/api', () => ({
  listVideos: (...args) => listVideos(...args),
  uploadVideo: vi.fn(),
  mediaUrl: {
    redactedVideo: (s, v) => `/api/v1/sessions/${s}/videos/${v}/redacted`,
    videoTrackCrop: (s, t) => `/api/v1/sessions/${s}/video-tracks/${t}/crop`,
  },
}))

const clip = (over = {}) => ({
  id: 'v1',
  status: 'REDACTED',
  redactedPath: 'sessions/s1/redacted/v1.mp4',
  durationSec: 3,
  width: 640,
  height: 360,
  ...over,
})

beforeEach(() => {
  listVideos.mockReset()
})

describe('SessionVideoPanel', () => {
  it('never offers the original clip, only the blurred derivative', async () => {
    listVideos.mockResolvedValue({ videos: [clip()] })
    const { container } = render(<SessionVideoPanel sessionId="s1" canCapture sessionStatus="ACTIVE" />)

    const player = await waitFor(() => {
      const el = container.querySelector('video')
      expect(el).toBeTruthy()
      return el
    })

    // An unblurred clip on an operator's screen shows bystanders' faces to
    // someone with no lawful basis for them, and being an admin does not create
    // one. There is deliberately no `rawVideo` URL in the api module at all.
    expect(player.getAttribute('src')).toContain('/redacted')
    expect(player.getAttribute('src')).not.toContain('/raw')
    expect(player.getAttribute('src')).not.toMatch(/\/videos\/v1\/file/)
  })

  it('does not render a player for a clip that has no blurred copy yet', async () => {
    listVideos.mockResolvedValue({ videos: [clip({ status: 'ANALYZED', redactedPath: null })] })
    const { container } = render(<SessionVideoPanel sessionId="s1" canCapture sessionStatus="ACTIVE" />)

    await screen.findByText(/faces found, not yet blurred/i)
    expect(container.querySelector('video')).toBeNull()
  })

  it('treats REDACTED-with-no-file as unfinished, not as done', async () => {
    // The status column can be set by a code path that crashed before writing
    // the bytes. The backend predicate is an AND of both columns for exactly
    // this reason, and the screen has to agree with it or it advertises a clip
    // the serving layer will refuse.
    listVideos.mockResolvedValue({ videos: [clip({ status: 'REDACTED', redactedPath: null })] })
    const { container } = render(<SessionVideoPanel sessionId="s1" canCapture sessionStatus="ACTIVE" />)

    await screen.findByText(/no blurred copy was written/i)
    expect(container.querySelector('video')).toBeNull()
  })

  it('explains that unfinished clips are what hold the session open', async () => {
    listVideos.mockResolvedValue({
      videos: [clip(), clip({ id: 'v2', status: 'ANALYZED', redactedPath: null })],
    })
    render(<SessionVideoPanel sessionId="s1" canCapture sessionStatus="ACTIVE" />)

    expect(await screen.findByText(/cannot be archived or handed off/i)).toBeInTheDocument()
  })

  it('names a failed analysis as a failure rather than showing a broken player', async () => {
    listVideos.mockResolvedValue({ videos: [clip({ status: 'DEFERRED', redactedPath: null })] })
    const { container } = render(<SessionVideoPanel sessionId="s1" canCapture sessionStatus="ACTIVE" />)

    expect(await screen.findByText(/could not analyse this clip/i)).toBeInTheDocument()
    expect(container.querySelector('video')).toBeNull()
  })

  it('says video is switched off rather than showing an error nobody can act on', async () => {
    const err = new Error('Video capture is not enabled in this environment.')
    err.status = 503
    listVideos.mockRejectedValue(err)
    render(<SessionVideoPanel sessionId="s1" canCapture sessionStatus="ACTIVE" />)

    expect(await screen.findByText(/switched off in this environment/i)).toBeInTheDocument()
  })

  // Redaction is queued work that finishes minutes after finalize. The panel
  // used to load once, so an operator who arrived while blurring was still
  // running sat in front of a screen that would never update and concluded no
  // blurred copy had been made.
  it('picks up the blurred copy on its own once redaction finishes', async () => {
    vi.useFakeTimers()
    try {
      listVideos
        .mockResolvedValueOnce({ videos: [clip({ status: 'ANALYZED', redactedPath: null })] })
        .mockResolvedValue({ videos: [clip()] })

      const { container } = render(
        <SessionVideoPanel sessionId="s1" canCapture={false} sessionStatus="ARCHIVED" />,
      )

      // act() around the timer advance, not just await: the poll resolves a
      // promise inside the interval callback, and without act React never
      // flushes that state update, so the assertion below reads a DOM that is
      // one render behind.
      await act(async () => {})
      expect(listVideos).toHaveBeenCalledTimes(1)
      expect(container.querySelector('video')).toBeNull()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000)
      })
      expect(container.querySelector('video')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  // DEFERRED is terminal. Polling it would be a busy-wait on something no
  // amount of waiting fixes.
  it('does not poll a clip whose analysis already failed', async () => {
    vi.useFakeTimers()
    try {
      listVideos.mockResolvedValue({ videos: [clip({ status: 'DEFERRED', redactedPath: null })] })
      render(<SessionVideoPanel sessionId="s1" canCapture={false} sessionStatus="ARCHIVED" />)

      await act(async () => {})
      expect(listVideos).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000)
      })
      expect(listVideos).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('hides the upload control once the session is no longer capturing', async () => {
    listVideos.mockResolvedValue({ videos: [] })
    render(<SessionVideoPanel sessionId="s1" canCapture={false} sessionStatus="TAGGING" />)

    await screen.findByText(/no clips in this session/i)
    expect(screen.queryByText(/add clip/i)).not.toBeInTheDocument()
  })
})
