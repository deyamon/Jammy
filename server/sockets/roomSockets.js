import { RoomError } from '../services/roomService.js'

export function initializeRoomSockets(io, roomService, queueService, reconnectGraceMs = 30000, chatService = null) {
  const connectionsByMember = new Map()
  const pendingRemovals = new Map()
  const explicitLeaves = new Set()

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
    const pending = pendingRemovals.get(memberId)
    if (pending) clearTimeout(pending)
    pendingRemovals.delete(memberId)
    const sockets = connectionsByMember.get(memberId)
    if (sockets) {
      explicitLeaves.add(memberId)
      for (const socket of sockets) socket.disconnect(true)
      connectionsByMember.delete(memberId)
    }
  }

  io.use(async (socket, next) => {
    try {
      const { code, memberId, memberToken } = socket.handshake.auth ?? {}
      socket.data.roomIdentity = await roomService.authenticate({ code, memberId, memberToken })
      next()
    } catch (error) {
      next(new Error(error instanceof RoomError ? error.code : 'ROOM_SESSION_INVALID'))
    }
  })

  io.on('connection', async (socket) => {
    const identity = socket.data.roomIdentity
    const sockets = connectionsByMember.get(identity.memberId) ?? new Set()
    sockets.add(socket)
    connectionsByMember.set(identity.memberId, sockets)

    const pending = pendingRemovals.get(identity.memberId)
    if (pending) clearTimeout(pending)
    pendingRemovals.delete(identity.memberId)

    try {
      await socket.join(identity.code)
      const room = await roomService.setOnline(identity, true)
      const shared = await queueService.state(identity)
      socket.emit('room:state', room)
      socket.emit('queue:state', { queue: shared.queue })
      socket.emit('playback:state', shared.playback)
      socket.emit('chat:history', { messages: chatService?.history(identity.code) ?? [] })
      publishState(identity.code, room)
    } catch (error) {
      console.error('Could not register room socket:', error.message)
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
    socket.on('playback:next', handleMutation('next', 'playback:state'))
    socket.on('playback:skip', handleMutation('skip', 'playback:state'))
    socket.on('playback:repeat', handleMutation('setRepeat', 'playback:state'))

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
      const current = connectionsByMember.get(identity.memberId)
      current?.delete(socket)
      if (current?.size) return
      connectionsByMember.delete(identity.memberId)
      if (explicitLeaves.delete(identity.memberId)) return

      try {
        const offlineRoom = await roomService.setOnline(identity, false)
        publishState(identity.code, offlineRoom)
      } catch (error) {
        console.error('Could not update room presence:', error.message)
        return
      }
      const timer = setTimeout(async () => {
        pendingRemovals.delete(identity.memberId)
        try {
          const updatedRoom = await roomService.leaveRoom(identity)
          publishState(identity.code, updatedRoom)
        } catch (error) {
          console.error('Could not expire disconnected room member:', error.message)
        }
      }, reconnectGraceMs)
      timer.unref?.()
      pendingRemovals.set(identity.memberId, timer)
    })
  })

  return { publishState, removeParticipant }
}
