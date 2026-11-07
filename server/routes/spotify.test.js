import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import express from 'express'
import { collectSpotifyPages, createSpotifyRateLimiter, createSpotifyRouter, decryptSpotifyToken, encryptSpotifyToken, normalizePrivatePlaylist, persistSpotifyOAuthTokens, spotifyConfiguration, spotifyRetryAfterSeconds, SPOTIFY_SCOPES } from './spotify.js'
import { hashOAuthState, safeStateMatch } from './music.js'

const key = Buffer.alloc(32, 7)
const environment = {
  SPOTIFY_CLIENT_ID: 'client-id',
  SPOTIFY_CLIENT_SECRET: 'server-secret',
  SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:3001/api/spotify/callback',
  SPOTIFY_TOKEN_ENCRYPTION_KEY: key.toString('base64'),
}

test('Spotify configuration requires server credentials, callback, and a 32-byte encryption key', () => {
  assert.equal(spotifyConfiguration(environment).ready, true)
  assert.equal(spotifyConfiguration({ ...environment, SPOTIFY_REDIRECT_URI: 'http://localhost:3001/api/spotify/callback' }).ready, false)
  assert.equal(spotifyConfiguration({ ...environment, SPOTIFY_CLIENT_SECRET: '' }).ready, false)
  assert.equal(spotifyConfiguration({ ...environment, SPOTIFY_TOKEN_ENCRYPTION_KEY: 'too-short' }).ready, false)
})

