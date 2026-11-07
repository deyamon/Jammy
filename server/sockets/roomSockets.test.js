import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { QueueService } from '../services/queueService.js'
import { RoomChatService } from '../services/roomChatService.js'
import { RoomService } from '../services/roomService.js'
import { YouTubeService } from '../services/youtubeService.js'
import { initializeRoomSockets } from './roomSockets.js'

class FakeSocket extends EventEmitter {
  constructor(session) {
    super()
    this.handshake = { auth: { code: session.room.code, memberId: session.member.id, memberToken: session.memberToken } }
    this.data = {}
    this.request = { headers: { cookie: session.accountCookie ?? '' } }
    this.rooms = new Set()
    this.connected = true
  }

  async join(room) { this.rooms.add(room) }

  disconnect() {
    if (!this.connected) return
    this.connected = false
    this.emit('disconnect')
    this.rooms.clear()
  }
}

class FakeIo extends EventEmitter {
  constructor() {
    super()
    this.sockets = []
    this.middleware = null
  }

  use(handler) { this.middleware = handler }

  to(room) {
    return { emit: (event, payload) => {
      for (const socket of this.sockets) if (socket.rooms.has(room)) socket.emit(event, payload)
    } }
  }
}

function waitFor(socket, eventName, predicate = () => true, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off(eventName, onEvent); reject(new Error(`Timed out waiting for ${eventName}`)) }, timeoutMs)
    const onEvent = (payload) => {
      if (!predicate(payload)) return
      clearTimeout(timeout)
      socket.off(eventName, onEvent)
      resolve(payload)
    }
    socket.on(eventName, onEvent)
  })
}

function emitAck(socket, eventName, payload) {
  return new Promise((resolve) => socket.emit(eventName, payload, resolve))
}

async function connect(io, session) {
  const socket = new FakeSocket(session)
  await new Promise((resolve, reject) => io.middleware(socket, (error) => error ? reject(error) : resolve()))
  io.sockets.push(socket)
  const initial = waitFor(socket, 'room:state')
  await io.listeners('connection')[0](socket)
  await initial
  return socket
}

test('host reconnect grace expires to one promoted host and stale disconnects are ignored', async () => {
  const roomService = new RoomService()
  const queueService = new QueueService({ roomService })
  const chatService = new RoomChatService()
  const io = new FakeIo()
  initializeRoomSockets(io, roomService, queueService, 25, chatService)

  const host = await roomService.createRoom({ name: 'Socket host handoff', displayName: 'Host' })
  const guest = await roomService.joinRoom({ code: host.room.code, displayName: 'Guest' })
  const hostSocket = await connect(io, host)
  const guestSocket = await connect(io, guest)

  const hostOffline = waitFor(guestSocket, 'room:state', (room) => room.members.some((member) => member.id === host.member.id && !member.online))
  hostSocket.disconnect()
  await hostOffline
  const hostReconnected = await connect(io, host)
  await new Promise((resolve) => setTimeout(resolve, 40))
  let room = await roomService.getRoom({ code: host.room.code })
  assert.equal(room.members.find((member) => member.id === host.member.id).role, 'owner')
  assert.equal(room.members.find((member) => member.id === host.member.id).online, true)

  const promoted = waitFor(guestSocket, 'room:state', (state) => state.members.length === 1 && state.members[0].id === guest.member.id && state.members[0].role === 'owner')
  hostReconnected.disconnect()
  await promoted
  room = await roomService.getRoom({ code: guest.room.code })
  assert.equal(room.members.filter((member) => member.role === 'owner').length, 1)

  hostSocket.emit('disconnect')
  hostReconnected.emit('disconnect')
  await new Promise((resolve) => setTimeout(resolve, 40))
  room = await roomService.getRoom({ code: guest.room.code })
  assert.equal(room.members.length, 1)
  assert.equal(room.members[0].id, guest.member.id)
  assert.equal(room.members[0].role, 'owner')
  assert.equal(room.members[0].online, true)
})

test('Autoplay setting is shared through Socket.IO and remains host-only', async () => {
  const roomService = new RoomService()
  const queueService = new QueueService({ roomService })
  const io = new FakeIo()
  initializeRoomSockets(io, roomService, queueService, 100)
  const host = await roomService.createRoom({ name: 'Autoplay socket', displayName: 'Host' })
  const guest = await roomService.joinRoom({ code: host.room.code, displayName: 'Guest' })
  const hostSocket = await connect(io, host)
  const guestSocket = await connect(io, guest)
  const sharedState = waitFor(guestSocket, 'playback:state', (state) => state.autoplayEnabled === true)
  const enabled = await emitAck(hostSocket, 'playback:autoplay', { enabled: true })
  assert.equal(enabled.ok, true)
  assert.equal((await sharedState).autoplayEnabled, true)
  const denied = await emitAck(guestSocket, 'playback:autoplay', { enabled: false })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'ROOM_HOST_REQUIRED')
  assert.equal((await queueService.state({ code: host.room.code, memberId: host.member.id, memberToken: host.memberToken })).playback.autoplayEnabled, true)
  hostSocket.disconnect()
  guestSocket.disconnect()
})

