import { randomUUID } from 'node:crypto'
import { RoomError } from './roomService.js'

const MAX_MESSAGE_LENGTH = 500
const MAX_HISTORY = 100

export class RoomChatService {
  constructor({ now = () => new Date() } = {}) {
    this.now = now
    this.messagesByRoom = new Map()
  }

  history(code) {
    return [...(this.messagesByRoom.get(code) ?? [])]
  }

  send(identity, payload) {
    const message = typeof payload?.message === 'string'
      ? payload.message.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
      : ''
    if (!message || message.length > MAX_MESSAGE_LENGTH) {
      throw new RoomError(400, 'Messages must contain 1 to 500 characters.', 'CHAT_MESSAGE_INVALID')
    }

    const messages = this.messagesByRoom.get(identity.code) ?? []
    const entry = {
      id: randomUUID(),
      memberId: identity.memberId,
      displayName: identity.displayName,
      message,
      sentAt: this.now().toISOString(),
    }
    messages.push(entry)
    if (messages.length > MAX_HISTORY) messages.splice(0, messages.length - MAX_HISTORY)
    this.messagesByRoom.set(identity.code, messages)
    return entry
  }

  removeRoom(code) {
    this.messagesByRoom.delete(code)
  }
}
