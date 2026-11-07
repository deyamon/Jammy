import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { QueueService } from '../services/queueService.js'
import { RoomService } from '../services/roomService.js'
import { VoiceSignaling } from './voiceSignaling.js'

class TestSocket extends EventEmitter {
  constructor(id, identity) {
    super()
    this.id = id
    this.data = { roomIdentity: identity }
    this.connected = true
    this.rooms = new Set([identity.code])
  }
}

class TestIo {
  constructor() { this.sockets = { sockets: new Map() } }
  to(room) {
    return { emit: (event, payload) => {
      for (const socket of this.sockets.sockets.values()) if (socket.rooms.has(room)) socket.emit(event, payload)
    } }
  }
  add(socket) { this.sockets.sockets.set(socket.id, socket) }
}

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve))
}

async function makeMembers(count, roomService = new RoomService()) {
  const first = await roomService.createRoom({ name: 'Voice test', displayName: 'Member 1', maxMembers: 20 })
  const sessions = [first]
  for (let index = 1; index < count; index += 1) {
    sessions.push(await roomService.joinRoom({ code: first.room.code, displayName: `Member ${index + 1}` }))
  }
  return { roomService, sessions }
}

async function setupVoice(sessions, roomService = new RoomService(), options = {}) {
  const io = new TestIo()
  const voice = new VoiceSignaling({ io, roomService, iceServers: [{ urls: ['stun:test.invalid'] }], reconnectGraceMs: 60_000, ...options })
  const sockets = []
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]
    const identity = await roomService.authenticate({ code: session.room.code, memberId: session.member.id, memberToken: session.memberToken })
    const socket = new TestSocket(`socket-${index}`, identity)
    io.add(socket)
    voice.attach(socket)
    sockets.push(socket)
  }
  return { io, voice, sockets, roomService }
}

test('only current authenticated room members can join voice chat', async () => {
  const { roomService, sessions } = await makeMembers(1)
  const setup = await setupVoice(sessions, roomService)
  const join = await emitAck(setup.sockets[0], 'voice:join')
  assert.equal(join.ok, true)
  const departed = sessions[0]
  await roomService.leaveRoom({ code: departed.room.code, memberId: departed.member.id, memberToken: departed.memberToken })
  const signal = await emitAck(setup.sockets[0], 'voice:offer', {
    toMemberId: departed.member.id,
    description: { type: 'offer', sdp: 'v=0' },
  })
  assert.equal(signal.ok, false)
  assert.equal(signal.code, 'ROOM_SESSION_INVALID')
  setup.voice.dispose()

  const otherRoom = await roomService.createRoom({ name: 'Other room', displayName: 'Other' })
  const outsider = new TestSocket('outsider', { code: otherRoom.room.code, memberId: sessions[0].member.id, memberToken: 'not-a-valid-token' })
  setup.io.add(outsider)
  setup.voice.attach(outsider)
  const denied = await emitAck(outsider, 'voice:join')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'ROOM_SESSION_INVALID')
  setup.voice.dispose()
})

test('server enforces six connected voice participants and tracks join and leave state', async () => {
  const { roomService, sessions } = await makeMembers(7)
  const { voice, sockets } = await setupVoice(sessions, roomService)
  const events = []
  sockets[0].on('voice:participants', ({ participants }) => events.push(participants))
  const results = await Promise.all(sockets.map((socket) => emitAck(socket, 'voice:join')))
  assert.equal(results.filter((result) => result.ok).length, 6)
  assert.equal(results.filter((result) => result.code === 'VOICE_ROOM_FULL').length, 1)
  assert.equal(events.at(-1).filter((participant) => participant.state === 'connected').length, 6)
  await emitAck(sockets[2], 'voice:leave')
  assert.equal(events.at(-1).some((participant) => participant.memberId === sessions[2].member.id), false)
  voice.dispose()
})

