import { io } from 'socket.io-client'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export function connectToRoom(session) {
  return io(API_BASE, {
    auth: {
      code: session.room.code,
      memberId: session.member.id,
      memberToken: session.memberToken,
    },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  })
}
