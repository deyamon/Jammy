import { Router } from 'express'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { hashOAuthState, safeStateMatch, createNeonUserAuthenticator } from './music.js'
import { buildMusicTasteProfile } from '../services/musicTaste.js'

const OAUTH_STATE_COOKIE = 'jammy_spotify_oauth_state'
const SPOTIFY_SCOPES = ['user-top-read', 'user-read-recently-played', 'user-library-read', 'playlist-read-private']
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token'
const API_BASE = 'https://api.spotify.com/v1'
const refreshes = new Map()
const IMPORT_PAGE_SIZE = 50
const MAX_IMPORT_ITEMS_PER_KIND = 150

export function createSpotifyRateLimiter({ limit, windowMs, maxKeys = 10000, now = Date.now } = {}) {
  const attempts = new Map()
  return (request, response, next) => {
    const key = String(request.musicUserId || request.ip || 'unknown')
    const time = now()
    const bucket = (attempts.get(key) || []).filter((timestamp) => timestamp > time - windowMs)
    if (bucket.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (time - bucket[0])) / 1000))
      response.set('Retry-After', String(retryAfter))
      return response.status(429).json({ error: 'Spotify requests are temporarily limited. Please try again later.', code: 'SPOTIFY_RATE_LIMITED', retryAfterSeconds: retryAfter })
    }
    bucket.push(time)
    attempts.delete(key)
    attempts.set(key, bucket)
    for (const [candidate, timestamps] of attempts) {
      if (!timestamps.some((timestamp) => timestamp > time - windowMs)) attempts.delete(candidate)
    }
    while (attempts.size > maxKeys) attempts.delete(attempts.keys().next().value)
    response.set('RateLimit-Limit', String(limit))
    response.set('RateLimit-Remaining', String(Math.max(0, limit - bucket.length)))
    next()
  }
}

export function spotifyRetryAfterSeconds(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return 30
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.ceil(seconds))
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - now) / 1000)) : 30
}

function validatedSpotifyNext(value) {
  if (typeof value !== 'string' || !value) return ''
  try {
    const next = new URL(value, `${API_BASE}/`)
    return next.origin === 'https://api.spotify.com' && next.pathname.startsWith('/v1/') ? next.href : ''
  } catch { return '' }
}

export async function collectSpotifyPages(fetchPage, initialPath, { maxItems = MAX_IMPORT_ITEMS_PER_KIND } = {}) {
  const items = []
  let path = initialPath
  let truncated = false
  while (path && items.length < maxItems) {
    const page = await fetchPage(path)
    if (!Array.isArray(page?.items)) throw new Error('Spotify returned an invalid collection page.')
    const remaining = maxItems - items.length
    items.push(...page.items.slice(0, remaining))
    const next = validatedSpotifyNext(page.next)
    if (page.next && !next) throw new Error('Spotify returned an invalid pagination URL.')
    if (page.items.length > remaining || (items.length >= maxItems && next)) truncated = true
    path = items.length >= maxItems ? '' : next
  }
  return { items, truncated }
}

