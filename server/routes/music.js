import { Router } from 'express'
import { createHash, timingSafeEqual } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { isYouTubeVideoId } from '../services/youtubeService.js'
import { buildMusicTasteProfile, personalizedYouTubeQuery } from '../services/musicTaste.js'

const remoteKeys = new Map()

export class NeonAuthConfigurationError extends Error {}

function issuerOrigin(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return undefined
  try { return new URL(baseUrl).origin } catch { throw new NeonAuthConfigurationError('Neon Auth base URL is invalid.') }
}

export function validateNeonAuthVerifierConfig(options = {}) {
  const jwksUrl = options.jwksUrl ?? process.env.NEON_AUTH_JWKS_URL
  const audience = options.audience ?? process.env.NEON_AUTH_AUDIENCE
  const configuredIssuer = options.issuer ?? process.env.NEON_AUTH_ISSUER
  // Neon Managed Auth's JWT `iss` is the origin of its Auth URL, while the
  // JWKS endpoint includes the database/auth path. Do not compare `iss` to
  // the full `/neondb/auth` service URL.
  const issuer = typeof configuredIssuer === 'string' && configuredIssuer.trim()
    ? configuredIssuer.trim()
    : issuerOrigin(options.authBaseUrl ?? process.env.NEON_AUTH_BASE_URL)
  let parsed
  try { parsed = new URL(jwksUrl || '') } catch { throw new NeonAuthConfigurationError('Neon Auth JWKS URL is not configured correctly.') }
  if ((parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) || !parsed.pathname || parsed.username || parsed.password) {
    throw new NeonAuthConfigurationError('Neon Auth JWKS must use a credential-free HTTPS URL.')
  }
  if (issuer) {
    let parsedIssuer
    try { parsedIssuer = new URL(issuer) } catch { throw new NeonAuthConfigurationError('Neon Auth issuer configuration is invalid.') }
    if ((parsedIssuer.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsedIssuer.hostname)) || parsedIssuer.username || parsedIssuer.password) {
      throw new NeonAuthConfigurationError('Neon Auth issuer must use a credential-free HTTPS URL.')
    }
  } else throw new NeonAuthConfigurationError('Neon Auth issuer is not configured.')
  if (audience !== undefined && (typeof audience !== 'string' || !audience.trim() || audience.length > 200)) {
    throw new NeonAuthConfigurationError('Neon Auth audience configuration is invalid.')
  }
  return { jwksUrl: parsed.href, issuer: issuer || undefined, audience: audience?.trim() || undefined }
}

export async function verifyNeonBearerToken(token, options = {}) {
  const configuration = validateNeonAuthVerifierConfig(options)
  const parsed = new URL(configuration.jwksUrl)
  let keySet = remoteKeys.get(configuration.jwksUrl)
  if (!keySet) { keySet = createRemoteJWKSet(parsed); remoteKeys.set(configuration.jwksUrl, keySet) }
  const verifyOptions = { algorithms: ['EdDSA'] }
  if (configuration.issuer) verifyOptions.issuer = configuration.issuer
  if (configuration.audience) verifyOptions.audience = configuration.audience
  const { payload } = await jwtVerify(token, keySet, verifyOptions)
  if (typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 200) throw new Error('Invalid subject')
  return payload.sub
}

// Keep the response useful without echoing a JWT, its claims, or verifier
// configuration. This also prevents an issuer/key mismatch from being
// presented to users as an expired login session.
export function classifyNeonTokenFailure(error) {
  if (error instanceof NeonAuthConfigurationError || error instanceof TypeError || error?.code === 'ERR_JWKS_TIMEOUT' || error?.code === 'ERR_JWKS_INVALID') {
    return { status: 503, code: 'AUTH_TOKEN_VERIFIER_UNAVAILABLE' }
  }
  if (error?.code === 'ERR_JWT_EXPIRED') return { status: 401, code: 'AUTH_SESSION_EXPIRED' }
  if (error?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && error?.claim === 'iss') return { status: 503, code: 'AUTH_TOKEN_ISSUER_MISMATCH' }
  if (error?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && error?.claim === 'aud') return { status: 503, code: 'AUTH_TOKEN_AUDIENCE_MISMATCH' }
  if (error?.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || error?.code === 'ERR_JWKS_NO_MATCHING_KEY') return { status: 503, code: 'AUTH_TOKEN_SIGNING_KEY_MISMATCH' }
  return { status: 401, code: 'AUTH_SESSION_INVALID' }
}

export function createNeonUserAuthenticator(options = {}) {
  return async function requireNeonUser(request, response, next) {
    const authorization = request.get('authorization') || ''
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization)
    if (!match) return response.status(401).json({ error: 'Sign in to continue.', code: 'AUTH_REQUIRED' })
    try {
      request.musicUserId = await verifyNeonBearerToken(match[1], options)
      return next()
    } catch (error) {
      const failure = classifyNeonTokenFailure(error)
      if (failure.status === 503) return response.status(failure.status).json({ error: 'Jammy could not verify the Neon Auth token because the verifier or branch configuration is unavailable. Contact the app operator or try again shortly.', code: failure.code })
      return response.status(failure.status).json({ error: 'Your Neon Auth session has expired or is invalid. Refresh the page and sign in again if needed.', code: failure.code })
    }
  }
}

