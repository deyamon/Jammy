import test from 'node:test'
import assert from 'node:assert/strict'
import {
  audioStateReducer,
  applyAudioMute,
  applyAudioVolume,
  clampVolume,
  formatAudioTime,
  initialAudioState,
  sliderValueFromVolume,
  volumeFromSliderValue,
} from './audioState.js'

test('volume slider maps low, medium, and high values to the audio element range', () => {
  assert.equal(volumeFromSliderValue(10), 0.1)
  assert.equal(volumeFromSliderValue(50), 0.5)
  assert.equal(volumeFromSliderValue(90), 0.9)
  assert.equal(sliderValueFromVolume(0.1), 10)
  assert.equal(sliderValueFromVolume(0.5), 50)
  assert.equal(sliderValueFromVolume(0.9), 90)
  assert.equal(clampVolume(-1), 0)
  assert.equal(clampVolume(2), 1)
  const audio = { volume: 1, muted: false }
  for (const level of [0.1, 0.5, 0.9]) {
    applyAudioVolume(audio, level, false)
    assert.equal(audio.volume, level)
    assert.equal(audio.muted, false)
  }
  applyAudioMute(audio, true)
  assert.equal(audio.volume, 0.9)
  assert.equal(audio.muted, true)
  applyAudioMute(audio, false)
  assert.equal(audio.volume, 0.9)
  assert.equal(audio.muted, false)
})

test('mute preserves the selected volume for unmute', () => {
  const volume = audioStateReducer(initialAudioState, { type: 'SET_VOLUME', volume: 0.35 })
  const muted = audioStateReducer(volume, { type: 'SET_MUTE', muted: true })
  const unmuted = audioStateReducer(muted, { type: 'SET_MUTE', muted: false })
  assert.equal(muted.volume, 0.35)
  assert.equal(muted.muted, true)
  assert.equal(unmuted.volume, 0.35)
  assert.equal(unmuted.muted, false)
})

test('player state follows media loading, metadata, time, and playback events', () => {
  let state = audioStateReducer(initialAudioState, { type: 'LOAD_START' })
  assert.equal(state.status, 'loading')
  state = audioStateReducer(state, { type: 'METADATA', duration: 125.5 })
  assert.equal(state.status, 'ready')
  assert.equal(state.duration, 125.5)
  state = audioStateReducer(state, { type: 'PLAY' })
  state = audioStateReducer(state, { type: 'TIME_UPDATE', currentTime: 18.75 })
  assert.equal(state.status, 'playing')
  assert.equal(state.currentTime, 18.75)
  assert.equal(audioStateReducer(state, { type: 'PAUSE' }).status, 'paused')
})

test('unavailable audio and autoplay rejection produce actionable states', () => {
  const unavailable = audioStateReducer(initialAudioState, { type: 'UNAVAILABLE', message: 'Add a local file.' })
  assert.equal(unavailable.status, 'unavailable')
  assert.match(unavailable.error, /local file/)
  const blocked = audioStateReducer(unavailable, { type: 'PLAY_REJECTED', message: 'Press Play in this tab.' })
  assert.equal(blocked.status, 'paused')
  assert.match(blocked.error, /Press Play/)
})

test('time formatting uses actual media time in minutes and seconds', () => {
  assert.equal(formatAudioTime(0), '0:00')
  assert.equal(formatAudioTime(78.9), '1:18')
  assert.equal(formatAudioTime(Number.NaN), '0:00')
})
