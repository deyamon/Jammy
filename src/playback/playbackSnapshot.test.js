import assert from 'node:assert/strict'
import test from 'node:test'
import { createPlaybackSnapshot, isCurrentRoomSession, resolveActiveTrack } from './playbackSnapshot.js'
import { applyRoomPlaybackCommand, playYouTubeFromUserGesture, restoreYouTubePlayback } from './youtubeCommands.js'

const standaloneTrack = { id: 'youtube:standalone', provider: 'youtube', videoId: 'standalone' }
const roomTrack = { id: 'youtube:room', provider: 'youtube', videoId: 'room' }

test('standalone playback snapshot preserves the selected track, position, and play state', () => {
  const snapshot = createPlaybackSnapshot(standaloneTrack, { position: 42.5, isPlaying: true })
  assert.equal(snapshot.trackId, 'youtube:standalone')
  assert.equal(snapshot.track.videoId, 'standalone')
  assert.equal(snapshot.position, 42.5)
  assert.equal(snapshot.isPlaying, true)
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.track), true)
  assert.equal(createPlaybackSnapshot(null), null)
})

test('room track updates do not replace the standalone selection', () => {
  const active = resolveActiveTrack({ roomSession: null, roomPlayback: { currentTrack: roomTrack }, tracks: [], standaloneTrack })
  assert.equal(active, standaloneTrack)
  const roomActive = resolveActiveTrack({ roomSession: {}, roomPlayback: { currentTrack: roomTrack }, tracks: [], standaloneTrack })
  assert.equal(roomActive, roomTrack)
  const emptyRoom = resolveActiveTrack({ roomSession: {}, roomPlayback: { currentTrackId: null }, tracks: [], standaloneTrack })
  assert.equal(emptyRoom, null)
})

test('room callbacks are accepted only for the active room session instance', () => {
  const firstRoom = { room: { code: 'ONE' } }
  const secondRoom = { room: { code: 'TWO' } }
  assert.equal(isCurrentRoomSession(firstRoom, firstRoom), true)
  assert.equal(isCurrentRoomSession(secondRoom, firstRoom), false)
  assert.equal(isCurrentRoomSession(null, firstRoom), false)
})

test('YouTube restoration seeks and resumes or pauses exactly once on the retained player', () => {
  const calls = []
  const player = {
    seekTo: (position, allowSeekAhead) => calls.push(['seek', position, allowSeekAhead]),
    playVideo: () => calls.push(['play']),
    pauseVideo: () => calls.push(['pause']),
  }
  assert.equal(restoreYouTubePlayback(player, { position: 18, isPlaying: true }), true)
  assert.deepEqual(calls, [['seek', 18, true], ['play']])
  calls.length = 0
  assert.equal(restoreYouTubePlayback(player, { position: 0, isPlaying: false }), true)
  assert.deepEqual(calls, [['pause']])
  assert.equal(restoreYouTubePlayback(null, { position: 4, isPlaying: true }), false)
})

test('explicit playback from the Jammy control reaches the mounted YouTube player', () => {
  let plays = 0
  assert.equal(playYouTubeFromUserGesture({ playVideo: () => { plays += 1 } }), true)
  assert.equal(plays, 1)
  assert.equal(playYouTubeFromUserGesture(null), false)
})

test('room commands seek and reach the retained player without visibility-based reinitialization', () => {
  const calls = []
  const player = {
    seekTo: (position, allowSeekAhead) => calls.push(['seek', position, allowSeekAhead]),
    playVideo: () => calls.push(['play']),
    pauseVideo: () => calls.push(['pause']),
  }
  assert.equal(applyRoomPlaybackCommand(player, { isPlaying: true, positionMs: 12500 }), true)
  assert.deepEqual(calls, [['seek', 12.5, true], ['play']])
  calls.length = 0
  applyRoomPlaybackCommand(player, { isPlaying: false, positionMs: 4000 })
  assert.deepEqual(calls, [['seek', 4, true], ['pause']])
})