function safeString(value, max) { return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ').slice(0, max) : '' }

export function createMusicRouter({ pool, youtubeService, authenticator = createNeonUserAuthenticator() }) {
  const router = Router()
  const unavailable = (response) => response.status(503).json({ error: 'Personal music storage is not available. Configure PostgreSQL and apply the additive personal music migration.', code: 'MUSIC_STORAGE_UNAVAILABLE' })
  const schemaUnavailable = (response) => response.status(503).json({ error: 'Jammy listening history is not ready because database migrations 0001–0004 have not all been applied.', code: 'MUSIC_MIGRATION_REQUIRED' })
  const handleDatabaseError = (error, response, next) => {
    if (error?.code === '42P01' || error?.code === '42703') return schemaUnavailable(response)
    return next(error)
  }
  router.use(authenticator)
  router.get('/home', async (request, response, next) => {
    if (!pool) return unavailable(response)
    try {
      await pool.query("DELETE FROM spotify_imported_items WHERE user_id = $1 AND imported_at <= NOW() - INTERVAL '30 days'", [request.musicUserId])
      const [history, connection, items] = await Promise.all([
        pool.query('SELECT id, video_id, title, channel_name, source, played_at FROM jammy_listening_history WHERE user_id = $1 ORDER BY played_at DESC LIMIT 50', [request.musicUserId]),
        pool.query('SELECT needs_reauth, connected_at FROM spotify_connections WHERE user_id = $1', [request.musicUserId]),
        pool.query('SELECT kind, provider_item_id, observed_at, data FROM spotify_imported_items WHERE user_id = $1 ORDER BY imported_at DESC LIMIT 250', [request.musicUserId]),
      ])
      const jammyHistory = history.rows.map((row) => ({ id: row.id, videoId: row.video_id, trackId: `youtube:${row.video_id}`, title: row.title, channelName: row.channel_name, artist: row.channel_name, source: row.source, playedAt: row.played_at.toISOString(), track: { id: `youtube:${row.video_id}`, provider: 'youtube', videoId: row.video_id, title: row.title, channelName: row.channel_name, artist: row.channel_name } }))
      const spotifyItems = items.rows.map((row) => ({ kind: row.kind, id: row.provider_item_id, observedAt: row.observed_at?.toISOString?.() ?? null, ...row.data }))
      const taste = buildMusicTasteProfile({ jammyHistory })
      await pool.query('INSERT INTO music_taste_profiles (user_id, profile_json) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET profile_json = EXCLUDED.profile_json, updated_at = NOW()', [request.musicUserId, JSON.stringify(taste)])
      response.set('Cache-Control', 'no-store').json({ history: jammyHistory, spotify: { connected: Boolean(connection.rows[0]), needsReauth: Boolean(connection.rows[0]?.needs_reauth), connectedAt: connection.rows[0]?.connected_at?.toISOString?.() ?? null, items: spotifyItems }, taste })
    } catch (error) { handleDatabaseError(error, response, next) }
  })
  router.post('/history', async (request, response, next) => {
    if (!pool) return unavailable(response)
    const eventId = safeString(request.body?.eventId, 120)
    const videoId = safeString(request.body?.videoId, 11)
    const title = safeString(request.body?.title, 500)
    const channelName = safeString(request.body?.channelName, 200)
    const source = request.body?.source
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(eventId) || !isYouTubeVideoId(videoId) || !title || !['standalone', 'room'].includes(source)) return response.status(400).json({ error: 'A valid YouTube playback event is required.', code: 'MUSIC_EVENT_INVALID' })
    try {
      await pool.query('INSERT INTO jammy_listening_history (user_id, event_id, video_id, title, channel_name, source) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (user_id, event_id) DO NOTHING', [request.musicUserId, eventId, videoId, title, channelName, source])
      response.status(202).json({ saved: true })
    } catch (error) { handleDatabaseError(error, response, next) }
  })
  router.get('/taste', async (request, response, next) => {
    if (!pool) return unavailable(response)
    try {
      const result = await pool.query('SELECT profile_json FROM music_taste_profiles WHERE user_id = $1', [request.musicUserId])
      response.set('Cache-Control', 'no-store').json({ profile: result.rows[0]?.profile_json ?? buildMusicTasteProfile() })
    } catch (error) { handleDatabaseError(error, response, next) }
  })
  router.get('/youtube-search', async (request, response, next) => {
    try {
      const rawQuery = typeof request.query.q === 'string' ? request.query.q : ''
      let profileResult = { rows: [] }
      if (pool) {
        try { profileResult = await pool.query('SELECT profile_json FROM music_taste_profiles WHERE user_id = $1', [request.musicUserId]) }
        catch { /* Account taste storage or migration may be unavailable; preserve generic YouTube search. */ }
      }
      const query = personalizedYouTubeQuery(rawQuery, profileResult.rows[0]?.profile_json)
      const results = await youtubeService.search(query)
      response.set('Cache-Control', 'no-store').json({ results, personalized: Boolean(profileResult.rows[0]?.profile_json?.favoriteArtists?.length) })
    } catch (error) { next(error) }
  })
  return router
}

export function hashOAuthState(state) { return createHash('sha256').update(state).digest('hex') }

export function safeStateMatch(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const a = Buffer.from(left); const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