test('signaling relays only between joined members in the same room and rejects invalid recipients', async () => {
  const roomService = new RoomService()
  const { sessions } = await makeMembers(2, roomService)
  const otherRoom = await roomService.createRoom({ name: 'Separate', displayName: 'Separate' })
  const { voice, sockets, io } = await setupVoice([...sessions, otherRoom], roomService)
  for (const socket of sockets) await emitAck(socket, 'voice:join')
  let received
  sockets[1].on('voice:offer', (payload) => { received = payload })
  const valid = await emitAck(sockets[0], 'voice:offer', {
    toMemberId: sessions[1].member.id,
    description: { type: 'offer', sdp: 'v=0\r\n' },
  })
  assert.equal(valid.ok, true)
  assert.deepEqual(received, { fromMemberId: sessions[0].member.id, description: { type: 'offer', sdp: 'v=0\r\n' } })
  const crossRoom = await emitAck(sockets[0], 'voice:offer', {
    toMemberId: otherRoom.member.id,
    description: { type: 'offer', sdp: 'v=0' },
  })
  assert.equal(crossRoom.ok, false)
  assert.equal(crossRoom.code, 'VOICE_RECIPIENT_INVALID')
  const invalid = await emitAck(sockets[0], 'voice:ice', { toMemberId: 'unregistered-member', candidate: null })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.code, 'VOICE_RECIPIENT_INVALID')
  io.sockets.sockets.delete(sockets[1].id)
  const disconnectedRecipient = await emitAck(sockets[0], 'voice:offer', {
    toMemberId: sessions[1].member.id,
    description: { type: 'offer', sdp: 'v=0' },
  })
  assert.equal(disconnectedRecipient.ok, false)
  assert.equal(disconnectedRecipient.code, 'VOICE_RECIPIENT_INVALID')
  voice.dispose()
})

test('duplicate member joins are prevented, disconnects become reconnecting, and rejoin restores one participant', async () => {
  const roomService = new RoomService()
  const { sessions } = await makeMembers(1, roomService)
  const { voice, sockets, io } = await setupVoice(sessions, roomService)
  const first = sockets[0]
  const duplicateIdentity = await roomService.authenticate({ code: sessions[0].room.code, memberId: sessions[0].member.id, memberToken: sessions[0].memberToken })
  const duplicate = new TestSocket('duplicate-tab', duplicateIdentity)
  io.add(duplicate)
  voice.attach(duplicate)
  assert.equal((await emitAck(first, 'voice:join')).ok, true)
  const denied = await emitAck(duplicate, 'voice:join')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'VOICE_ALREADY_JOINED')
  first.connected = false
  first.emit('disconnect')
  assert.equal(voice.participants(sessions[0].room.code)[0].state, 'reconnecting')
  const unauthorized = await emitAck(first, 'voice:ice', { toMemberId: sessions[0].member.id, candidate: null })
  assert.equal(unauthorized.ok, false)
  assert.equal((await emitAck(duplicate, 'voice:join')).ok, true)
  assert.equal(voice.participants(sessions[0].room.code).length, 1)
  assert.equal(voice.participants(sessions[0].room.code)[0].state, 'connected')
  voice.dispose()
})

test('a stale voice leave cannot remove a newer join from the same socket', async () => {
  const roomService = new RoomService()
  const { sessions } = await makeMembers(1, roomService)
  const { voice, sockets } = await setupVoice(sessions, roomService)
  const socket = sockets[0]
  assert.equal((await emitAck(socket, 'voice:join', { joinToken: 'join-old-token' })).ok, true)
  assert.equal((await emitAck(socket, 'voice:join', { joinToken: 'join-new-token' })).ok, true)
  await emitAck(socket, 'voice:leave', { joinToken: 'join-old-token' })
  assert.equal(voice.participants(sessions[0].room.code).length, 1)
  await emitAck(socket, 'voice:leave', { joinToken: 'join-new-token' })
  assert.deepEqual(voice.participants(sessions[0].room.code), [])
  voice.dispose()
})

test('disconnected voice participants are removed after the reconnect grace period', async () => {
  const roomService = new RoomService()
  const { sessions } = await makeMembers(1, roomService)
  const { voice, sockets } = await setupVoice(sessions, roomService, { reconnectGraceMs: 10 })
  const socket = sockets[0]
  await emitAck(socket, 'voice:join')
  socket.connected = false
  socket.emit('disconnect')
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(voice.participants(sessions[0].room.code), [])
  voice.dispose()
})

test('voice join, signaling, and leave do not mutate queue or playback state', async () => {
  const roomService = new RoomService()
  const { sessions } = await makeMembers(2, roomService)
  const { voice, sockets } = await setupVoice(sessions, roomService)
  const queue = new QueueService({ roomService })
  const identity = { code: sessions[0].room.code, memberId: sessions[0].member.id, memberToken: sessions[0].memberToken }
  const before = await queue.state(identity)
  await emitAck(sockets[0], 'voice:join')
  await emitAck(sockets[1], 'voice:join')
  await emitAck(sockets[0], 'voice:offer', { toMemberId: sessions[1].member.id, description: { type: 'offer', sdp: 'v=0' } })
  await emitAck(sockets[1], 'voice:leave')
  const after = await queue.state(identity)
  assert.deepEqual(after.queue, before.queue)
  assert.equal(after.playback.currentTrackId, before.playback.currentTrackId)
  assert.equal(after.playback.playbackToken, before.playback.playbackToken)
  assert.equal(after.playback.isPlaying, before.playback.isPlaying)
  voice.dispose()
})
