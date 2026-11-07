import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { clearGuestMemberships, createOptionalAuthPool, createPool, inspectAccountDatabaseStatus } from './db.js'
import { createRoomsRouter } from './routes/rooms.js'
import { initializeRoomSockets } from './sockets/roomSockets.js'
import { RoomError, RoomService } from './services/roomService.js'
import { QueueService } from './services/queueService.js'
import { YouTubeService } from './services/youtubeService.js'
import { RoomChatService } from './services/roomChatService.js'
import { createYouTubeRouter } from './routes/youtube.js'
import { createAuthRouter } from './routes/auth.js'
import { createMusicRouter } from './routes/music.js'
import { createSpotifyRouter } from './routes/spotify.js'
import { AuthService } from './services/authService.js'
import { isYouTubeApiKeyConfigured, loadProjectEnvironment } from './config.js'
import { createVoiceIceServerProvider } from './voiceConfig.js'

loadProjectEnvironment(import.meta.url)

const port = Number.parseInt(process.env.PORT ?? '3001', 10)
const roomStore = (process.env.ROOM_STORE ?? 'memory').toLowerCase()
const allowedOrigins = (process.env.CLIENT_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean)
const reconnectGraceMs = Math.min(Math.max(Number.parseInt(process.env.RECONNECT_GRACE_MS ?? '30000', 10), 1000), 120000)
const voiceIceServers = createVoiceIceServerProvider()

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.')
if (!['memory', 'postgres'].includes(roomStore)) throw new Error('ROOM_STORE must be either memory or postgres.')

const roomPool = roomStore === 'postgres' ? createPool(process.env.DATABASE_URL) : null
const optionalAuthPool = createOptionalAuthPool(roomPool, process.env.DATABASE_URL)
const authPool = optionalAuthPool.pool
for (const activePool of new Set([roomPool, authPool].filter(Boolean))) {
  activePool.on('error', () => console.error('Unexpected PostgreSQL pool error.'))
}
const accountDatabaseStartupStatus = authPool
  ? await inspectAccountDatabaseStatus(authPool)
  : optionalAuthPool.configurationError
    ? { connection: 'invalid-configuration', authenticationMigration: 'unknown', personalMusicSchema: 'unknown', roomSchema: 'unknown', autoplaySchema: 'unknown', pendingMigrations: [], hint: optionalAuthPool.configurationError }
    : await inspectAccountDatabaseStatus(null)
if (roomPool && accountDatabaseStartupStatus.roomSchema === 'ready') {
  await clearGuestMemberships(roomPool)
}

const authService = new AuthService(authPool, optionalAuthPool.configurationError ? {
  unavailableMessage: 'Account authentication is unavailable because PostgreSQL configuration is invalid. Check the server startup status.',
} : {})
const roomService = new RoomService({ mode: roomStore, pool: roomPool })
const chatService = new RoomChatService()
const youtubeService = new YouTubeService()
console.log(`YouTube Data API key configured: ${isYouTubeApiKeyConfigured() ? 'yes' : 'no'}`)
const queueService = new QueueService({ roomService, youtubeService, mode: roomStore, pool: roomPool })
if (roomStore === 'memory' || accountDatabaseStartupStatus.roomSchema === 'ready') {
  await queueService.purgeExpiredYouTubeData()
}
const youtubeDataCleanup = roomStore === 'memory' || accountDatabaseStartupStatus.roomSchema === 'ready'
  ? setInterval(() => {
    queueService.purgeExpiredYouTubeData().catch(() => console.error('Could not expire YouTube room data.'))
  }, 60 * 60 * 1000)
  : null
youtubeDataCleanup?.unref?.()
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST', 'DELETE'], credentials: true },
  pingTimeout: 20000,
  pingInterval: 25000,
})
const roomSockets = initializeRoomSockets(io, roomService, queueService, reconnectGraceMs, chatService, authService, { iceServers: voiceIceServers, authPool })

app.disable('x-powered-by')
app.use(cors({ origin: allowedOrigins, credentials: true, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Room-Member-Id', 'X-CSRF-Token'] }))
app.use(express.json({ limit: '16kb' }))

app.get('/api/health', async (_request, response, next) => {
  try {
    if (roomPool) await roomPool.query('SELECT 1')
    const accountDatabaseStatus = authPool
      ? await inspectAccountDatabaseStatus(authPool)
      : accountDatabaseStartupStatus
    response.json({
      status: 'ok',
      roomStore,
      database: roomPool ? 'connected' : 'not-configured',
      accountDatabase: accountDatabaseStatus.connection,
      accountAuthenticationMigration: accountDatabaseStatus.authenticationMigration,
      personalMusicSchema: accountDatabaseStatus.personalMusicSchema,
      roomSchema: accountDatabaseStatus.roomSchema,
      autoplaySchema: accountDatabaseStatus.autoplaySchema,
      pendingMigrations: accountDatabaseStatus.pendingMigrations,
      ...(accountDatabaseStatus.hint ? { accountDatabaseHint: accountDatabaseStatus.hint } : {}),
    })
  } catch (error) {
    next(error)
  }
})

app.use('/api/rooms', createRoomsRouter({ roomService, roomSockets }))
app.use('/api/youtube', createYouTubeRouter({ youtubeService }))
app.use('/api/auth', createAuthRouter({ authService, allowedOrigins }))
app.use('/api/music', createMusicRouter({ pool: authPool, youtubeService }))
app.use('/api/spotify', createSpotifyRouter({ pool: authPool, clientOrigins: allowedOrigins }))
app.use((request, response) => response.status(404).json({ error: 'Endpoint not found.', code: 'ENDPOINT_NOT_FOUND' }))
app.use((error, _request, response, _next) => {
  if (error instanceof SyntaxError && 'body' in error) {
    return response.status(400).json({ error: 'Request body must contain valid JSON.', code: 'JSON_INVALID' })
  }
  const status = error instanceof RoomError ? error.status : 500
  const responseStatus = Number.isInteger(error.status) ? error.status : status
  if (responseStatus >= 500) {
    const safeCode = typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'INTERNAL_ERROR'
    console.error('Request failed.', { code: safeCode })
  }
  return response.status(responseStatus).json({
    error: error.status ? error.message : status >= 500 ? 'Something went wrong. Please try again.' : error.message,
    code: error.code ?? 'INTERNAL_ERROR',
  })
})

httpServer.listen(port, () => {
  const modeNote = roomStore === 'memory' ? ' (temporary in-memory rooms; data clears on restart)' : ' (PostgreSQL)'
  console.log(`Jammy API listening on http://localhost:${port}${modeNote}`)
  console.log(`Account PostgreSQL: ${accountDatabaseStartupStatus.connection}; authentication migration: ${accountDatabaseStartupStatus.authenticationMigration}; personal music schema: ${accountDatabaseStartupStatus.personalMusicSchema}`)
  if (accountDatabaseStartupStatus.pendingMigrations?.length) console.log(`Pending database migrations: ${accountDatabaseStartupStatus.pendingMigrations.join(', ')}`)
  if (accountDatabaseStartupStatus.hint) console.log(`Account database setup: ${accountDatabaseStartupStatus.hint}`)
  console.log(`Allowed frontend origins: ${allowedOrigins.join(', ')}`)
})

function shutdown() {
  if (youtubeDataCleanup) clearInterval(youtubeDataCleanup)
  io.close(async () => {
    roomSockets.dispose()
    for (const activePool of new Set([roomPool, authPool].filter(Boolean))) await activePool.end()
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
