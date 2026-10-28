import assert from 'node:assert/strict'
import { io } from 'socket.io-client'

const apiBase = process.env.VITE_API_URL || 'http://localhost:3001'
const sockets = []

async function request(path, options) {
  return fetch(`${apiBase}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  })
}

function waitForSocketEvent(socket, eventName, predicate = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(eventName, handler); reject(new Error(`Timed out waiting for ${eventName}.`)) }, timeoutMs)
    const handler = (payload) => {
      if (!predicate(payload)) return
      clearTimeout(timer)
      socket.off(eventName, handler)
      resolve(payload)
    }
    socket.on(eventName, handler)
  })
}

function emitAck(socket, eventName, payload) {
  return new Promise((resolve) => socket.emit(eventName, payload, resolve))
}

async function connect(session, roomStatePredicate) {
  const socket = io(apiBase, {
    auth: { code: session.room.code, memberId: session.member.id, memberToken: session.memberToken },
    autoConnect: false,
    reconnection: false,
    timeout: 5000,
  })
  sockets.push(socket)
  const initialState = waitForSocketEvent(socket, 'room:state', roomStatePredicate)
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  })
  socket.connect()
  await connected
  await initialState
  return socket
}

async function reconnect(socket, roomStatePredicate) {
  const statePromise = waitForSocketEvent(socket, 'room:state', roomStatePredicate)
  const connected = new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('connect_error', reject)
  })
  socket.connect()
  await connected
  return statePromise
}

async function main() {
  const healthResponse = await request('/api/health')
  assert.equal(healthResponse.status, 200, 'health endpoint should return 200')
  const health = await healthResponse.json()
  assert.equal(health.status, 'ok')
  console.log(`✓ health endpoint (${health.roomStore} room store)`)

  const invalidCode = await request('/api/rooms/!!!/join', {
    method: 'POST', body: JSON.stringify({ displayName: 'Guest' }),
  })
  assert.equal(invalidCode.status, 400, 'malformed room code should be rejected')
  console.log('✓ malformed room code rejected')

  const createResponse = await request('/api/rooms', {
    method: 'POST', body: JSON.stringify({ name: 'Smoke test room', displayName: 'Host', maxMembers: 2 }),
  })
  assert.equal(createResponse.status, 201)
  const hostSession = await createResponse.json()
  const hostSocket = await connect(hostSession, (state) => state.members.some((member) => member.id === hostSession.member.id && member.online))
  console.log(`✓ room created (${hostSession.room.code}) and host connected`)

  const unauthorizedSocket = io(apiBase, {
    auth: { code: hostSession.room.code, memberId: 'not-a-room-member', memberToken: hostSession.memberToken },
    autoConnect: false, reconnection: false, timeout: 5000,
  })
  const unauthorizedConnection = new Promise((resolve) => unauthorizedSocket.once('connect_error', resolve))
  unauthorizedSocket.connect()
  const unauthorizedError = await unauthorizedConnection
  assert.equal(unauthorizedError.message, 'ROOM_SESSION_INVALID', 'unknown socket member should be rejected')
  unauthorizedSocket.disconnect()
  console.log('✓ Socket.IO rejected a client without valid room membership')

  const notFoundResponse = await request('/api/rooms/ZZZZZ9/join', {
    method: 'POST', body: JSON.stringify({ displayName: 'Guest' }),
  })
  assert.equal(notFoundResponse.status, 404, 'unknown room code should be rejected')
  console.log('✓ unknown room code rejected')

  const hostSeesGuest = waitForSocketEvent(hostSocket, 'room:state', (state) => state.members.length === 2)
  const joinResponse = await request(`/api/rooms/${hostSession.room.code}/join`, {
    method: 'POST', body: JSON.stringify({ displayName: 'Guest' }),
  })
  assert.equal(joinResponse.status, 201)
  const guestSession = await joinResponse.json()
  await hostSeesGuest
  const hostSeesGuestOnline = waitForSocketEvent(hostSocket, 'room:state', (state) => state.members.some((member) => member.id === guestSession.member.id && member.online))
  const guestSocket = await connect(guestSession, (state) => state.members.length === 2 && state.members.every((member) => member.online))
  await hostSeesGuestOnline
  console.log('✓ second independent socket joined; live participant updates reached both clients')

  const hostReceivesChat = waitForSocketEvent(hostSocket, 'chat:message', (message) => message.message === 'Room hello')
  const guestReceivesChat = waitForSocketEvent(guestSocket, 'chat:message', (message) => message.message === 'Room hello')
  const chatAck = await emitAck(hostSocket, 'chat:send', { message: 'Room hello' })
  assert.equal(chatAck.ok, true, 'authenticated room member should send a message')
  const [hostMessage, guestMessage] = await Promise.all([hostReceivesChat, guestReceivesChat])
  assert.equal(hostMessage.id, chatAck.message.id)
  assert.equal(guestMessage.id, chatAck.message.id)
  const invalidChat = await emitAck(hostSocket, 'chat:send', { message: '   ' })
  assert.equal(invalidChat.ok, false, 'empty messages should be rejected')
  assert.equal(invalidChat.code, 'CHAT_MESSAGE_INVALID')

  const isolatedRoomResponse = await request('/api/rooms', {
    method: 'POST', body: JSON.stringify({ name: 'Isolated chat test', displayName: 'Other Host' }),
  })
  const isolatedSession = await isolatedRoomResponse.json()
  const isolatedSocket = await connect(isolatedSession, (state) => state.members.some((member) => member.online))
  let messageLeaked = false
  const detectLeak = () => { messageLeaked = true }
  guestSocket.on('chat:message', detectLeak)
  const isolatedMessage = waitForSocketEvent(isolatedSocket, 'chat:message', (message) => message.message === 'Private room')
  const isolatedAck = await emitAck(isolatedSocket, 'chat:send', { message: 'Private room' })
  assert.equal(isolatedAck.ok, true)
  await isolatedMessage
  await new Promise((resolve) => setTimeout(resolve, 50))
  guestSocket.off('chat:message', detectLeak)
  assert.equal(messageLeaked, false, 'room messages must not cross room boundaries')
  console.log('✓ authenticated room chat delivery, validation, and room isolation')

  const hostSeesGuestOffline = waitForSocketEvent(hostSocket, 'room:state', (state) => state.members.some((member) => member.id === guestSession.member.id && !member.online))
  guestSocket.disconnect()
  await hostSeesGuestOffline
  const hostSeesGuestReconnect = waitForSocketEvent(hostSocket, 'room:state', (state) => state.members.some((member) => member.id === guestSession.member.id && member.online))
  const guestSeesReconnect = reconnect(guestSocket, (state) => state.members.some((member) => member.id === guestSession.member.id && member.online))
  await Promise.all([hostSeesGuestReconnect, guestSeesReconnect])
  console.log('✓ disconnected guest went offline and reconnected within the grace period')

  const fullRoomResponse = await request(`/api/rooms/${hostSession.room.code}/join`, {
    method: 'POST', body: JSON.stringify({ displayName: 'Third guest' }),
  })
  assert.equal(fullRoomResponse.status, 409, 'full room should reject another participant')
  console.log('✓ full room rejected another participant')

  const hostSeesGuestLeave = waitForSocketEvent(hostSocket, 'room:state', (state) => state.members.length === 1)
  const leaveGuestResponse = await request(`/api/rooms/${guestSession.room.code}/leave`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${guestSession.memberToken}`, 'X-Room-Member-Id': guestSession.member.id },
  })
  assert.equal(leaveGuestResponse.status, 200)
  await hostSeesGuestLeave
  console.log('✓ guest left; host received the updated participant list')

  const leaveHostResponse = await request(`/api/rooms/${hostSession.room.code}/leave`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${hostSession.memberToken}`, 'X-Room-Member-Id': hostSession.member.id },
  })
  assert.equal(leaveHostResponse.status, 200)
  console.log('✓ final participant left and empty room was closed')
}

try {
  await main()
  console.log('Room smoke checks passed.')
} catch (error) {
  console.error('Room smoke checks failed:', error)
  process.exitCode = 1
} finally {
  for (const socket of sockets) socket.disconnect()
}
