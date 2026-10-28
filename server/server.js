import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { clearGuestMemberships, createPool, initializeSchema } from './db.js'
import { createRoomsRouter } from './routes/rooms.js'
import { initializeRoomSockets } from './sockets/roomSockets.js'
import { RoomError, RoomService } from './services/roomService.js'
import { QueueService } from './services/queueService.js'
import { YouTubeService } from './services/youtubeService.js'
import { RoomChatService } from './services/roomChatService.js'
import { createYouTubeRouter } from './routes/youtube.js'
import { createSpotifyRouter } from './routes/spotify.js'
import { isYouTubeApiKeyConfigured, loadProjectEnvironment } from './config.js'
import { SpotifyService } from './services/spotifyService.js'

loadProjectEnvironment(import.meta.url)

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const roomStore = (process.env.ROOM_STORE ?? 'memory').toLowerCase()
const allowedOrigins = (process.env.CLIENT_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean)
const reconnectGraceMs = Math.min(Math.max(Number.parseInt(process.env.RECONNECT_GRACE_MS ?? '30000', 10), 1000), 120000)

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.')
if (!['memory', 'postgres'].includes(roomStore)) throw new Error('ROOM_STORE must be either memory or postgres.')

const pool = roomStore === 'postgres' ? createPool(process.env.DATABASE_URL) : null
if (pool) {
  pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error.message))
  await initializeSchema(pool)
  await clearGuestMemberships(pool)
}

const roomService = new RoomService({ mode: roomStore, pool })
const chatService = new RoomChatService()
const youtubeService = new YouTubeService()
const spotifyService = new SpotifyService()
console.log(`YouTube Data API key configured: ${isYouTubeApiKeyConfigured() ? 'yes' : 'no'}`)
console.log(`Spotify search credentials configured: ${process.env.SPOTIFY_CLIENT_ID?.trim() && process.env.SPOTIFY_CLIENT_SECRET?.trim() ? 'yes' : 'no'}`)
const queueService = new QueueService({ roomService, youtubeService, mode: roomStore, pool })
await queueService.purgeExpiredYouTubeData()
const youtubeDataCleanup = setInterval(() => {
  queueService.purgeExpiredYouTubeData().catch((error) => console.error('Could not expire YouTube room data:', error.message))
}, 60 * 60 * 1000)
youtubeDataCleanup.unref?.()
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST', 'DELETE'] },
  pingTimeout: 20000,
  pingInterval: 25000,
})
const roomSockets = initializeRoomSockets(io, roomService, queueService, reconnectGraceMs, chatService)

app.disable('x-powered-by')
app.use(cors({ origin: allowedOrigins }))
app.use(express.json({ limit: '16kb' }))

app.get('/api/health', async (_request, response, next) => {
  try {
    if (pool) await pool.query('SELECT 1')
    response.json({ status: 'ok', roomStore, database: pool ? 'connected' : 'not-configured' })
  } catch (error) {
    next(error)
  }
})

app.use('/api/rooms', createRoomsRouter({ roomService, roomSockets }))
app.use('/api/youtube', createYouTubeRouter({ youtubeService }))
app.use('/api/spotify', createSpotifyRouter({ spotifyService }))
app.use((request, response) => response.status(404).json({ error: 'Endpoint not found.', code: 'ENDPOINT_NOT_FOUND' }))
app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return response.status(400).json({ error: 'Request body must contain valid JSON.', code: 'JSON_INVALID' })
  }
  const status = error instanceof RoomError ? error.status : 500
  const responseStatus = Number.isInteger(error.status) ? error.status : status
  if (responseStatus >= 500) console.error('Request failed:', error)
  return response.status(responseStatus).json({
    error: error.status ? error.message : status >= 500 ? 'Something went wrong. Please try again.' : error.message,
    code: error.code ?? 'INTERNAL_ERROR',
  })
})

httpServer.listen(port, () => {
  const modeNote = roomStore === 'memory' ? ' (temporary in-memory rooms; data clears on restart)' : ' (PostgreSQL)'
  console.log(`Jammy API listening on http://localhost:${port}${modeNote}`)
  console.log(`Allowed frontend origins: ${allowedOrigins.join(', ')}`)
})

function shutdown() {
  clearInterval(youtubeDataCleanup)
  io.close(async () => {
    if (pool) await pool.end()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