test('Spotify Connect returns a clear setup error when server configuration is missing', async (t) => {
  const statements = []
  const app = express()
  app.use('/api/spotify', createSpotifyRouter({
    pool: { async query(sql) { statements.push(sql); return { rows: [] } } },
    authenticator(request, _response, next) { request.musicUserId = 'verified-neon-subject'; next() },
    environment: {},
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/spotify/connect/start`, { method: 'POST' })
  const payload = await response.json()
  assert.equal(response.status, 503)
  assert.equal(payload.code, 'SPOTIFY_NOT_CONFIGURED')
  assert.deepEqual(statements, [])
})

test('Spotify Connect creates a state cookie and returns an authorization redirect URL', async (t) => {
  const statements = []
  const app = express()
  app.use('/api/spotify', createSpotifyRouter({
    pool: { async query(sql, values) { statements.push({ sql, values }); return { rows: [] } } },
    authenticator(request, _response, next) { request.musicUserId = 'verified-neon-subject'; next() },
    environment,
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/spotify/connect/start`, { method: 'POST' })
  const payload = await response.json()
  const authorizationUrl = new URL(payload.authorizationUrl)
  assert.equal(response.status, 200)
  assert.equal(authorizationUrl.origin, 'https://accounts.spotify.com')
  assert.equal(authorizationUrl.pathname, '/authorize')
  assert.equal(authorizationUrl.searchParams.get('client_id'), environment.SPOTIFY_CLIENT_ID)
  assert.ok(authorizationUrl.searchParams.get('state'))
  assert.match(response.headers.get('set-cookie'), /HttpOnly/)
  assert.ok(statements.some(({ sql }) => sql.includes('INSERT INTO spotify_oauth_states')))
})

test('Spotify access and refresh tokens are authenticated-encrypted at rest', () => {
  const ciphertext = encryptSpotifyToken('opaque-provider-token', key)
  assert.equal(ciphertext.includes('opaque-provider-token'), false)
  assert.equal(decryptSpotifyToken(ciphertext, key), 'opaque-provider-token')
  assert.throws(() => decryptSpotifyToken(`${ciphertext.slice(0, -2)}aa`, key))
})

test('Spotify authorization requests are limited to the requested read-only scopes', () => {
  assert.deepEqual(SPOTIFY_SCOPES, ['user-top-read', 'user-read-recently-played', 'user-library-read', 'playlist-read-private'])
  assert.equal(SPOTIFY_SCOPES.some((scope) => /modify|streaming|playback|email/i.test(scope)), false)
})

test('Spotify import labels and retains only private playlist metadata', () => {
  const privatePlaylist = normalizePrivatePlaylist({ id: 'playlist-1', name: 'Private set', public: false, external_urls: { spotify: 'https://open.spotify.com/playlist/playlist-1' } })
  assert.equal(privatePlaylist.name, 'Private set')
  assert.equal(privatePlaylist.spotifyUrl, 'https://open.spotify.com/playlist/playlist-1')
  assert.equal(normalizePrivatePlaylist({ id: 'playlist-2', name: 'Public set', public: true, external_urls: { spotify: 'https://open.spotify.com/playlist/playlist-2' } }), null)
})

test('OAuth callback state is hashed in storage and compared without a length leak', () => {
  const state = 'unguessable-random-state-value'
  assert.equal(hashOAuthState(state).length, 64)
  assert.equal(hashOAuthState(state).includes(state), false)
  assert.equal(safeStateMatch(state, state), true)
  assert.equal(safeStateMatch(state, 'different-state'), false)
  assert.equal(safeStateMatch(state, 'short'), false)
})

test('Spotify import pagination follows trusted pages and caps each category', async () => {
  const calls = []
  const pages = new Map([
    ['/me/top/artists?limit=50', { items: Array.from({ length: 50 }, (_, index) => index), next: 'https://api.spotify.com/v1/me/top/artists?limit=50&offset=50' }],
    ['https://api.spotify.com/v1/me/top/artists?limit=50&offset=50', { items: Array.from({ length: 50 }, (_, index) => index + 50), next: 'https://api.spotify.com/v1/me/top/artists?limit=50&offset=100' }],
  ])
  const result = await collectSpotifyPages(async (path) => { calls.push(path); return pages.get(path) }, '/me/top/artists?limit=50', { maxItems: 75 })
  assert.equal(calls.length, 2)
  assert.equal(result.items.length, 75)
  assert.equal(result.truncated, true)
  await assert.rejects(collectSpotifyPages(async () => ({ items: [], next: 'https://attacker.example/steal' }), '/me/playlists'), /invalid pagination URL/)
})

test('Spotify Retry-After supports seconds, dates, and a bounded fallback', () => {
  assert.equal(spotifyRetryAfterSeconds('12', 0), 12)
  assert.equal(spotifyRetryAfterSeconds(new Date(5000).toUTCString(), 0), 5)
  assert.equal(spotifyRetryAfterSeconds('invalid', 0), 30)
})

test('Spotify connect and sync rate limiter is user-scoped and returns Retry-After', () => {
  let now = 1000
  const limiter = createSpotifyRateLimiter({ limit: 2, windowMs: 60_000, now: () => now })
  const invoke = (userId) => {
    const result = { headers: {}, statusCode: 200, body: null, set(name, value) { this.headers[name] = value; return this }, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } }
    let continued = false
    limiter({ musicUserId: userId }, result, () => { continued = true })
    return { result, continued }
  }
  assert.equal(invoke('user-a').continued, true)
  assert.equal(invoke('user-a').continued, true)
  const limited = invoke('user-a')
  assert.equal(limited.result.statusCode, 429)
  assert.equal(limited.result.headers['Retry-After'], '60')
  assert.equal(invoke('user-b').continued, true)
  now += 60_001
  assert.equal(invoke('user-a').continued, true)
})

function fakeOAuthStatePool(initialState) {
  const store = { state: initialState, connection: null, statements: [] }
  return {
    store,
    async connect() {
      return {
        async query(sql, values = []) {
          store.statements.push(sql)
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
          if (sql.startsWith('DELETE FROM spotify_oauth_states')) {
            if (store.state === values[0]) { store.state = null; return { rows: [{ user_id: 'neon-user-1' }] } }
            return { rows: [] }
          }
          if (sql.includes('INSERT INTO spotify_connections')) { store.connection = values; return { rows: [] } }
          throw new Error('Unexpected OAuth transaction query')
        },
        release() {},
      }
    },
  }
}

test('disconnect winning during Spotify OAuth exchange prevents stale callback reconnection', async () => {
  const pool = fakeOAuthStatePool(null) // Disconnect removed the state after callback preflight, before token persistence.
  const saved = await persistSpotifyOAuthTokens(pool, {
    stateHash: 'state-hash', expectedUserId: 'neon-user-1',
    tokens: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'user-top-read' }, key,
  })
  assert.equal(saved, false)
  assert.equal(pool.store.connection, null)
  assert.ok(pool.store.statements.includes('ROLLBACK'))
})