test('track end runs smart Autoplay through the real YouTube result shape and broadcasts the committed queue', async () => {
  const roomService = new RoomService()
  const searchQueries = []
  const videos = [
    { id: { videoId: 'abcdefghijk' }, snippet: { title: 'Sunset Lover (Official Audio) - Petit Biscuit', channelTitle: 'Petit Biscuit - Topic' } },
    { id: { videoId: 'lmnopqrstuv' }, snippet: { title: 'Night Owl - Petit Biscuit', channelTitle: 'Petit Biscuit - Topic' } },
    { id: { videoId: 'zyxwvutsrqp' }, snippet: { title: 'Never Left - KAYTRANADA', channelTitle: 'KAYTRANADA - Topic' } },
  ]
  const youtubeService = new YouTubeService({ apiKey: 'test-key', fetchImpl: async (url) => {
    const request = new URL(url)
    if (request.pathname.endsWith('/videos')) return { ok: true, json: async () => ({ items: videos.map(({ id }) => ({ id: id.videoId, status: { madeForKids: false, embeddable: true } })) }) }
    searchQueries.push(request.searchParams.get('q'))
    return { ok: true, json: async () => ({ items: videos }) }
  } })
  const queueService = new QueueService({ roomService, youtubeService })
  const io = new FakeIo()
  initializeRoomSockets(io, roomService, queueService, 100)
  const host = await roomService.createRoom({ name: 'Autoplay end-to-end', displayName: 'Host' })
  const guest = await roomService.joinRoom({ code: host.room.code, displayName: 'Guest' })
  const hostIdentity = { code: host.room.code, memberId: host.member.id, memberToken: host.memberToken }
  const initialResult = youtubeService.signSelection({ videoId: 'abcdefghijk', provider: 'youtube', title: 'Sunset Lover (Official Audio) - Petit Biscuit', channelName: 'Petit Biscuit - Topic', thumbnails: {} })
  const added = await queueService.add(hostIdentity, { trackId: 'youtube:abcdefghijk', trackData: initialResult })
  const selected = await queueService.select(hostIdentity, { itemId: added.queue[0].itemId, playImmediately: true })
  const hostSocket = await connect(io, host)
  const guestSocket = await connect(io, guest)
  const enabledState = waitFor(guestSocket, 'playback:state', (state) => state.autoplayEnabled === true)
  assert.equal((await emitAck(hostSocket, 'playback:autoplay', { enabled: true })).ok, true)
  await enabledState

  const sharedQueue = waitFor(guestSocket, 'queue:state', (state) => state.queue.some((item) => item.trackId === 'youtube:zyxwvutsrqp'))
  const sharedPlayback = waitFor(guestSocket, 'playback:state', (state) => state.currentTrackId === 'youtube:lmnopqrstuv')
  const ended = { expectedTrackId: selected.playback.currentTrackId, expectedPlaybackToken: selected.playback.playbackToken }
  const results = await Promise.all([
    emitAck(hostSocket, 'playback:next', ended),
    emitAck(hostSocket, 'playback:next', ended),
    emitAck(guestSocket, 'playback:next', ended),
  ])

  assert.equal(results.filter((result) => result.ok).length, 2)
  assert.equal(results.filter((result) => result.code === 'ROOM_HOST_REQUIRED').length, 1)
  assert.equal((await sharedPlayback).currentTrackIsAutoplay, true)
  assert.deepEqual((await sharedQueue).queue.map((item) => item.trackId), ['youtube:zyxwvutsrqp'])
  assert.equal(searchQueries.length, 3)
  const finalState = await queueService.state(hostIdentity)
  assert.equal(finalState.playback.currentTrackId, 'youtube:lmnopqrstuv')
  assert.deepEqual(finalState.queue.map((item) => item.trackId), ['youtube:zyxwvutsrqp'])
  hostSocket.disconnect()
  guestSocket.disconnect()
})

test('account socket identity comes only from a validated cookie and is cleared on revocation', async () => {
  const roomService = new RoomService()
  const queueService = new QueueService({ roomService })
  const io = new FakeIo()
  let revokeSession
  const authService = {
    async resolveSession(token) {
      return token === 'valid-cookie-token'
        ? { sessionId: 'session-1', tokenHash: 'hash-1', expiresAt: new Date(Date.now() + 60_000), user: { id: 'account-1', username: 'mina' } }
        : null
    },
    addSessionRevoker(callback) { revokeSession = callback; return () => {} },
    async validateSessionHash() { return null },
  }
  initializeRoomSockets(io, roomService, queueService, 100, null, authService)
  const room = await roomService.createRoom({ name: 'Optional account session', displayName: 'Guest' })
  const accountSocket = await connect(io, { ...room, accountCookie: 'jammy_session=valid-cookie-token' })
  assert.deepEqual(accountSocket.data.accountIdentity, { id: 'account-1', username: 'mina' })
  accountSocket.handshake.auth.accountId = 'attacker-chosen-id'
  assert.equal(accountSocket.data.accountIdentity.id, 'account-1')
  revokeSession('hash-1')
  assert.equal(accountSocket.data.accountIdentity, null)

  const guestRoom = await roomService.createRoom({ name: 'Invalid optional account cookie', displayName: 'Guest' })
  const guestSocket = await connect(io, { ...guestRoom, accountCookie: 'jammy_session=invalid-token' })
  assert.equal(guestSocket.data.accountIdentity, undefined)
  assert.equal(guestSocket.connected, true)
})
