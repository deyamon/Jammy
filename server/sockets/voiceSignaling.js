import { randomUUID } from 'node:crypto'
import { RoomError } from '../services/roomService.js'

const MAX_VOICE_PARTICIPANTS = 6
const MAX_SDP_LENGTH = 200_000

function acknowledgement(callback, value) {
  if (typeof callback === 'function') callback(value)
}

function roomError(code, message) {
  return new RoomError(400, message, code)
}

function cleanDescription(value, type) {
  if (!value || typeof value !== 'object' || value.type !== type || typeof value.sdp !== 'string' || value.sdp.length > MAX_SDP_LENGTH) {
    throw roomError('VOICE_SIGNAL_INVALID', 'The voice connection message is not valid.')
  }
  return { type, sdp: value.sdp }
}

function cleanCandidate(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || typeof value.candidate !== 'string' || value.candidate.length > 4096
    || (value.sdpMid !== null && value.sdpMid !== undefined && (typeof value.sdpMid !== 'string' || value.sdpMid.length > 256))
    || (value.sdpMLineIndex !== null && value.sdpMLineIndex !== undefined && (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0))) {
    throw roomError('VOICE_SIGNAL_INVALID', 'The voice connection message is not valid.')
  }
  return {
    candidate: value.candidate,
    sdpMid: value.sdpMid ?? null,
    sdpMLineIndex: value.sdpMLineIndex ?? null,
    usernameFragment: typeof value.usernameFragment === 'string' ? value.usernameFragment.slice(0, 256) : undefined,
  }
}

export class VoiceSignaling {
  constructor({ io, roomService, iceServers, reconnectGraceMs = 30_000 } = {}) {
    this.io = io
    this.roomService = roomService
    this.iceServers = iceServers
    this.reconnectGraceMs = reconnectGraceMs
    this.rooms = new Map()
    this.operationsBySocket = new WeakMap()
  }

  room(code) {
    if (!this.rooms.has(code)) this.rooms.set(code, new Map())
    return this.rooms.get(code)
  }

  participants(code) {
    return [...(this.rooms.get(code)?.values() ?? [])]
      .map(({ memberId, displayName, state }) => ({ memberId, displayName, state }))
  }

  publish(code) {
    this.io.to(code).emit('voice:participants', { participants: this.participants(code) })
  }

  sendSnapshot(socket) {
    const identity = socket.data.roomIdentity
    if (identity) socket.emit('voice:participants', { participants: this.participants(identity.code) })
  }

  attach(socket) {
    socket.on('disconnect', () => this.disconnect(socket))
    socket.on('voice:join', (payload, acknowledge) => { void this.enqueue(socket, () => this.join(socket, payload, acknowledge)) })
    socket.on('voice:leave', (payload, acknowledge) => { void this.enqueue(socket, () => this.leave(socket, payload, acknowledge)) })
    socket.on('voice:offer', (payload, acknowledge) => { void this.enqueue(socket, () => this.relay(socket, 'voice:offer', payload, acknowledge)) })
    socket.on('voice:answer', (payload, acknowledge) => { void this.enqueue(socket, () => this.relay(socket, 'voice:answer', payload, acknowledge)) })
    socket.on('voice:ice', (payload, acknowledge) => { void this.enqueue(socket, () => this.relay(socket, 'voice:ice', payload, acknowledge)) })
  }

  enqueue(socket, operation) {
    const previous = this.operationsBySocket.get(socket) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(operation)
    this.operationsBySocket.set(socket, pending)
    void pending.finally(() => {
      if (this.operationsBySocket.get(socket) === pending) this.operationsBySocket.delete(socket)
    }).catch(() => {})
    return pending
  }

  async currentParticipant(socket) {
    const identity = socket.data.roomIdentity
    if (!identity || socket.connected === false) throw new RoomError(401, 'Your room session is no longer valid.', 'ROOM_SESSION_INVALID')
    await this.roomService.authenticate(identity)
    const participant = this.rooms.get(identity.code)?.get(identity.memberId)
    if (!participant || participant.socketId !== socket.id || participant.state !== 'connected') {
      throw new RoomError(403, 'Join voice chat before sending connection messages.', 'VOICE_NOT_JOINED')
    }
    return { identity, participant }
  }

  async join(socket, payload, acknowledge) {
    try {
      const identity = socket.data.roomIdentity
      if (!identity || socket.connected === false) throw new RoomError(401, 'Your room session is no longer valid.', 'ROOM_SESSION_INVALID')
      await this.roomService.authenticate(identity)
      if (socket.connected === false) throw new RoomError(401, 'Your room session is no longer valid.', 'ROOM_SESSION_INVALID')
      const member = await this.roomService.authenticate(identity)
      if (socket.connected === false) throw new RoomError(401, 'Your room session is no longer valid.', 'ROOM_SESSION_INVALID')
      const participants = this.room(identity.code)
      let participant = participants.get(identity.memberId)
      const connectedCount = [...participants.values()].filter((entry) => entry.state === 'connected').length
      if (participant?.state === 'connected' && participant.socketId !== socket.id) {
        throw roomError('VOICE_ALREADY_JOINED', 'This room member already has a voice connection.')
      }
      if (participant?.state !== 'connected' && connectedCount >= MAX_VOICE_PARTICIPANTS) {
        throw new RoomError(409, 'Voice chat supports up to six connected participants.', 'VOICE_ROOM_FULL')
      }
      if (participant?.reconnectTimer) clearTimeout(participant.reconnectTimer)
      participant = {
        memberId: identity.memberId,
        displayName: member.displayName,
        socketId: socket.id,
        joinToken: typeof payload?.joinToken === 'string' && payload.joinToken.length <= 128 ? payload.joinToken : randomUUID(),
        state: 'connected',
        reconnectTimer: null,
      }
      participants.set(identity.memberId, participant)
      acknowledgement(acknowledge, {
        ok: true,
        memberId: identity.memberId,
        participants: this.participants(identity.code),
        iceServers: typeof this.iceServers === 'function' ? await this.iceServers() : this.iceServers,
      })
      this.publish(identity.code)
    } catch (error) {
      acknowledgement(acknowledge, {
        ok: false,
        code: error.code ?? 'VOICE_JOIN_FAILED',
        error: error instanceof RoomError ? error.message : 'Voice chat could not be joined.',
      })
    }
  }

