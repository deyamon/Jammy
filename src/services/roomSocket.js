import { io } from 'socket.io-client'
import { getNeonAuthBearerToken } from './authApi.js'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

export function connectToRoom(session) {
  return io(API_BASE, {
    auth: async (callback) => {
      let neonAuthToken = ''
      try { neonAuthToken = await getNeonAuthBearerToken() } catch { /* Room membership remains independent of account music preferences. */ }
      callback({
      code: session.room.code,
      memberId: session.member.id,
      memberToken: session.memberToken,
      ...(neonAuthToken ? { neonAuthToken } : {}),
      })
    },
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  })
}
