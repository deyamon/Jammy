import test from 'node:test'
import assert from 'node:assert/strict'
import { isRoomCommandEcho } from './roomCommandGuard.js'

test('matching player events from an active remote room command are echoes', () => {
  const remotePlay = { isPlaying: true, expiresAt: 5000 }
  const remotePause = { isPlaying: false, expiresAt: 5000 }
  assert.equal(isRoomCommandEcho(remotePlay, 'loading', 1000), true)
  assert.equal(isRoomCommandEcho(remotePlay, 'playing', 1000), true)
  assert.equal(isRoomCommandEcho(remotePause, 'paused', 1000), true)
  assert.equal(isRoomCommandEcho(remotePlay, 'paused', 1000), false)
  assert.equal(isRoomCommandEcho(remotePlay, 'playing', 5000), false)
})
