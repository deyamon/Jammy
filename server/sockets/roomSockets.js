import { RoomError } from '../services/roomService.js'
import { readCookie } from '../routes/auth.js'
import { SESSION_COOKIE } from '../services/authService.js'
import { VoiceSignaling } from './voiceSignaling.js'
import { verifyNeonBearerToken } from '../routes/music.js'

export function initializeRoomSockets(io, roomService, queueService, reconnectGraceMs = 30000, chatService = null, authService = null, voiceOptions = {}) {
  const connectionsByMember = new Map()
  const pendingRemovals = new Map()
  const connectionEpochByMember = new Map()
  const explicitLeaves = new Set()
  const voiceSignaling = new VoiceSignaling({
    io, roomService, iceServers: voiceOptions.iceServers ?? [{ urls: ['stun:stun.l.google.com:19302'] }], reconnectGraceMs,
  })

  const removeAccountIdentity = (tokenHash) => {
    const connected = io.sockets?.sockets
    const sockets = connected instanceof Map ? connected.values() : Array.isArray(io.sockets) ? io.sockets : []
    for (const socket of sockets) {
      if (socket.data.accountSession?.tokenHash === tokenHash) {
        socket.data.accountIdentity = null
        socket.data.accountSession = null
      }
    }
  }
  const unsubscribeSessionRevoker = authService?.addSessionRevoker(removeAccountIdentity)

  async function publishState(code, room) {
    if (room) io.to(code).emit('room:state', room)
    else {
      io.to(code).emit('room:closed', { code })
      await queueService.removeRoom(code)
      chatService?.removeRoom(code)
    }
  }

  function publishSharedState(code, state) {
    io.to(code).emit('queue:state', { queue: state.queue })
    io.to(code).emit('playback:state', state.playback)
  }

  function removeParticipant(memberId) {
    voiceSignaling.removeMember(memberId)
    const pending = pendingRemovals.get(memberId)
    if (pending) clearTimeout(pending.timer)
    pendingRemovals.delete(memberId)
    const sockets = connectionsByMember.get(memberId)
    if (sockets) {
      explicitLeaves.add(memberId)
      for (const socket of sockets) socket.disconnect(true)
    } else {
      connectionEpochByMember.delete(memberId)
    }
  }

  io.use(async (socket, next) => {
    try {
      const { code, memberId, memberToken } = socket.handshake.auth ?? {}
      socket.data.roomIdentity = await roomService.authenticate({ code, memberId, memberToken })
      const neonToken = socket.handshake.auth?.neonAuthToken
      if (typeof neonToken === 'string') {
        try { socket.data.musicUserId = await verifyNeonBearerToken(neonToken) } catch { socket.data.musicUserId = null }
      }
      const accountToken = readCookie(socket.request, SESSION_COOKIE)
      if (accountToken && authService) {
        try {
          const session = await authService.resolveSession(accountToken)
          if (session) {
            socket.data.accountIdentity = session.user
            socket.data.accountSession = { sessionId: session.sessionId, tokenHash: session.tokenHash, expiresAt: session.expiresAt }
          }
        } catch {
          // Account authentication is optional for guest room connections.
        }
      }
      next()
    } catch (error) {
      next(new Error(error instanceof RoomError ? error.code : 'ROOM_SESSION_INVALID'))
    }
  })

  io.on('connection', async (socket) => {
    const identity = socket.data.roomIdentity
    voiceSignaling.attach(socket)
    let sessionCheck = null
    if (socket.data.accountSession && authService) {
      sessionCheck = setInterval(async () => {
        try {
          const current = await authService.validateSessionHash(socket.data.accountSession?.tokenHash)
          if (!current) {
            socket.data.accountIdentity = null
            socket.data.accountSession = null
            clearInterval(sessionCheck)
          }
        } catch {
          socket.data.accountIdentity = null
          socket.data.accountSession = null
          clearInterval(sessionCheck)
        }
      }, 60_000)
      sessionCheck.unref?.()
    }
    const connectionEpoch = (connectionEpochByMember.get(identity.memberId) ?? 0) + 1
    connectionEpochByMember.set(identity.memberId, connectionEpoch)
    const sockets = connectionsByMember.get(identity.memberId) ?? new Set()
    sockets.add(socket)
    connectionsByMember.set(identity.memberId, sockets)

    const pending = pendingRemovals.get(identity.memberId)
    if (pending) clearTimeout(pending.timer)
    pendingRemovals.delete(identity.memberId)

    try {
      await socket.join(identity.code)
      const room = await roomService.setOnline(identity, true)
      if (!room) throw new RoomError(401, 'Your room session is no longer valid. Join the room again.', 'ROOM_SESSION_INVALID')
      const shared = await queueService.state(identity)
      socket.emit('room:state', room)
      socket.emit('queue:state', { queue: shared.queue })
      socket.emit('playback:state', shared.playback)
      socket.emit('chat:history', { messages: chatService?.history(identity.code) ?? [] })
      voiceSignaling.sendSnapshot(socket)
      publishState(identity.code, room)
    } catch (error) {
      console.error('Could not register room socket:', error.message)
      const current = connectionsByMember.get(identity.memberId)
      current?.delete(socket)
      if (!current?.size) connectionsByMember.delete(identity.memberId)
      socket.disconnect(true)
      return
    }

    const handleMutation = (serviceMethod) => async (payload, acknowledge = () => {}) => {
      try {
        const state = await queueService[serviceMethod](identity, payload)
        publishSharedState(identity.code, state)
        acknowledge({ ok: true, state })
      } catch (error) {
        acknowledge({ ok: false, code: error.code ?? 'INTERNAL_ERROR', error: error instanceof RoomError ? error.message : 'The shared room state could not be updated.' })
      }
    }

    socket.on('queue:add', handleMutation('add', 'queue:state'))
    socket.on('queue:remove', handleMutation('remove', 'queue:state'))
    socket.on('queue:reorder', handleMutation('reorder', 'queue:state'))
    socket.on('playback:select', handleMutation('select', 'playback:state'))
    socket.on('playback:update', handleMutation('setPlayback', 'playback:state'))
    const advanceWithTaste = (serviceMethod) => async (payload, acknowledge = () => {}) => {
      try {
        let tasteProfile = null
        const neonToken = socket.handshake.auth?.neonAuthToken
        if (typeof neonToken === 'string' && voiceOptions.authPool) {
          try {
            const userId = await verifyNeonBearerToken(neonToken)
            if (userId === socket.data.musicUserId) {
              const profile = await voiceOptions.authPool.query('SELECT profile_json FROM music_taste_profiles WHERE user_id = $1', [userId])
              tasteProfile = profile.rows[0]?.profile_json ?? null
            }
          } catch { /* Expired or revoked browser JWT falls back to generic Autoplay. */ }
        }
        const state = await queueService[serviceMethod](identity, payload, { tasteProfile })
        publishSharedState(identity.code, state)
        acknowledge({ ok: true, state })
      } catch (error) {
        acknowledge({ ok: false, code: error.code ?? 'INTERNAL_ERROR', error: error instanceof RoomError ? error.message : 'The shared room state could not be updated.' })
      }
    }
    socket.on('playback:next', advanceWithTaste('next'))
    socket.on('playback:skip', advanceWithTaste('skip'))
    socket.on('playback:repeat', handleMutation('setRepeat', 'playback:state'))
    socket.on('playback:autoplay', handleMutation('setAutoplay', 'playback:state'))

    socket.on('chat:send', (payload, acknowledge = () => {}) => {
      try {
        if (!chatService) throw new RoomError(503, 'Room chat is not available.', 'CHAT_UNAVAILABLE')
        const message = chatService.send(identity, payload)
        io.to(identity.code).emit('chat:message', message)
        acknowledge({ ok: true, message })
      } catch (error) {
        acknowledge({ ok: false, code: error.code ?? 'INTERNAL_ERROR', error: error instanceof RoomError ? error.message : 'The message could not be sent.' })
      }
    })

    socket.on('disconnect', async () => {
      if (sessionCheck) clearInterval(sessionCheck)
      const current = connectionsByMember.get(identity.memberId)
      if (!current?.has(socket)) return
      current.delete(socket)
      if (current?.size) return
      connectionsByMember.delete(identity.memberId)
      if (explicitLeaves.delete(identity.memberId)) {
        connectionEpochByMember.delete(identity.memberId)
        return
      }
      const removalEpoch = connectionEpochByMember.get(identity.memberId)

      try {
        const offlineRoom = await roomService.setOnline(identity, false)
        publishState(identity.code, offlineRoom)
      } catch (error) {
        console.error('Could not update room presence:', error.message)
        return
      }
      const removal = { connectionEpoch, timer: null }
      removal.timer = setTimeout(async () => {
        if (pendingRemovals.get(identity.memberId) !== removal
          || connectionEpochByMember.get(identity.memberId) !== removalEpoch
          || connectionsByMember.has(identity.memberId)) return
        pendingRemovals.delete(identity.memberId)
        try {
          const updatedRoom = await roomService.leaveRoomIfOffline(identity)
          publishState(identity.code, updatedRoom)
          if (!updatedRoom?.members.some((member) => member.id === identity.memberId)
            && connectionEpochByMember.get(identity.memberId) === removalEpoch
            && !connectionsByMember.has(identity.memberId)) connectionEpochByMember.delete(identity.memberId)
        } catch (error) {
          console.error('Could not expire disconnected room member:', error.message)
        }
      }, reconnectGraceMs)
      removal.timer.unref?.()
      pendingRemovals.set(identity.memberId, removal)
    })
  })

  return { publishState, removeParticipant, dispose: () => { voiceSignaling.dispose(); unsubscribeSessionRevoker?.() } }
}
