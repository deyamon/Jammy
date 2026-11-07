import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldSkipUnavailableAutoplayTrack } from './autoplay.js'

const context = {
  isHost: true,
  track: { provider: 'youtube' },
  playback: { currentTrackId: 'youtube:abcdefghijk', currentTrackIsAutoplay: true, playbackToken: 'current-token' },
  status: 'error',
}

test('an unavailable autoplay YouTube recommendation is skipped once by the host', () => {
  assert.equal(shouldSkipUnavailableAutoplayTrack(context), true)
  assert.equal(shouldSkipUnavailableAutoplayTrack({ ...context, status: 'unavailable' }), true)
  assert.equal(shouldSkipUnavailableAutoplayTrack({ ...context, attemptedToken: 'current-token' }), false)
})

test('manual tracks, guests, and non-error states are never auto-skipped', () => {
  assert.equal(shouldSkipUnavailableAutoplayTrack({ ...context, playback: { ...context.playback, currentTrackIsAutoplay: false } }), false)
  assert.equal(shouldSkipUnavailableAutoplayTrack({ ...context, isHost: false }), false)
  assert.equal(shouldSkipUnavailableAutoplayTrack({ ...context, status: 'paused' }), false)
})
