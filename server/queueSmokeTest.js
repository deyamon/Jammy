import assert from 'node:assert/strict'
import { io } from 'socket.io-client'

const apiBase = process.env.VITE_API_URL || 'http://localhost:3001'
const sockets = []

async function request(path, options) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
  return { response, body: await response.json().catch(() => ({})) }
}

function waitForSocketEvent(socket, name, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler); reject(new Error(`Timed out waiting for ${name}.`)) }, timeoutMs)
    const handler = (payload) => {
      if (!predicate(payload)) return
      clearTimeout(timer)
      socket.off(name, handler)
      resolve(payload)
    }
    socket.on(name, handler)
  })
}

async function connect(session, roomCode = session.room.code) {
  const socket = io(apiBase, {
    auth: { code: roomCode, memberId: session.member.id, memberToken: session.memberToken },
    autoConnect: false,
    reconnection: false,
    timeout: 5000,
  })
  sockets.push(socket)
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  })
  const initialQueue = waitForSocketEvent(socket, 'queue:state')
  socket.connect()
  await connected
  await initialQueue
  return socket
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} did not acknowledge the request.`)), 5000)
    socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result) })
  })
}

async function createRoom(name) {
  const { response, body } = await request('/api/rooms', {
    method: 'POST', body: JSON.stringify({ name, displayName: 'Host', maxMembers: 8 }),
  })
  assert.equal(response.status, 201)
  return body
}

async function main() {
  const host = await createRoom('Queue smoke room')
  const hostSocket = await connect(host)
  const guestJoin = await request(`/api/rooms/${host.room.code}/join`, {
    method: 'POST', body: JSON.stringify({ displayName: 'Guest' }),
  })
  assert.equal(guestJoin.response.status, 201)
  const guest = guestJoin.body
  const guestSocket = await connect(guest)

  const guestReceivesAdd = waitForSocketEvent(guestSocket, 'queue:state', (state) => state.queue.length === 1)
  assert.equal((await emitAck(hostSocket, 'queue:add', { trackId: 'sunset-lover' })).ok, true)
  const guestQueue = await guestReceivesAdd
  assert.equal(guestQueue.queue[0].trackId, 'sunset-lover')
  console.log('✓ two independent room members receive the same live queue update')

  const unknownTrack = await emitAck(guestSocket, 'queue:add', { trackId: 'provider-injected-track' })
  assert.equal(unknownTrack.ok, false)
  assert.equal(unknownTrack.code, 'QUEUE_INPUT_INVALID')
  const malformedId = await emitAck(hostSocket, 'queue:remove', { itemId: 'not-a-uuid' })
  assert.equal(malformedId.ok, false)
  assert.equal(malformedId.code, 'QUEUE_INPUT_INVALID')
  const malformedPlayback = await emitAck(hostSocket, 'playback:update', { isPlaying: 'yes', positionMs: -1 })
  assert.equal(malformedPlayback.ok, false)
  console.log('✓ unknown track IDs, malformed queue IDs, and invalid playback updates are rejected')

  const unrelatedRoom = await createRoom('Unrelated queue room')
  const unrelatedSocket = await connect(unrelatedRoom)
  let unrelatedQueueEvents = 0
  unrelatedSocket.on('queue:state', () => { unrelatedQueueEvents += 1 })
  await emitAck(hostSocket, 'queue:add', { trackId: 'show-me-how' })
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(unrelatedQueueEvents, 0, 'room queue events must not leak to unrelated rooms')
  console.log('✓ queue updates are scoped to their room')

  const wrongRoomIdentity = io(apiBase, {
    auth: { code: host.room.code, memberId: '00000000-0000-4000-8000-000000000000', memberToken: host.memberToken },
    autoConnect: false, reconnection: false, timeout: 5000,
  })
  const authError = new Promise((resolve) => wrongRoomIdentity.once('connect_error', resolve))
  wrongRoomIdentity.connect()
  assert.equal((await authError).message, 'ROOM_SESSION_INVALID')
  wrongRoomIdentity.disconnect()
  console.log('✓ unauthenticated socket cannot join or mutate a room')

  const beforeReorder = waitForSocketEvent(guestSocket, 'queue:state', (state) => state.queue.length === 2 && state.queue[0].trackId === 'show-me-how')
  const roomState = await (async () => {
    const { response, body } = await request(`/api/rooms/${host.room.code}`, {
      headers: { Authorization: `Bearer ${host.memberToken}`, 'X-Room-Member-Id': host.member.id },
    })
    assert.equal(response.status, 200)
    return body.room
  })()
  assert.equal(roomState.code, host.room.code)
  const reorderResult = await emitAck(guestSocket, 'queue:reorder', { itemId: guestQueue.queue[0].itemId, toIndex: 1 })
  assert.equal(reorderResult.ok, true)
  await beforeReorder

  const selectedPlayback = waitForSocketEvent(hostSocket, 'playback:state', (state) => state.currentTrackId === 'show-me-how')
  const nextQueue = waitForSocketEvent(hostSocket, 'queue:state', (state) => state.queue.length === 1)
  const selected = await emitAck(guestSocket, 'playback:select', { itemId: reorderResult.state.queue[0].itemId, playImmediately: true })
  assert.equal(selected.ok, true)
  assert.equal(selected.state.playback.isPlaying, true, 'selecting a track with Play starts synchronized playback immediately')
  await Promise.all([selectedPlayback, nextQueue])
  const playingState = waitForSocketEvent(guestSocket, 'playback:state', (state) => state.isPlaying && state.positionMs === 12000)
  assert.equal((await emitAck(hostSocket, 'playback:update', { isPlaying: true, positionMs: 12000 })).ok, true)
  await playingState
  assert.equal((await emitAck(hostSocket, 'playback:update', { isPlaying: true, positionMs: 12000 })).state.playback.isPlaying, true)
  console.log('✓ queue reorder and selected-track playback state synchronize without audio')

  const nextState = await emitAck(hostSocket, 'playback:next', { expectedTrackId: 'show-me-how', expectedPlaybackToken: selected.state.playback.playbackToken })
  assert.equal(nextState.ok, true)
  assert.equal(nextState.state.playback.currentTrackId, 'sunset-lover')
  assert.equal(nextState.state.playback.isPlaying, true)
  const duplicateEndedEvent = await emitAck(guestSocket, 'playback:next', { expectedTrackId: 'show-me-how', expectedPlaybackToken: selected.state.playback.playbackToken })
  assert.equal(duplicateEndedEvent.ok, true)
  assert.equal(duplicateEndedEvent.state.playback.currentTrackId, 'sunset-lover', 'stale ended events must not skip another queued track')
  console.log('✓ room auto-advance is idempotent for stale cross-client ended events')

  const repeatOne = await emitAck(hostSocket, 'playback:repeat', { repeatMode: 'one' })
  assert.equal(repeatOne.ok, true)
  assert.equal(repeatOne.state.playback.repeatMode, 'one')
  const repeatedOne = await emitAck(guestSocket, 'playback:next', { expectedTrackId: 'sunset-lover', expectedPlaybackToken: repeatOne.state.playback.playbackToken })
  assert.equal(repeatedOne.state.playback.currentTrackId, 'sunset-lover')
  assert.equal(repeatedOne.state.playback.isPlaying, true)
  assert.equal(repeatedOne.state.playback.positionMs, 0)
  console.log('✓ Repeat One restarts the current room track on a synchronized end event')

  await emitAck(hostSocket, 'queue:add', { trackId: 'sunset-lover' })
  await emitAck(hostSocket, 'queue:add', { trackId: 'tadow' })
  const repeatAll = await emitAck(guestSocket, 'playback:repeat', { repeatMode: 'all' })
  assert.equal(repeatAll.state.playback.repeatMode, 'all')
  const repeatedAll = await emitAck(hostSocket, 'playback:next', { expectedTrackId: 'sunset-lover', expectedPlaybackToken: repeatAll.state.playback.playbackToken })
  assert.equal(repeatedAll.state.playback.currentTrackId, 'sunset-lover', 'Repeat All can select another queued entry for the same video')
  assert.notEqual(repeatedAll.state.playback.playbackToken, repeatAll.state.playback.playbackToken)
  assert.equal(repeatedAll.state.queue.at(-1).trackId, 'sunset-lover')
  const duplicateRepeatAll = await emitAck(guestSocket, 'playback:next', { expectedTrackId: 'sunset-lover', expectedPlaybackToken: repeatAll.state.playback.playbackToken })
  assert.equal(duplicateRepeatAll.state.playback.currentTrackId, 'sunset-lover', 'a duplicate end event for the same video entry must not advance twice')
  const skipped = await emitAck(hostSocket, 'playback:skip', { expectedTrackId: 'sunset-lover', expectedPlaybackToken: repeatedAll.state.playback.playbackToken })
  assert.equal(skipped.state.playback.currentTrackId, 'tadow')
  console.log('✓ Repeat All rotates the room queue and explicit next remains idempotent')

  for (const item of skipped.state.queue) {
    const removed = await emitAck(hostSocket, 'queue:remove', { itemId: item.itemId })
    assert.equal(removed.ok, true)
  }

  const fakeYoutube = await emitAck(hostSocket, 'queue:add', {
    trackId: 'youtube:abcdefghijk', trackData: { provider: 'youtube', videoId: 'abcdefghijk', title: 'Forged', channelName: 'Fake' },
  })
  assert.equal(fakeYoutube.ok, false)
  console.log('✓ room queue rejects YouTube metadata that was not signed by backend search')

  const finalSize = waitForSocketEvent(guestSocket, 'queue:state', (state) => state.queue.length === 50)
  for (let index = 0; index < 50; index += 1) {
    const result = await emitAck(hostSocket, 'queue:add', { trackId: index % 2 ? 'tadow' : 'sweet-disposition' })
    assert.equal(result.ok, true, `track ${index + 1} should fit in the queue`)
  }
  await finalSize
  const overflow = await emitAck(hostSocket, 'queue:add', { trackId: 'sunset-lover' })
  assert.equal(overflow.ok, false)
  assert.equal(overflow.code, 'QUEUE_FULL')
  console.log('✓ queue accepts 50 items and rejects item 51')

  const invalidRoom = await request('/api/rooms/!!!')
  assert.equal(invalidRoom.response.status, 400)
  console.log('Queue smoke checks passed.')
}

try {
  await main()
} catch (error) {
  console.error('Queue smoke checks failed:', error)
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.disconnect()
}