  async leave(socket, payload, acknowledge) {
    const identity = socket.data.roomIdentity
    const participants = identity && this.rooms.get(identity.code)
    const participant = participants?.get(identity.memberId)
    if (participant?.socketId === socket.id && (!payload?.joinToken || participant.joinToken === payload.joinToken)) this.remove(identity.code, identity.memberId)
    acknowledgement(acknowledge, { ok: true })
  }

  async relay(socket, event, payload, acknowledge) {
    try {
      const { identity } = await this.currentParticipant(socket)
      const toMemberId = payload?.toMemberId
      if (typeof toMemberId !== 'string' || toMemberId === identity.memberId) {
        throw roomError('VOICE_RECIPIENT_INVALID', 'That voice participant is not available.')
      }
      const recipient = this.rooms.get(identity.code)?.get(toMemberId)
      if (!recipient || recipient.state !== 'connected' || !recipient.socketId) {
        throw roomError('VOICE_RECIPIENT_INVALID', 'That voice participant is not available.')
      }
      const sockets = this.io.sockets?.sockets
      const target = sockets instanceof Map ? sockets.get(recipient.socketId)
        : Array.isArray(sockets) ? sockets.find((entry) => entry.id === recipient.socketId) : null
      if (!target || target.connected === false || target.data.roomIdentity?.code !== identity.code
        || target.data.roomIdentity?.memberId !== toMemberId) {
        throw roomError('VOICE_RECIPIENT_INVALID', 'That voice participant is not available.')
      }
      await this.roomService.authenticate(target.data.roomIdentity)
      await this.roomService.authenticate(identity)
      const currentSender = this.rooms.get(identity.code)?.get(identity.memberId)
      const currentRecipient = this.rooms.get(identity.code)?.get(toMemberId)
      if (currentSender?.socketId !== socket.id || currentSender.state !== 'connected'
        || currentRecipient !== recipient || currentRecipient?.socketId !== target.id || currentRecipient.state !== 'connected') {
        throw roomError('VOICE_RECIPIENT_INVALID', 'That voice participant is not available.')
      }
      let signal
      if (event === 'voice:offer') signal = cleanDescription(payload.description, 'offer')
      else if (event === 'voice:answer') signal = cleanDescription(payload.description, 'answer')
      else signal = cleanCandidate(payload.candidate)
      target.emit(event, { fromMemberId: identity.memberId, ...(event === 'voice:ice' ? { candidate: signal } : { description: signal }) })
      acknowledgement(acknowledge, { ok: true })
    } catch (error) {
      acknowledgement(acknowledge, {
        ok: false,
        code: error.code ?? 'VOICE_SIGNAL_REJECTED',
        error: error instanceof RoomError ? error.message : 'The voice connection could not be relayed.',
      })
    }
  }

  remove(code, memberId) {
    const participants = this.rooms.get(code)
    const participant = participants?.get(memberId)
    if (!participant) return
    if (participant.reconnectTimer) clearTimeout(participant.reconnectTimer)
    participants.delete(memberId)
    if (!participants.size) this.rooms.delete(code)
    this.publish(code)
  }

  disconnect(socket) {
    const identity = socket.data.roomIdentity
    const participant = identity && this.rooms.get(identity.code)?.get(identity.memberId)
    if (!participant || participant.socketId !== socket.id) return
    participant.socketId = null
    participant.state = 'reconnecting'
    this.publish(identity.code)
    participant.reconnectTimer = setTimeout(() => {
      if (this.rooms.get(identity.code)?.get(identity.memberId) !== participant || participant.socketId) return
      this.remove(identity.code, identity.memberId)
    }, this.reconnectGraceMs)
    participant.reconnectTimer.unref?.()
  }

  // Drop every in-memory voice participant for a room that has closed.
  removeRoom(code) {
    const participants = this.rooms.get(code)
    if (!participants) return
    for (const participant of participants.values()) if (participant.reconnectTimer) clearTimeout(participant.reconnectTimer)
    this.rooms.delete(code)
  }

  removeMember(memberId) {
    for (const [code, participants] of this.rooms) {
      if (participants.has(memberId)) this.remove(code, memberId)
    }
  }

  dispose() {
    for (const participants of this.rooms.values()) {
      for (const participant of participants.values()) if (participant.reconnectTimer) clearTimeout(participant.reconnectTimer)
    }
    this.rooms.clear()
  }
}

export { MAX_VOICE_PARTICIPANTS }