test('valid Spotify OAuth state is consumed atomically with encrypted token persistence', async () => {
  const pool = fakeOAuthStatePool('state-hash')
  const saved = await persistSpotifyOAuthTokens(pool, {
    stateHash: 'state-hash', expectedUserId: 'neon-user-1',
    tokens: { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'user-top-read' }, key,
  })
  assert.equal(saved, true)
  assert.equal(pool.store.state, null)
  assert.equal(pool.store.connection[0], 'neon-user-1')
  assert.notEqual(pool.store.connection[1], 'access')
  assert.equal(decryptSpotifyToken(pool.store.connection[1], key), 'access')
  assert.ok(pool.store.statements.includes('COMMIT'))
})

test('Spotify sync propagates upstream 429 and Retry-After without retrying requests', async (t) => {
  let requestCount = 0
  const pool = {
    async query() { return { rows: [] } },
    async connect() {
      return {
        async query(sql) {
          if (sql === 'SELECT access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, needs_reauth FROM spotify_connections WHERE user_id = $1 FOR UPDATE') {
            return { rows: [{ access_token_ciphertext: encryptSpotifyToken('current-access', key), refresh_token_ciphertext: encryptSpotifyToken('current-refresh', key), access_token_expires_at: new Date(Date.now() + 3_600_000), needs_reauth: false }] }
          }
          return { rows: [] }
        },
        release() {},
      }
    },
  }
  const app = express()
  app.use('/api/spotify', createSpotifyRouter({
    pool,
    authenticator(request, _response, next) { request.musicUserId = 'neon-user-1'; next() },
    environment,
    fetchImpl: async () => {
      requestCount += 1
      return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '45' }), async json() { return { error: { reason: 'QUOTA_EXCEEDED' } } } }
    },
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/spotify/sync`, { method: 'POST' })
  const payload = await response.json()
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '45')
  assert.equal(payload.quotaLimited, true)
  assert.equal(requestCount, 5)
})

test('Spotify disconnect winning before sync persistence prevents imported rows from being recreated', async (t) => {
  let connectionReads = 0
  const writes = []
  const pool = {
    async query() { return { rows: [] } },
    async connect() {
      connectionReads += 1
      return {
        async query(sql, values = []) {
          if (sql === 'SELECT access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, needs_reauth FROM spotify_connections WHERE user_id = $1 FOR UPDATE') {
            return { rows: [{ access_token_ciphertext: encryptSpotifyToken('current-access', key), refresh_token_ciphertext: encryptSpotifyToken('current-refresh', key), access_token_expires_at: new Date(Date.now() + 3_600_000), needs_reauth: false }] }
          }
          if (sql === 'SELECT user_id FROM spotify_connections WHERE user_id = $1 FOR UPDATE') return { rows: [] }
          if (/INSERT INTO spotify_imported_items|DELETE FROM spotify_imported_items/.test(sql)) writes.push({ sql, values })
          return { rows: [] }
        },
        release() {},
      }
    },
  }
  const app = express()
  app.use('/api/spotify', createSpotifyRouter({
    pool,
    authenticator(request, _response, next) { request.musicUserId = 'neon-user-1'; next() },
    environment,
    fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), async json() { return { items: [], next: null } } }),
  }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/spotify/sync`, { method: 'POST' })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'SPOTIFY_REAUTH_REQUIRED')
  assert.equal(connectionReads, 2)
  assert.deepEqual(writes, [])
})

test('Spotify disconnect transaction cancels pending OAuth state before deleting user-scoped data', async (t) => {
  const statements = []
  const pool = {
    async query() { return { rows: [] } },
    async connect() {
      return {
        async query(sql, values = []) {
          statements.push({ sql, values })
          if (sql.includes('SELECT video_id, title, channel_name, played_at')) return { rows: [] }
          return { rows: [] }
        },
        release() {},
      }
    },
  }
  const app = express()
  app.use('/api/spotify', createSpotifyRouter({ pool, authenticator(request, _response, next) { request.musicUserId = 'verified-neon-subject'; next() } }))
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/spotify/connection`, { method: 'DELETE' })
  assert.equal(response.status, 200)
  const stateDelete = statements.find(({ sql }) => sql.includes('DELETE FROM spotify_oauth_states'))
  assert.deepEqual(stateDelete.values, ['verified-neon-subject'])
  assert.ok(statements.indexOf(stateDelete) < statements.findIndex(({ sql }) => sql.includes('DELETE FROM spotify_connections')))
  assert.ok(statements.some(({ sql }) => sql.includes('DELETE FROM spotify_imported_items')))
})
