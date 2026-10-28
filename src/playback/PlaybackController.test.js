import test from 'node:test'
import assert from 'node:assert/strict'
import { PlaybackController } from './PlaybackController.js'

const localTrack = { id: 'local-1', title: 'Track one', artist: 'Artist', duration: '2:00' }
const youtubeTrack = { id: 'youtube:abc123', provider: 'youtube', videoId: 'abc123', title: 'Video title', channelName: 'Channel' }

test('controller normalizes provider state, metadata, and advertised capabilities', () => {
  const controller = new PlaybackController(localTrack)
  const unregister = controller.registerProvider('audio', {
    capabilities: { play: true, pause: true, seek: true },
  })
  controller.reportProviderState('audio', localTrack.id, { status: 'playing', currentTime: 12, duration: 120, error: '' })
  const state = controller.getState()
  assert.equal(state.provider, 'audio')
  assert.equal(state.trackId, localTrack.id)
  assert.equal(state.title, 'Track one')
  assert.equal(state.artist, 'Artist')
  assert.equal(state.position, 12)
  assert.equal(state.duration, 120)
  assert.equal(state.status, 'playing')
  assert.equal(state.capabilities.seek, true)
  assert.equal(state.capabilities.setVolume, false)
  unregister()
  assert.equal(controller.getState().capabilities.play, false)
})

test('commands delegate only when the active provider advertises support', async () => {
  const calls = []
  const controller = new PlaybackController(youtubeTrack)
  controller.registerProvider('youtube', {
    capabilities: { play: true, seek: false },
    play: () => { calls.push('play'); return true },
    seek: () => { calls.push('seek'); return true },
  })
  assert.equal(await controller.command('play'), true)
  assert.equal(await controller.command('seek', 15), false)
  assert.deepEqual(calls, ['play'])
})

test('stale provider events after a track or provider switch cannot replace current state', () => {
  const controller = new PlaybackController(localTrack)
  controller.registerProvider('audio', { capabilities: { play: true } })
  controller.registerProvider('youtube', { capabilities: { play: true } })
  controller.reportProviderState('audio', localTrack.id, { status: 'playing', currentTime: 20 })
  controller.setTrack(youtubeTrack)
  assert.equal(controller.reportProviderState('audio', localTrack.id, { status: 'paused', currentTime: 4 }), false)
  assert.equal(controller.getState().trackId, youtubeTrack.id)
  assert.equal(controller.getState().status, 'loading')
  assert.equal(controller.getState().position, 0)
})

test('load errors are normalized and provider cleanup is called once on destroy', async () => {
  const controller = new PlaybackController(localTrack)
  let destroyed = 0
  controller.registerProvider('audio', {
    capabilities: { loadTrack: true },
    loadTrack: async () => { throw new Error('provider failed') },
    destroy: () => { destroyed += 1 },
  })
  assert.equal(await controller.loadTrack(localTrack), false)
  assert.equal(controller.getState().status, 'error')
  assert.equal(controller.getState().error, 'provider failed')
  controller.destroy()
  assert.equal(destroyed, 1)
})

test('provider and controller subscriptions stop receiving updates after cleanup', () => {
  const controller = new PlaybackController(localTrack)
  let providerListener
  let providerUnsubscribed = 0
  let controllerUpdates = 0
  const stopController = controller.subscribe(() => { controllerUpdates += 1 })
  const stopProvider = controller.registerProvider('audio', {
    capabilities: { play: true },
    subscribe: (listener) => { providerListener = listener; return () => { providerUnsubscribed += 1 } },
  })
  providerListener({ trackId: localTrack.id, status: 'playing', currentTime: 5 })
  const updatesBeforeCleanup = controllerUpdates
  stopProvider()
  providerListener({ trackId: localTrack.id, status: 'paused', currentTime: 8 })
  assert.equal(providerUnsubscribed, 1)
  assert.equal(controllerUpdates, updatesBeforeCleanup + 1)
  assert.equal(controller.getState().status, 'playing')
  const updatesAfterProviderCleanup = controllerUpdates
  stopController()
  controller.setRepeatMode('all')
  assert.equal(controllerUpdates, updatesAfterProviderCleanup)
})

test('room repeat mode is reflected in normalized state without becoming local playback state', () => {
  const controller = new PlaybackController(localTrack)
  controller.setRepeatMode('all')
  assert.equal(controller.getState().repeatMode, 'all')
})
