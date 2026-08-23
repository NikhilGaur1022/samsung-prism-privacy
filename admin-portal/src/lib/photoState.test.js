import { describe, it, expect } from 'vitest'
import { blockedFrameCount, TERMINAL_PII_STATUSES } from './photoState.js'

// The counter that reported zero while sixteen frames sat unredacted.
//
// Both admin screens computed "blocked" as DEFERRED + FAILED. The live database
// held 0 DEFERRED, 0 FAILED and 27 PENDING — PENDING being the schema default
// and the state an un-run redaction leaves behind — so every screen showed a
// clean project while none of its sessions could be handed off.
//
// The fix is the inversion, and this is what stops it being un-inverted.

describe('blockedFrameCount', () => {
  it('counts PENDING, which the old DEFERRED+FAILED sum missed entirely', () => {
    expect(blockedFrameCount({ CLEAN: 83, PENDING: 27 })).toBe(27)
  })

  it('reproduces the exact live distribution that used to report zero', () => {
    // photo piiStatus : CLEAN 83 · PENDING 27  (0 DEFERRED, 0 FAILED)
    const live = { CLEAN: 83, PENDING: 27, DEFERRED: 0, FAILED: 0 }
    expect(blockedFrameCount(live)).toBe(27)
    // The old expression, kept here as the thing being fixed.
    const oldSum = (live.DEFERRED ?? 0) + (live.FAILED ?? 0)
    expect(oldSum).toBe(0)
  })

  it('counts every non-terminal state', () => {
    expect(blockedFrameCount({ PENDING: 1, DEFERRED: 2, FAILED: 3 })).toBe(6)
  })

  it('counts an unknown future state as blocked', () => {
    // The whole point of the inversion: a new enum value shows up as needing
    // attention until someone deliberately declares it terminal, instead of
    // silently disappearing from every dashboard.
    expect(blockedFrameCount({ CLEAN: 5, QUARANTINED: 2 })).toBe(2)
  })

  it('counts nothing when every frame is terminal', () => {
    expect(blockedFrameCount({ CLEAN: 10, MASKED: 4 })).toBe(0)
  })

  it('handles an absent or empty map', () => {
    expect(blockedFrameCount(null)).toBe(0)
    expect(blockedFrameCount(undefined)).toBe(0)
    expect(blockedFrameCount({})).toBe(0)
  })

  it('agrees with the backend about which states are terminal', () => {
    // If these two lists ever diverge, the screen and the gate disagree about
    // the same photo — which is the class of bug this module exists to end.
    expect([...TERMINAL_PII_STATUSES].sort()).toEqual(['CLEAN', 'MASKED'])
  })
})