export async function persistSpotifyOAuthTokens(pool, { stateHash, expectedUserId, tokens, key }) {
  const client = await pool.connect()
  let inTransaction = false
  try {
    await client.query('BEGIN')
    inTransaction = true
    const consumed = await client.query('DELETE FROM spotify_oauth_states WHERE state_hash = $1 AND expires_at > NOW() RETURNING user_id', [stateHash])
    if (!consumed.rows[0] || consumed.rows[0].user_id !== expectedUserId) {
      await client.query('ROLLBACK')
      inTransaction = false
      return false
    }
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(' ').filter((scope) => SPOTIFY_SCOPES.includes(scope)) : []
    await client.query(`INSERT INTO spotify_connections (user_id, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, granted_scopes, needs_reauth)
      VALUES ($1, $2, $3, $4, $5, FALSE) ON CONFLICT (user_id) DO UPDATE SET access_token_ciphertext = EXCLUDED.access_token_ciphertext, refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext, access_token_expires_at = EXCLUDED.access_token_expires_at, granted_scopes = EXCLUDED.granted_scopes, needs_reauth = FALSE, updated_at = NOW()`, [expectedUserId, encryptSpotifyToken(tokens.access_token, key), encryptSpotifyToken(tokens.refresh_token, key), new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString(), scopes])
    await client.query('COMMIT')
    inTransaction = false
    return true
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export function spotifyConfiguration(environment = process.env) {
  const clientId = environment.SPOTIFY_CLIENT_ID?.trim() || ''
  const clientSecret = environment.SPOTIFY_CLIENT_SECRET?.trim() || ''
  const redirectUri = environment.SPOTIFY_REDIRECT_URI?.trim() || ''
  const encryptionSecret = environment.SPOTIFY_TOKEN_ENCRYPTION_KEY?.trim() || ''
  let parsedRedirect
  try { parsedRedirect = new URL(redirectUri) } catch { parsedRedirect = null }
  const validBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(encryptionSecret)
  const key = validBase64 ? Buffer.from(encryptionSecret, 'base64') : Buffer.alloc(0)
  const canonicalBase64 = validBase64 && key.toString('base64').replace(/=+$/, '') === encryptionSecret.replace(/=+$/, '')
  const safeRedirect = Boolean(parsedRedirect && !parsedRedirect.username && !parsedRedirect.password && ['http:', 'https:'].includes(parsedRedirect.protocol) && (parsedRedirect.protocol === 'https:' || parsedRedirect.hostname === '127.0.0.1'))
  const ready = Boolean(clientId && clientSecret && safeRedirect && canonicalBase64 && key.length === 32)
  return { ready, clientId, clientSecret, redirectUri, key: ready ? key : null }
}

export function encryptSpotifyToken(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof value !== 'string') throw new Error('Spotify encryption is not configured.')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}

export function decryptSpotifyToken(value, key) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof value !== 'string') throw new Error('Spotify encryption is not configured.')
  const [ivText, tagText, bodyText] = value.split('.')
  if (!ivText || !tagText || !bodyText) throw new Error('Stored Spotify credentials are invalid.')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(bodyText, 'base64url')), decipher.final()]).toString('utf8')
}

function cookieValue(request, name) {
  const prefix = `${name}=`
  const value = (request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length)
  try { return value ? decodeURIComponent(value) : '' } catch { return '' }
}

function safeFailure(response, code = 'SPOTIFY_UNAVAILABLE', status = 503) {
  return response.status(status).json({ error: 'Spotify connection could not be completed. Check the integration setup and try again.', code })
}

async function exchangeToken(form, config, fetchImpl) {
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
  const response = await fetchImpl(TOKEN_ENDPOINT, { method: 'POST', headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(form) })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error('Spotify token request failed.'), {
    code: payload.error === 'invalid_grant' ? 'SPOTIFY_INVALID_GRANT' : 'SPOTIFY_TOKEN_REQUEST_FAILED',
    status: response.status,
    retryAfterSeconds: response.status === 429 ? spotifyRetryAfterSeconds(response.headers?.get?.('retry-after')) : undefined,
    quotaLimited: payload?.error?.reason === 'QUOTA_EXCEEDED',
  })
  return payload
}

function spotifyUrl(value) {
  try { const parsed = new URL(value); return parsed.protocol === 'https:' && parsed.hostname === 'open.spotify.com' ? parsed.href : '' } catch { return '' }
}
function normalizeArtist(artist) { return { id: typeof artist?.id === 'string' ? artist.id : '', name: typeof artist?.name === 'string' ? artist.name.slice(0, 200) : '', spotifyUrl: spotifyUrl(artist?.external_urls?.spotify) } }
function normalizeTrack(track) {
  if (!track || typeof track.id !== 'string' || typeof track.name !== 'string') return null
  return { id: track.id, name: track.name.slice(0, 300), artists: (Array.isArray(track.artists) ? track.artists : []).map(normalizeArtist).filter((artist) => artist.name), albumName: typeof track.album?.name === 'string' ? track.album.name.slice(0, 200) : '', spotifyUrl: spotifyUrl(track.external_urls?.spotify) }
}
export function normalizePrivatePlaylist(playlist) {
  if (!playlist || playlist.public !== false || typeof playlist.id !== 'string' || typeof playlist.name !== 'string') return null
  return { id: playlist.id, name: playlist.name.slice(0, 300), description: typeof playlist.description === 'string' ? playlist.description.slice(0, 300) : '', spotifyUrl: spotifyUrl(playlist.external_urls?.spotify) }
}

