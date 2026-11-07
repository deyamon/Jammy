import assert from 'node:assert/strict'
import test from 'node:test'
import { getRoomProgressState } from './roomPlaybackProgress.js'

const youtubeTrack = { id: 'youtube:room-track', provider: 'youtube' }
const audioTrack = { id: 'audio:room-track', provider: 'audio' }

test('room progress uses current YouTube iframe state and clamps to its reported duration', () => {
  assert.deepEqual(getRoomProgressState(youtubeTrack, {
    youtubeState: { status: 'playing', currentTime: 27, duration: 90 },
    audioState: { status: 'paused', currentTime: 0, duration: 0 },
  }), { status: 'playing', currentTime: 27, duration: 90 })
  assert.deepEqual(getRoomProgressState(youtubeTrack, {
    youtubeState: { status: 'playing', currentTime: 95, duration: 90 }, audioState: {},
  }), { status: 'playing', currentTime: 90, duration: 90 })
})

test('room progress freezes on pause and resumes from the latest reported position', () => {
  const paused = getRoomProgressState(youtubeTrack, {
    youtubeState: { status: 'paused', currentTime: 32, duration: 140 }, audioState: {},
  })
  const resumed = getRoomProgressState(youtubeTrack, {
    youtubeState: { status: 'playing', currentTime: 32.8, duration: 140 }, audioState: {},
  })
  assert.deepEqual(paused, { status: 'paused', currentTime: 32, duration: 140 })
  assert.deepEqual(resumed, { status: 'playing', currentTime: 32.8, duration: 140 })
})

test('room progress switches to the selected provider and resets with a new track state', () => {
  assert.deepEqual(getRoomProgressState(audioTrack, {
    youtubeState: { status: 'playing', currentTime: 55, duration: 100 },
    audioState: { status: 'loading', currentTime: 0, duration: 0 },
  }), { status: 'loading', currentTime: 0, duration: 0 })
})