export function createSpotifyRouter({ pool, authenticator = createNeonUserAuthenticator(), environment = process.env, fetchImpl = globalThis.fetch, clientOrigins = [] }) {
  const router = Router()
  const config = () => spotifyConfiguration(environment)
  const clientOrigin = clientOrigins[0] || 'http://localhost:5173'
  const secureCookie = environment.NODE_ENV === 'production'
  const storageRequired = (_request, response, next) => pool ? next() : safeFailure(response, 'MUSIC_STORAGE_UNAVAILABLE')
  const limitConnectStarts = createSpotifyRateLimiter({ limit: 10, windowMs: 60 * 60 * 1000 })
  const limitSyncs = createSpotifyRateLimiter({ limit: 6, windowMs: 60 * 60 * 1000 })

  async function accessTokenFor(userId) {
    if (refreshes.has(userId)) return refreshes.get(userId)
    const task = (async () => {
      const activeConfig = config()
      if (!activeConfig.ready) throw new Error('Spotify integration is not configured.')
      const client = await pool.connect()
      let inTransaction = false
      try {
        await client.query('BEGIN'); inTransaction = true
        const result = await client.query('SELECT access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at, needs_reauth FROM spotify_connections WHERE user_id = $1 FOR UPDATE', [userId])
        const connection = result.rows[0]
        if (!connection || connection.needs_reauth) throw Object.assign(new Error('Spotify authorization is required.'), { code: 'SPOTIFY_REAUTH_REQUIRED' })
        if (new Date(connection.access_token_expires_at).getTime() > Date.now() + 60_000) {
          const accessToken = decryptSpotifyToken(connection.access_token_ciphertext, activeConfig.key)
          await client.query('COMMIT'); inTransaction = false
          return accessToken
        }
        const refreshToken = decryptSpotifyToken(connection.refresh_token_ciphertext, activeConfig.key)
        let tokens
        try { tokens = await exchangeToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, activeConfig, fetchImpl) }
        catch (error) {
          if (error.code === 'SPOTIFY_INVALID_GRANT') {
            await client.query("UPDATE spotify_connections SET access_token_ciphertext = '', refresh_token_ciphertext = '', needs_reauth = TRUE, updated_at = NOW() WHERE user_id = $1", [userId])
            await client.query('COMMIT'); inTransaction = false
            throw Object.assign(new Error('Spotify authorization must be renewed.'), { code: 'SPOTIFY_REAUTH_REQUIRED' })
          }
          throw error
        }
        if (typeof tokens.access_token !== 'string' || !Number.isFinite(Number(tokens.expires_in))) throw new Error('Spotify refresh response was incomplete.')
        const nextRefresh = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : refreshToken
        await client.query('UPDATE spotify_connections SET access_token_ciphertext = $2, refresh_token_ciphertext = $3, access_token_expires_at = $4, needs_reauth = FALSE, updated_at = NOW() WHERE user_id = $1', [userId, encryptSpotifyToken(tokens.access_token, activeConfig.key), encryptSpotifyToken(nextRefresh, activeConfig.key), new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()])
        await client.query('COMMIT'); inTransaction = false
        return tokens.access_token
      } catch (error) {
        if (inTransaction) await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally { client.release() }
    })().finally(() => refreshes.delete(userId))
    refreshes.set(userId, task)
    return task
  }

  async function spotifyGet(token, path) {
    const url = new URL(typeof path === 'string' && /^https:\/\//i.test(path) ? path : `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`)
    if (url.origin !== 'https://api.spotify.com' || !url.pathname.startsWith('/v1/')) throw new Error('Spotify pagination returned an invalid URL.')
    const response = await fetchImpl(url.href, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw Object.assign(new Error('Spotify data request failed.'), {
        status: response.status,
        retryAfterSeconds: response.status === 429 ? spotifyRetryAfterSeconds(response.headers?.get?.('retry-after')) : undefined,
        quotaLimited: payload?.error?.reason === 'QUOTA_EXCEEDED',
      })
    }
    return payload
  }

  router.get('/status', authenticator, storageRequired, async (request, response, next) => {
    try {
      const result = await pool.query('SELECT needs_reauth, connected_at, granted_scopes FROM spotify_connections WHERE user_id = $1', [request.musicUserId])
      const row = result.rows[0]
      response.set('Cache-Control', 'no-store').json({ configured: config().ready, connected: Boolean(row), needsReauth: Boolean(row?.needs_reauth), connectedAt: row?.connected_at?.toISOString?.() ?? null, scopes: row?.granted_scopes ?? [] })
    } catch (error) { next(error) }
  })

  router.post('/connect/start', authenticator, limitConnectStarts, async (request, response, next) => {
    const activeConfig = config()
    if (!activeConfig.ready) return safeFailure(response, 'SPOTIFY_NOT_CONFIGURED')
    try {
      if (!pool) return safeFailure(response, 'MUSIC_STORAGE_UNAVAILABLE')
      const state = randomBytes(32).toString('base64url')
      await pool.query('DELETE FROM spotify_oauth_states WHERE expires_at <= NOW()')
      await pool.query('INSERT INTO spotify_oauth_states (state_hash, user_id, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'10 minutes\')', [hashOAuthState(state), request.musicUserId])
      response.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/api/spotify/callback', maxAge: 10 * 60 * 1000 })
      const authorizeUrl = new URL('https://accounts.spotify.com/authorize')
      authorizeUrl.search = new URLSearchParams({ response_type: 'code', client_id: activeConfig.clientId, redirect_uri: activeConfig.redirectUri, scope: SPOTIFY_SCOPES.join(' '), state }).toString()
      response.set('Cache-Control', 'no-store').json({ authorizationUrl: authorizeUrl.href })
    } catch (error) {
      if (error?.code === '42P01' || error?.code === '42703') return response.status(503).json({ error: 'Spotify Connect is not ready because database migrations 0001–0004 have not all been applied.', code: 'MUSIC_MIGRATION_REQUIRED' })
      return next(error)
    }
  })

  router.get('/callback', storageRequired, async (request, response) => {
    const clearCookie = () => response.clearCookie(OAUTH_STATE_COOKIE, { httpOnly: true, secure: secureCookie, sameSite: 'lax', path: '/api/spotify/callback' })
    const state = typeof request.query.state === 'string' ? request.query.state : ''
    const cookieState = cookieValue(request, OAUTH_STATE_COOKIE)
    if (!state || !safeStateMatch(state, cookieState)) { clearCookie(); return response.redirect(303, `${clientOrigin}/?spotify=state-error`) }
    const stateHash = hashOAuthState(state)
    try {
      const pending = await pool.query('SELECT user_id FROM spotify_oauth_states WHERE state_hash = $1 AND expires_at > NOW()', [stateHash])
      const userId = pending.rows[0]?.user_id
      if (!userId) { clearCookie(); return response.redirect(303, `${clientOrigin}/?spotify=state-error`) }
      if (request.query.error || typeof request.query.code !== 'string') {
        await pool.query('DELETE FROM spotify_oauth_states WHERE state_hash = $1', [stateHash])
        clearCookie(); return response.redirect(303, `${clientOrigin}/?spotify=cancelled`)
      }
      const activeConfig = config()
      if (!activeConfig.ready) {
        await pool.query('DELETE FROM spotify_oauth_states WHERE state_hash = $1', [stateHash])
        clearCookie(); return response.redirect(303, `${clientOrigin}/?spotify=setup-required`)
      }
      const tokens = await exchangeToken({ grant_type: 'authorization_code', code: request.query.code, redirect_uri: activeConfig.redirectUri }, activeConfig, fetchImpl)
      if (typeof tokens.refresh_token !== 'string' || typeof tokens.access_token !== 'string') throw new Error('Spotify token response was incomplete.')
      if (!Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0) throw new Error('Spotify token response was incomplete.')
      const saved = await persistSpotifyOAuthTokens(pool, { stateHash, expectedUserId: userId, tokens, key: activeConfig.key })
      if (!saved) { clearCookie(); return response.redirect(303, `${clientOrigin}/?spotify=state-error`) }
      clearCookie()
      return response.redirect(303, `${clientOrigin}/?spotify=connected`)
    } catch {
      await pool.query('DELETE FROM spotify_oauth_states WHERE state_hash = $1', [stateHash]).catch(() => {})
      clearCookie()
      return response.redirect(303, `${clientOrigin}/?spotify=error`)
    }
  })

  router.post('/sync', authenticator, storageRequired, limitSyncs, async (request, response) => {
    if (!config().ready) return safeFailure(response, 'SPOTIFY_NOT_CONFIGURED')
    try {
      const token = await accessTokenFor(request.musicUserId)
      const requests = await Promise.allSettled([
        collectSpotifyPages((path) => spotifyGet(token, path), `/me/top/artists?limit=${IMPORT_PAGE_SIZE}&time_range=medium_term`),
        collectSpotifyPages((path) => spotifyGet(token, path), `/me/top/tracks?limit=${IMPORT_PAGE_SIZE}&time_range=medium_term`),
        collectSpotifyPages((path) => spotifyGet(token, path), `/me/player/recently-played?limit=${IMPORT_PAGE_SIZE}`),
        collectSpotifyPages((path) => spotifyGet(token, path), `/me/tracks?limit=${IMPORT_PAGE_SIZE}`),
        collectSpotifyPages((path) => spotifyGet(token, path), `/me/playlists?limit=${IMPORT_PAGE_SIZE}`),
      ])
      if (requests.some((result) => result.status === 'rejected' && result.reason?.status === 401)) {
        await pool.query("UPDATE spotify_connections SET access_token_ciphertext = '', refresh_token_ciphertext = '', needs_reauth = TRUE, updated_at = NOW() WHERE user_id = $1", [request.musicUserId])
        return safeFailure(response, 'SPOTIFY_REAUTH_REQUIRED', 401)
      }
      const kinds = ['top_artist', 'top_track', 'recent_track', 'saved_track', 'private_playlist']
      const imported = []
      const failures = []
      const succeededKinds = []
      const truncatedCategories = []
      requests.forEach((result, index) => {
        if (result.status !== 'fulfilled') { failures.push(kinds[index]); return }
        succeededKinds.push(kinds[index])
        if (result.value.truncated) truncatedCategories.push(kinds[index])
        const list = result.value.items
        for (const raw of list) {
          let item; let id; let observedAt = null
          if (index === 0) { id = raw?.id; item = { id, name: typeof raw?.name === 'string' ? raw.name.slice(0, 200) : '', spotifyUrl: spotifyUrl(raw?.external_urls?.spotify) } }
          else if (index === 1) { item = normalizeTrack(raw); id = item?.id }
          else if (index === 2) { item = normalizeTrack(raw?.track); id = item?.id; observedAt = typeof raw?.played_at === 'string' ? raw.played_at : null }
          else if (index === 3) { item = normalizeTrack(raw?.track); id = item?.id }
          else { item = normalizePrivatePlaylist(raw); id = item?.id }
          if (typeof id === 'string' && id && item && item.spotifyUrl) imported.push({ kind: kinds[index], id, observedAt, data: item })
        }
      })
      if (!imported.length && failures.length === requests.length) {
        const rateLimited = requests.filter((result) => result.status === 'rejected' && result.reason?.status === 429)
        if (rateLimited.length) {
          const retryAfter = Math.max(...rateLimited.map((result) => result.reason.retryAfterSeconds || 30))
          response.set('Retry-After', String(retryAfter))
          return response.status(429).json({ error: 'Spotify is rate limiting imports. Please wait before trying again.', code: 'SPOTIFY_RATE_LIMITED', retryAfterSeconds: retryAfter, quotaLimited: rateLimited.some((result) => result.reason.quotaLimited) })
        }
        return safeFailure(response, 'SPOTIFY_IMPORT_FAILED', 502)
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const activeConnection = await client.query('SELECT user_id FROM spotify_connections WHERE user_id = $1 FOR UPDATE', [request.musicUserId])
        if (!activeConnection.rows[0]) {
          await client.query('ROLLBACK')
          return safeFailure(response, 'SPOTIFY_REAUTH_REQUIRED', 401)
        }
        await client.query('DELETE FROM spotify_imported_items WHERE user_id = $1 AND kind = ANY($2::varchar[])', [request.musicUserId, succeededKinds])
        for (const item of imported) {
          await client.query('INSERT INTO spotify_imported_items (user_id, kind, provider_item_id, observed_at, data) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [request.musicUserId, item.kind, item.id, item.observedAt, JSON.stringify(item.data)])
        }
        const history = await client.query('SELECT video_id, title, channel_name, source, played_at FROM jammy_listening_history WHERE user_id = $1 ORDER BY played_at DESC LIMIT 250', [request.musicUserId])
        const taste = buildMusicTasteProfile({ jammyHistory: history.rows.map((row) => ({ videoId: row.video_id, title: row.title, channelName: row.channel_name, artist: row.channel_name })) })
        await client.query('INSERT INTO music_taste_profiles (user_id, profile_json) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET profile_json = EXCLUDED.profile_json, updated_at = NOW()', [request.musicUserId, JSON.stringify(taste)])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      const rateLimited = requests.filter((result) => result.status === 'rejected' && result.reason?.status === 429)
      const retryAfter = rateLimited.length ? Math.max(...rateLimited.map((result) => result.reason.retryAfterSeconds || 30)) : null
      if (retryAfter) response.set('Retry-After', String(retryAfter))
      response.set('Cache-Control', 'no-store').json({ imported: imported.length, partial: failures.length > 0, unavailableSources: failures, truncatedCategories, ...(retryAfter ? { retryAfterSeconds: retryAfter, quotaLimited: rateLimited.some((result) => result.reason.quotaLimited) } : {}) })
    } catch (error) {
      if (error?.code === 'SPOTIFY_REAUTH_REQUIRED') return safeFailure(response, error.code, 401)
      if (error?.status === 401) { await pool.query("UPDATE spotify_connections SET access_token_ciphertext = '', refresh_token_ciphertext = '', needs_reauth = TRUE, updated_at = NOW() WHERE user_id = $1", [request.musicUserId]).catch(() => {}); return safeFailure(response, 'SPOTIFY_REAUTH_REQUIRED', 401) }
      if (error?.status === 429) {
        const retryAfter = error.retryAfterSeconds || 30
        response.set('Retry-After', String(retryAfter))
        return response.status(429).json({ error: 'Spotify is rate limiting imports. Please wait before trying again.', code: 'SPOTIFY_RATE_LIMITED', retryAfterSeconds: retryAfter, quotaLimited: Boolean(error.quotaLimited) })
      }
      return safeFailure(response, 'SPOTIFY_IMPORT_FAILED', 502)
    }
  })

  router.delete('/connection', authenticator, storageRequired, async (request, response, next) => {
    try {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query('DELETE FROM spotify_oauth_states WHERE user_id = $1', [request.musicUserId])
        await client.query('DELETE FROM spotify_connections WHERE user_id = $1', [request.musicUserId])
        await client.query('DELETE FROM spotify_imported_items WHERE user_id = $1', [request.musicUserId])
        const history = await client.query('SELECT video_id, title, channel_name, played_at FROM jammy_listening_history WHERE user_id = $1 ORDER BY played_at DESC LIMIT 250', [request.musicUserId])
        const taste = buildMusicTasteProfile({ jammyHistory: history.rows.map((row) => ({ videoId: row.video_id, title: row.title, channelName: row.channel_name })) })
        await client.query('INSERT INTO music_taste_profiles (user_id, profile_json) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET profile_json = EXCLUDED.profile_json, updated_at = NOW()', [request.musicUserId, JSON.stringify(taste)])
        await client.query('COMMIT')
      } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
      response.json({ disconnected: true, spotifyRevocation: 'Use your Spotify account settings to remove Jammy access.' })
    } catch (error) { next(error) }
  })
  return router
}

export { SPOTIFY_SCOPES }
